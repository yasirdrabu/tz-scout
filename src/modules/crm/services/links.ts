import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { deal, handoff, link } from '../db/schema';

export type LinkRow = { scoutType: string; scoutId: string; system: string; externalId: string; fingerprint: string | null; lastSyncedAt: Date };

export type RecordLink = { scoutType: string; scoutId: string; system: string; externalId: string; fingerprint?: string };

/**
 * Upserts one link in its own transaction (Ruling 3), so a push that fails and rolls back still leaves the
 * links for what it wrote, and a retry finds them. A given fingerprint replaces the stored one.
 */
export async function recordLink(ctx: ModuleContext, input: RecordLink): Promise<void> {
  const now = new Date();
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .insert(link)
      .values({ id: newId('lnk'), tenantId: ctx.tenantId, ...input, fingerprint: input.fingerprint ?? null, lastSyncedAt: now })
      .onConflictDoUpdate({
        target: [link.tenantId, link.system, link.scoutType, link.scoutId, link.externalId],
        set: { lastSyncedAt: now, ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}) },
      }),
  );
}

export type AccountLinks = {
  /** The earliest company link, or null. */
  company: LinkRow | null;
  people: LinkRow[];
  note: LinkRow | null;
  tasks: LinkRow[];
  deals: LinkRow[];
  /** Two company links: a person has to say which one is right (CRM-E7-S1). */
  conflict: boolean;
};

const toRow = (r: typeof link.$inferSelect): LinkRow => ({
  scoutType: r.scoutType,
  scoutId: r.scoutId,
  system: r.system,
  externalId: r.externalId,
  fingerprint: r.fingerprint,
  lastSyncedAt: r.lastSyncedAt,
});

/** Everything the CRM holds for an account: its company, people, context note, task and deal links. */
export async function getLinks(ctx: ModuleContext, accountId: string): Promise<AccountLinks> {
  const account = await getAccount(ctx, accountId);
  const personIds = account?.people.map((p) => p.id) ?? [];
  const handoffs = await ctx.tx.select({ assignmentId: handoff.assignmentId }).from(handoff).where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, accountId)));
  const deals = await ctx.tx.select({ id: deal.id }).from(deal).where(and(eq(deal.tenantId, ctx.tenantId), eq(deal.accountId, accountId)));

  const scoped = [
    and(inArray(link.scoutType, ['account', 'note']), eq(link.scoutId, accountId)),
    personIds.length ? and(eq(link.scoutType, 'person'), inArray(link.scoutId, personIds)) : undefined,
    ...handoffs.map((h) => and(eq(link.scoutType, 'task'), sql`left(${link.scoutId}, ${h.assignmentId.length + 1}) = ${h.assignmentId + ':'}`)),
    deals.length ? and(eq(link.scoutType, 'deal'), inArray(link.scoutId, deals.map((d) => d.id))) : undefined,
  ].filter((c) => c !== undefined);
  const rows = (await ctx.tx.select().from(link).where(and(eq(link.tenantId, ctx.tenantId), or(...scoped)))).sort(
    (a, b) => a.lastSyncedAt.getTime() - b.lastSyncedAt.getTime() || a.id.localeCompare(b.id),
  );

  const ofType = (type: string) => rows.filter((r) => r.scoutType === type).map(toRow);
  const companies = ofType('account');
  const notes = ofType('note');
  return {
    company: companies[0] ?? null,
    people: ofType('person'),
    note: notes[notes.length - 1] ?? null,
    tasks: ofType('task'),
    deals: ofType('deal'),
    conflict: hasTwoInOneSystem(companies),
  };
}

function hasTwoInOneSystem(companies: LinkRow[]): boolean {
  const seen = new Map<string, Set<string>>();
  for (const c of companies) seen.set(c.system, (seen.get(c.system) ?? new Set()).add(c.externalId));
  return [...seen.values()].some((ids) => ids.size > 1);
}

/** The external id of the account's company in `system`, or null. */
export async function companyLink(ctx: ModuleContext, accountId: string, system: string): Promise<string | null> {
  const rows = await ctx.tx
    .select({ externalId: link.externalId })
    .from(link)
    .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'account'), eq(link.scoutId, accountId), eq(link.system, system)))
    .orderBy(link.lastSyncedAt, link.id)
    .limit(1);
  return rows[0]?.externalId ?? null;
}

/**
 * Links an account (or one of its people) to the CRM ids that arrived with it (CRM-E6-S2). The consumers on
 * the accounts events that carry `externalIds` are wired in Task 15.
 */
export async function linkExternalIds(
  ctx: ModuleContext,
  input: { accountId: string; personId?: string; externalIds: { system: string; id: string }[] },
): Promise<void> {
  for (const e of input.externalIds) {
    await recordLink(ctx, {
      scoutType: input.personId ? 'person' : 'account',
      scoutId: input.personId ?? input.accountId,
      system: e.system,
      externalId: e.id,
    });
  }
}
