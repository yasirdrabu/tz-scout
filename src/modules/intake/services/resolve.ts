import { and, eq, ne, sql } from 'drizzle-orm';
import {
  checkExclusion,
  findMatches,
  getAccounts,
  matchName,
  trigramSimilarity,
  upsertFromArrival,
  type ArrivalForAccounts,
  type Exclusion,
  type SourceChain,
} from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { ArrivalV1Schema, moveItemFields, type ArrivalV1 } from '../contracts/arrival';
import { arrivalRejected, arrivalResolved, arrivalWaiting, batchCompleted } from '../contracts/events';
import { arrival, batch } from '../db/schema';
import {
  defined,
  lockKeyOf,
  normaliseArrival,
  revive,
  shellEmail,
  unmapped,
  waitingFor,
  withInput,
  type Normalised,
  type ResolutionInput,
  type WaitingOn,
} from '../domain/normalise-arrival';
import { normaliseWithAi } from '../tasks/arrival-normalise';
import { DEFAULT_REVIEW_STATUS, intakeSourceInfo, loadSource, type SourceKind } from './sources';
import { recordWarmIntro, type DeclaredBy, type WarmIntroView } from './warm-intros';

export type RejectReason = 'invalid' | 'excluded' | 'daily_cap_reached' | 'duplicate_in_batch';
export type InlineResult = { arrivalId: string; accountId: string; personIds: string[]; signalIds: string[]; alreadyKnown: boolean };

/** Tests only: runs after each step is recorded, so a test can fail a job part-way. */
export const resolveTestHooks: { afterStep?: (step: string) => void | Promise<void> } = {};

type ArrivalRow = typeof arrival.$inferSelect;
type Counts = { resolved: number; rejected: number; newAccounts: number; alreadyKnown: number };

const subject = (id: string) => ({ type: 'arrival', id });
const chainOf = (r: ArrivalRow): SourceChain =>
  defined({
    personSourceId: r.personSourceId ?? undefined,
    agentSourceId: r.agentSourceId ?? undefined,
    vendorSourceId: r.vendorSourceId ?? undefined,
  });

/** SRC-E3 step 2: rules first; Claude only for text no rule maps, and never inline. */
async function normalise(ctx: ModuleContext, a: ArrivalV1, opts: { ai: boolean }): Promise<Normalised> {
  const ask = opts.ai ? unmapped(a) : null;
  return normaliseArrival(a, ask ? await normaliseWithAi(ctx, ask) : null);
}

function forAccounts(row: ArrivalRow, n: Normalised): ArrivalForAccounts {
  return {
    arrivalId: row.id,
    receivedAt: row.receivedAt,
    sourceChain: chainOf(row),
    account: n.account,
    people: n.people,
    signals: n.signals,
    facts: n.facts,
    research: n.research,
    ...(n.practiceHint ? { practiceHint: n.practiceHint } : {}),
    soleProprietor: n.soleProprietor,
    externalIds: [],
  };
}

// ---- Row updates ----

async function load(ctx: ModuleContext, id: string): Promise<ArrivalRow | undefined> {
  const [row] = await ctx.tx.select().from(arrival).where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, id)));
  return row;
}

/** Writes the step's outcome and records the step, in the caller's transaction. */
async function record(ctx: ModuleContext, row: ArrivalRow, step: string, set: Partial<typeof arrival.$inferInsert> = {}) {
  const steps = row.steps.includes(step) ? row.steps : [...row.steps, step];
  await ctx.tx
    .update(arrival)
    .set({ ...set, steps })
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, row.id)));
  Object.assign(row, set, { steps });
  await resolveTestHooks.afterStep?.(step);
}

async function wait(
  ctx: ModuleContext,
  row: ArrivalRow,
  waitingOn: WaitingOn,
  candidates?: { accountId: string; name: string; domain: string | null; score: number }[],
): Promise<void> {
  // Already waiting for the same thing: a redelivery publishes nothing new.
  if (row.waitingOn === waitingOn) return;
  await ctx.tx
    .update(arrival)
    .set({ waitingOn, waitingSince: new Date(), ...(candidates ? { duplicateCandidates: candidates } : {}) })
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, row.id)));
  await publish(
    ctx,
    arrivalWaiting,
    { arrivalId: row.id, ...(row.batchId ? { batchId: row.batchId } : {}), waitingOn, ...(candidates ? { candidates } : {}) },
    subject(row.id),
  );
}

