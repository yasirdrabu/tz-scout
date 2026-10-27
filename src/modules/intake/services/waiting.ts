import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob } from '@/platform/events/outbox';
import { resolveJob } from '../contracts/jobs';
import { arrival } from '../db/schema';
import { normaliseDomain } from '../domain/normalise';
import type { ResolutionInput, WaitingOn } from '../domain/normalise-arrival';
import { rejectArrival } from './resolve';
import { toViews, type ArrivalView } from './status';
import { findArrival, pageArrivals } from './visibility';

type ArrivalRow = typeof arrival.$inferSelect;

const WAITING_DAYS = 30;
const EXPIRY_DETAIL: Record<WaitingOn, string> = {
  needs_website: 'Nobody supplied the missing website within 30 days',
  needs_company: 'Nobody supplied the company within 30 days',
  possible_duplicate: 'Nobody decided whether this was a duplicate within 30 days',
};

const waitingNow = and(eq(arrival.status, 'resolving'), isNotNull(arrival.waitingOn));
const staleNow = and(waitingNow, lt(arrival.waitingSince, sql`now() - make_interval(days => ${WAITING_DAYS})`));
const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title });

/** Arrivals waiting for a person, newest first, optionally for one reason. */
export async function listWaiting(
  ctx: ModuleContext,
  f: { reason?: WaitingOn; cursor?: string; limit?: number } = {},
): Promise<{ data: ArrivalView[]; nextCursor: string | null }> {
  const page = await pageArrivals(ctx, {
    where: [waitingNow, f.reason ? eq(arrival.waitingOn, f.reason) : undefined],
    cursor: f.cursor,
    limit: f.limit,
  });
  return { data: await toViews(ctx, page.data), nextCursor: page.nextCursor };
}

/**
 * SRC-E3-S3: stores the answer on the arrival, audits it and queues a resolve job, which re-runs
 * from step 2 with the answer applied. Answers add up: a company name first and its website later.
 */
async function resume(
  ctx: ModuleContext,
  arrivalId: string,
  action: string,
  reasons: WaitingOn[],
  input: (row: ArrivalRow) => ResolutionInput | Promise<ResolutionInput>,
): Promise<void> {
  if (!(await findArrival(ctx, arrivalId))) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That arrival was not found.' });
  // Locked, so two answers add up and expiry can't reject an arrival that was just answered.
  const [row] = await ctx.tx
    .select()
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, arrivalId)))
    .for('update');
  if (!row?.waitingOn || row.status !== 'resolving' || !reasons.includes(row.waitingOn as WaitingOn)) {
    throw new ScoutError({ slug: 'conflict', status: 409, title: 'That arrival is not waiting for this.' });
  }
  const answer = await input(row);
  await ctx.tx
    .update(arrival)
    .set({ resolutionInput: { ...(row.resolutionInput as ResolutionInput | null), ...answer }, waitingSince: new Date() })
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, arrivalId)));
  await audit(ctx, { action, subject: { type: 'arrival', id: arrivalId }, before: { waitingOn: row.waitingOn }, after: answer });
  await enqueueJob(ctx, resolveJob, { arrivalId });
}

export function supplyWebsite(ctx: ModuleContext, arrivalId: string, website: string): Promise<void> {
  return resume(ctx, arrivalId, 'intake.arrival.supply_website', ['needs_website', 'needs_company'], () => {
    if (!normaliseDomain(website)) throw invalid('Enter a website address like acme.com.');
    return { website: website.trim() };
  });
}

/**
 * The company's name (and website), or "sole proprietor". A sole proprietor has no company name, so a
 * person who came without a name needs `personName`; without one the arrival keeps waiting.
 */
export function supplyCompany(
  ctx: ModuleContext,
  arrivalId: string,
  company: { name: string; website?: string } | { soleProprietor: true; personName?: string },
): Promise<void> {
  return resume(ctx, arrivalId, 'intake.arrival.supply_company', ['needs_website', 'needs_company'], () => {
    if ('soleProprietor' in company) {
      const personName = company.personName?.trim();
      return { soleProprietor: true, ...(personName ? { personName } : {}) };
    }
    const name = company.name.trim();
    if (!name) throw invalid('Enter the company name.');
    const website = company.website?.trim();
    if (website && !normaliseDomain(website)) throw invalid('Enter a website address like acme.com.');
    return { company: { name, ...(website ? { website } : {}) } };
  });
}

/** SRC-E3-S2-AC4: `same_as` one of the candidates attaches the arrival; `new_company` creates the account. */
export function chooseDuplicate(
  ctx: ModuleContext,
  arrivalId: string,
  choice: { kind: 'same_as'; accountId: string } | { kind: 'new_company' },
): Promise<void> {
  return resume(ctx, arrivalId, 'intake.arrival.choose_duplicate', ['possible_duplicate'], async (row) => {
    if (choice.kind === 'same_as') {
      const candidates = (row.duplicateCandidates as { accountId: string }[] | null) ?? [];
      if (!candidates.some((c) => c.accountId === choice.accountId)) throw invalid('Choose one of the accounts Scout found.');
      if ((await filterVisibleAccountIds(ctx, [choice.accountId])).length === 0) {
        throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
      }
    }
    return { duplicate: choice };
  });
}

/** Rejects every waiting item of a batch `invalid`. Returns how many were skipped. */
export async function skipWaiting(ctx: ModuleContext, batchId: string, by: string): Promise<number> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await pageArrivals(ctx, { where: [waitingNow, eq(arrival.batchId, batchId)], cursor, limit: 200 });
    ids.push(...page.data.map((r) => r.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  for (const id of ids) {
    await rejectArrival(ctx, id, 'invalid', `Skipped by ${by}.`);
    await audit(ctx, { action: 'intake.arrival.skip', subject: { type: 'arrival', id }, after: { batchId } });
  }
  return ids.length;
}

/** SRC-E3-S3-AC3: rejects arrivals that have waited more than 30 days, with a reason that says why. */
export async function expireWaiting(ctx: ModuleContext): Promise<number> {
  const stale = await ctx.tx
    .select({ id: arrival.id, waitingOn: arrival.waitingOn })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), staleNow))
    .orderBy(arrival.waitingSince);
  let expired = 0;
  for (const s of stale) {
    // Locked and re-checked: an answer that arrived since the list was read refreshed `waiting_since`.
    const [still] = await ctx.tx
      .select({ waitingOn: arrival.waitingOn })
      .from(arrival)
      .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, s.id), staleNow))
      .for('update');
    if (!still) continue;
    await rejectArrival(ctx, s.id, 'invalid', EXPIRY_DETAIL[still.waitingOn as WaitingOn]);
    expired++;
  }
  return expired;
}