// ---- Batches (step 8) ----

/**
 * Adds to the batch's counts under its row lock, then completes it when no item is received or
 * resolving (waiting items are resolving). Completion happens once: only a `processing` batch completes.
 */
export async function settleBatch(ctx: ModuleContext, batchId: string, add: Partial<Counts> = {}): Promise<void> {
  const [b] = await ctx.tx
    .select()
    .from(batch)
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)))
    .for('update');
  if (!b) return;
  const before = b.counts as Partial<Counts> & Record<string, unknown>;
  const counts = { ...before };
  for (const [k, v] of Object.entries(add)) counts[k] = ((before[k] as number | undefined) ?? 0) + v;
  const [{ open } = { open: 0 }] = (await ctx.tx.execute(sql`
    select count(*)::int as open from intake.arrival
    where tenant_id = ${ctx.tenantId} and batch_id = ${batchId} and status in ('received', 'resolving')
  `)) as unknown as { open: number }[];
  const completes = b.status === 'processing' && open === 0;
  await ctx.tx
    .update(batch)
    .set({ counts, ...(completes ? { status: 'completed', completedAt: new Date() } : {}) })
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  if (!completes) return;
  const cost = (b.metadata as { reported_cost?: { credits?: unknown; cost_cents?: unknown; currency?: unknown } } | null)?.reported_cost;
  const reportedCost = cost
    ? defined({
        credits: typeof cost.credits === 'number' ? cost.credits : undefined,
        costCents: typeof cost.cost_cents === 'number' ? cost.cost_cents : undefined,
        currency: typeof cost.currency === 'string' ? cost.currency : undefined,
      })
    : undefined;
  const n = (k: keyof Counts) => (counts[k] as number | undefined) ?? 0;
  await publish(
    ctx,
    batchCompleted,
    {
      batchId,
      counts: { resolved: n('resolved'), rejected: n('rejected'), newAccounts: n('newAccounts'), alreadyKnown: n('alreadyKnown') },
      ...(reportedCost ? { reportedCost } : {}),
    },
    { type: 'batch', id: batchId },
  );
}

/** The one path for every rejection after an arrival is stored: the row, the event, and the batch counts. */
export async function rejectArrival(
  ctx: ModuleContext,
  arrivalId: string,
  reason: RejectReason,
  detail: string,
  accountId?: string,
): Promise<void> {
  const row = await load(ctx, arrivalId);
  if (!row || row.status === 'resolved' || row.status === 'rejected') return;
  await record(ctx, row, 'outcome', {
    status: 'rejected',
    rejectReason: reason,
    rejectDetail: detail,
    waitingOn: null,
    waitingSince: null,
    ...(accountId ? { accountId } : {}),
  });
  await publish(
    ctx,
    arrivalRejected,
    { arrivalId, ...(row.batchId ? { batchId: row.batchId } : {}), reason, detail, ...(accountId ? { accountId } : {}) },
    subject(arrivalId),
  );
  if (row.batchId) await settleBatch(ctx, row.batchId, { rejected: 1 });
}

// ---- The pipeline ----

/**
 * Who declared the intro, from the closest source and the principal that sent the arrival. A person
 * source's key confirms only with `warm_intro:declare`; without it the intro counts like an agent's.
 */
function declaredBy(row: ArrivalRow, kind: string | undefined): DeclaredBy {
  if (kind === 'person' && row.principal.startsWith('user:')) return 'person';
  if (kind === 'person') return row.canDeclareWarmIntro ? 'person_key' : 'agent';
  return kind === 'agent' || kind === 'scheduled_pull' ? 'agent' : 'vendor';
}

async function isFirstFromSource(ctx: ModuleContext, row: ArrivalRow, accountId: string): Promise<boolean> {
  const [earlier] = await ctx.tx
    .select({ id: arrival.id })
    .from(arrival)
    .where(
      and(
        eq(arrival.tenantId, ctx.tenantId),
        eq(arrival.closestSourceId, row.closestSourceId),
        eq(arrival.accountId, accountId),
        eq(arrival.status, 'resolved'),
        ne(arrival.id, row.id),
      ),
    )
    .limit(1);
  return !earlier;
}

/** Step 7, returning the outcome: rejected when ruled out and not overridden, else resolved with `intake.arrival.resolved`. */
async function finish(
  ctx: ModuleContext,
  row: ArrivalRow,
  n: Normalised,
  accountId: string,
  excluded: Exclusion | null,
  intro: WarmIntroView | null,
): Promise<'resolved' | 'rejected'> {
  if (excluded && !excluded.override) {
    await rejectArrival(ctx, row.id, 'excluded', excluded.label, accountId);
    return 'rejected';
  }
  const first = await isFirstFromSource(ctx, row, accountId);
  const closest = await loadSource(ctx, row.closestSourceId);
  const chain = chainOf(row);
  await record(ctx, row, 'outcome', { status: 'resolved', resolvedAt: new Date(), waitingOn: null, waitingSince: null });
  await publish(
    ctx,
    arrivalResolved,
    {
      arrivalId: row.id,
      ...(row.batchId ? { batchId: row.batchId } : {}),
      accountId,
      resolution: row.resolution === 'created' ? 'created' : 'attached',
      sourceChain: chain,
      isFirstFromSource: first,
      initialReviewStatusKey:
        closest?.initialReviewStatusKey ?? DEFAULT_REVIEW_STATUS[(closest?.kind ?? 'vendor') as SourceKind] ?? 'unvetted',
      effectiveTrust: await intakeSourceInfo.getTrust(ctx, chain),
      ...(intro
        ? { warmIntro: { warmIntroId: intro.warmIntroId, relationshipKey: intro.relationshipKey, points: intro.points, confirmed: intro.confirmed } }
        : {}),
      ...(n.practiceHint ? { practiceHint: n.practiceHint } : {}),
      ...(n.offerHint ? { offerHint: n.offerHint } : {}),
    },
    subject(row.id),
  );
  if (row.batchId) {
    await settleBatch(ctx, row.batchId, { resolved: 1, ...(row.resolution === 'created' ? { newAccounts: 1 } : { alreadyKnown: 1 }) });
  }
  return 'resolved';
}

/** Step 1. The body is `payload.arrival` when the raw payload is something else (file rows), else `payload.raw`. */
function validate(row: ArrivalRow): { ok: true; body: ArrivalV1 } | { ok: false; detail: string } {
  const payload = row.payload as { raw?: unknown; arrival?: unknown };
  const strict = row.channel === 'api' || row.channel === 'mcp';
  const parsed = ArrivalV1Schema({ strict }).safeParse(moveItemFields(payload.arrival ?? payload.raw));
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, detail: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join(' ') };
}

/** Steps 1 and 2, each skipped when already recorded. Null when the arrival was rejected `invalid`. */
async function validated(ctx: ModuleContext, row: ArrivalRow, opts: { ai: boolean }): Promise<Normalised | null> {
  if (row.steps.includes('normalise')) return revive(row.normalised);
  const v = validate(row);
  if (!v.ok) {
    await rejectArrival(ctx, row.id, 'invalid', v.detail);
    return null;
  }
  if (!row.steps.includes('validate')) await record(ctx, row, 'validate', { status: 'resolving' });
  // Before any lock: the AI call may take seconds.
  await record(ctx, row, 'normalise', { normalised: await normalise(ctx, v.body, opts) });
  return revive(row.normalised);
}

/** Step 4: the account to attach to (undefined: create one), or 'waiting'. The caller holds the resolve lock. */
async function match(ctx: ModuleContext, row: ArrivalRow, n: Normalised): Promise<string | undefined | 'waiting'> {
  const a = n.account;
  const matches = await findMatches(
    ctx,
    defined({
      domain: a.domain,
      linkedinUrl: a.linkedinUrl,
      name: a.name,
      country: a.hqCountry,
      region: a.hqState,
      city: a.hqCity,
      shellEmail: shellEmail(n),
    }),
  );
  const sure = matches.find((m) => m.confidence !== 'possible');
  if (sure) return sure.accountId;
  if (matches.length === 0) return undefined;
  const decided = (row.resolutionInput as ResolutionInput | null)?.duplicate;
  if (decided) return decided.kind === 'same_as' ? decided.accountId : undefined;
  const found = await getAccounts(ctx, matches.map((m) => m.accountId));
  const candidates = found.map((acc) => ({
    accountId: acc.id,
    name: acc.name,
    domain: acc.domain,
    score: Math.round(trigramSimilarity(matchName(acc.name), matchName(a.name ?? '')) * 100) / 100,
  }));
  await wait(ctx, row, 'possible_duplicate', candidates);
  return 'waiting';
}

/**
 * Runs SRC-E3 steps 1 to 8 for one arrival (job `jobs.intake.resolve`). Each step records its
 * outcome on the arrival in the same transaction as its work and is skipped when already recorded,
 * so a redelivered job never upserts twice. Lock order: the resolve lock, then Accounts' account lock.
 */
export async function resolveArrival(ctx: ModuleContext, arrivalId: string): Promise<void> {
  const row = await load(ctx, arrivalId);
  if (!row || row.status === 'resolved' || row.status === 'rejected') return;
  const saved = await validated(ctx, row, { ai: true });
  if (!saved) return;
  const n = withInput(saved, row.resolutionInput as ResolutionInput | null);

  // 3. Waiting checks.
  const waitingOn = waitingFor(n, !!row.targetAccountId);
  if (waitingOn) return wait(ctx, row, waitingOn);

  // 4 and 5. Find the account and create or attach, under the resolve lock.
  let excluded: Exclusion | null;
  if (!row.steps.includes('upsert')) {
    let target: string | undefined = row.targetAccountId ?? undefined;
    if (!target) {
      const lockKey = lockKeyOf(n, row.id);
      await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':res:' || ${lockKey}))`);
      const found = await match(ctx, row, n);
      if (found === 'waiting') return;
      target = found;
      await record(ctx, row, 'match', { lockKey, accountId: target ?? null, waitingOn: null, waitingSince: null });
    }
    const r = await upsertFromArrival(ctx, forAccounts(row, n), target);
    await record(ctx, row, 'upsert', { accountId: r.accountId, resolution: r.created ? 'created' : 'attached' });
    excluded = r.excluded;
  } else {
    excluded = await checkExclusion(ctx, row.accountId!);
  }
  const accountId = row.accountId!;

  // 6. Warm intro. One per arrival: a retry gets the stored row back.
  let intro: WarmIntroView | null = null;
  if (n.warmIntro) {
    const kind = (await loadSource(ctx, row.closestSourceId))?.kind;
    intro = await recordWarmIntro(ctx, row.id, accountId, n.warmIntro, declaredBy(row, kind));
    if (!row.steps.includes('warm_intro')) await record(ctx, row, 'warm_intro', { warmIntroId: intro.warmIntroId });
  }

  // 7 and 8. Exclusion, the outcome, and the batch counters.
  await finish(ctx, row, n, accountId, excluded, intro);
}

/**
 * Inline resolution of a targeted arrival (`add_person`, `add_signal`): steps 1, 2 (rules only,
 * never Claude), 5 and 7 in the caller's transaction.
 */
export async function resolveInline(ctx: ModuleContext, arrivalId: string): Promise<{ status: string; inlineResult?: InlineResult }> {
  const row = (await load(ctx, arrivalId))!;
  const n = await validated(ctx, row, { ai: false });
  if (!n) return { status: 'rejected' };
  const r = await upsertFromArrival(ctx, forAccounts(row, n), row.targetAccountId!);
  await record(ctx, row, 'upsert', { accountId: r.accountId, resolution: r.created ? 'created' : 'attached' });
  // An excluded target is rejected `excluded`; the people and signals stay on the kept account.
  const status = await finish(ctx, row, n, r.accountId, r.excluded, null);
  const sent = r.personIds.length + r.signalIds.length;
  return {
    status,
    inlineResult: {
      arrivalId,
      accountId: r.accountId,
      personIds: r.personIds,
      signalIds: r.signalIds,
      alreadyKnown: sent > 0 && r.existingPersonIds.length + r.existingSignalIds.length === sent,
    },
  };
}
