import { and, count, eq, sql } from 'drizzle-orm';
import { listScoringPicks } from '@/modules/accounts';
import { listDeals } from '@/modules/crm';
import { listResolvedArrivals } from '@/modules/intake';
import { listStageHistory, listStages } from '@/modules/routing';
import type { ModuleContext } from '@/platform/context';
import { journey, journeyDeal, journeyStage } from '../db/schema';

/** One account's way through the funnel, as later funnel and cost reads take it. */
export type Journey = {
  accountId: string;
  firstSourceId: string;
  firstBatchId: string | null;
  arrivedAt: Date;
  practiceId: string | null;
  offerId: string | null;
  exitStage: string | null;
  exitAt: Date | null;
  /** The earliest entry into each stage, by stage key. */
  stages: Map<string, Date>;
  deals: { status: 'open' | 'won' | 'lost'; amountCents: number | null; closedAt: Date | null }[];
};

export type StageKind = 'flow' | 'exit';

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** The kind of each live stage, by key. A deleted stage has none. */
export async function stageKinds(ctx: ModuleContext): Promise<Map<string, StageKind>> {
  return new Map((await listStages(ctx)).stages.map((s) => [s.key, s.kind]));
}

const touch = (ctx: ModuleContext, accountId: string) =>
  ctx.tx.update(journey).set({ updatedAt: sql`now()` }).where(and(eq(journey.tenantId, ctx.tenantId), eq(journey.accountId, accountId)));

/** Makes the journey, or keeps whichever arrival is earlier (with its source and batch). */
export async function recordArrival(ctx: ModuleContext, a: { accountId: string; sourceId: string; batchId: string | null; at: Date }): Promise<void> {
  await ctx.tx
    .insert(journey)
    .values({ tenantId: ctx.tenantId, accountId: a.accountId, firstSourceId: a.sourceId, firstBatchId: a.batchId, arrivedAt: a.at })
    .onConflictDoUpdate({
      target: journey.accountId,
      set: { firstSourceId: sql`excluded.first_source_id`, firstBatchId: sql`excluded.first_batch_id`, arrivedAt: sql`excluded.arrived_at`, updatedAt: sql`now()` },
      setWhere: sql`${journey.arrivedAt} > excluded.arrived_at`,
    });
}

/**
 * Records an entry into a stage, keeping the earliest seen. A move to an exit or a flow stage later than the
 * journey's `exit_at` sets the exit (or clears it, for a flow stage); an older one changes nothing. A stage
 * with no kind (deleted) only stores its entry. With no journey yet, the entry is still stored.
 */
export async function recordStage(ctx: ModuleContext, s: { accountId: string; stageKey: string; at: Date; kind: StageKind | undefined }): Promise<void> {
  const moved = await ctx.tx
    .insert(journeyStage)
    .values({ tenantId: ctx.tenantId, accountId: s.accountId, stageKey: s.stageKey, enteredAt: s.at })
    .onConflictDoUpdate({
      target: [journeyStage.tenantId, journeyStage.accountId, journeyStage.stageKey],
      set: { enteredAt: sql`excluded.entered_at` },
      setWhere: sql`${journeyStage.enteredAt} > excluded.entered_at`,
    })
    .returning({ key: journeyStage.stageKey });
  const exited = s.kind
    ? await ctx.tx
        .update(journey)
        .set({ exitStage: s.kind === 'exit' ? s.stageKey : null, exitAt: s.at, updatedAt: sql`now()` })
        .where(and(eq(journey.tenantId, ctx.tenantId), eq(journey.accountId, s.accountId), sql`(${journey.exitAt} is null or ${journey.exitAt} < ${ts(s.at)})`))
        .returning({ id: journey.accountId })
    : [];
  if (moved.length > 0 && exited.length === 0) await touch(ctx, s.accountId);
}

/** Sets the practice and offer scoring picked. */
export async function recordScore(ctx: ModuleContext, s: { accountId: string; practiceId: string | null; offerId: string | null }): Promise<void> {
  await ctx.tx
    .update(journey)
    .set({ practiceId: s.practiceId, offerId: s.offerId, updatedAt: sql`now()` })
    .where(
      and(
        eq(journey.tenantId, ctx.tenantId),
        eq(journey.accountId, s.accountId),
        sql`(${journey.practiceId} is distinct from ${s.practiceId}::text or ${journey.offerId} is distinct from ${s.offerId}::text)`,
      ),
    );
}

/** Stores a deal's state; a row only takes a later `observedAt`. */
export async function recordDeal(
  ctx: ModuleContext,
  d: { accountId: string; system: string; dealExternalId: string; status: 'open' | 'won' | 'lost'; amountCents: number | null; closedAt: Date | null; observedAt: Date },
): Promise<void> {
  const changed = await ctx.tx
    .insert(journeyDeal)
    .values({ tenantId: ctx.tenantId, ...d })
    .onConflictDoUpdate({
      target: [journeyDeal.tenantId, journeyDeal.system, journeyDeal.dealExternalId],
      set: {
        accountId: sql`excluded.account_id`,
        status: sql`excluded.status`,
        amountCents: sql`excluded.amount_cents`,
        closedAt: sql`excluded.closed_at`,
        observedAt: sql`excluded.observed_at`,
      },
      setWhere: sql`${journeyDeal.observedAt} < excluded.observed_at`,
    })
    .returning({ id: journeyDeal.dealExternalId });
  if (changed.length > 0) await touch(ctx, d.accountId);
}

/**
 * After an account merge: the survivor keeps the earlier arrival (with its source and batch), the earliest
 * entry into each stage, the later exit and both accounts' deals; it keeps its own practice and offer when it
 * has them. The merged account's journey is deleted. Running it again changes nothing.
 */
export async function mergeJourneys(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  const of = (id: string) => and(eq(journey.tenantId, ctx.tenantId), eq(journey.accountId, id));
  const [m] = await ctx.tx.select().from(journey).where(of(mergedId)).for('update');
  if (m) {
    await recordArrival(ctx, { accountId: survivorId, sourceId: m.firstSourceId, batchId: m.firstBatchId, at: m.arrivedAt });
    await ctx.tx
      .update(journey)
      .set({ practiceId: sql`coalesce(${journey.practiceId}, ${m.practiceId}::text)`, offerId: sql`coalesce(${journey.offerId}, ${m.offerId}::text)` })
      .where(of(survivorId));
    if (m.exitAt) {
      await ctx.tx
        .update(journey)
        .set({ exitStage: m.exitStage, exitAt: m.exitAt, updatedAt: sql`now()` })
        .where(and(of(survivorId), sql`(${journey.exitAt} is null or ${journey.exitAt} < ${ts(m.exitAt)})`));
    }
    await ctx.tx.delete(journey).where(of(mergedId));
  }

  const mergedStages = and(eq(journeyStage.tenantId, ctx.tenantId), eq(journeyStage.accountId, mergedId));
  for (const r of await ctx.tx.select().from(journeyStage).where(mergedStages)) {
    await recordStage(ctx, { accountId: survivorId, stageKey: r.stageKey, at: r.enteredAt, kind: undefined });
  }
  await ctx.tx.delete(journeyStage).where(mergedStages);
  await ctx.tx
    .update(journeyDeal)
    .set({ accountId: survivorId })
    .where(and(eq(journeyDeal.tenantId, ctx.tenantId), eq(journeyDeal.accountId, mergedId)));
}

/** Every journey in the workspace, with its stage entries and deals. Exit is null unless the latest move was to an exit. */
export async function loadJourneys(ctx: ModuleContext): Promise<Journey[]> {
  const rows = await ctx.tx.select().from(journey).where(eq(journey.tenantId, ctx.tenantId)).orderBy(journey.accountId);
  const stages = await ctx.tx.select().from(journeyStage).where(eq(journeyStage.tenantId, ctx.tenantId)).orderBy(journeyStage.stageKey);
  const deals = await ctx.tx
    .select()
    .from(journeyDeal)
    .where(eq(journeyDeal.tenantId, ctx.tenantId))
    .orderBy(journeyDeal.system, journeyDeal.dealExternalId);
  const byId = new Map<string, Journey>(
    rows.map((r) => [
      r.accountId,
      {
        accountId: r.accountId,
        firstSourceId: r.firstSourceId,
        firstBatchId: r.firstBatchId,
        arrivedAt: r.arrivedAt,
        practiceId: r.practiceId,
        offerId: r.offerId,
        exitStage: r.exitStage,
        exitAt: r.exitStage ? r.exitAt : null,
        stages: new Map(),
        deals: [],
      },
    ]),
  );
  for (const s of stages) byId.get(s.accountId)?.stages.set(s.stageKey, s.enteredAt);
  for (const d of deals) byId.get(d.accountId)?.deals.push({ status: d.status as 'open' | 'won' | 'lost', amountCents: d.amountCents, closedAt: d.closedAt });
  return [...byId.values()];
}

/**
 * Fills journeys for accounts that arrived before the consumers ran (Ruling 14): from intake's resolved arrivals,
 * routing's stage history, the account summary's practice and offer, and crm's cached deals, through the same
 * rules as the consumers, so running it again changes nothing. Background context only. Returns how many
 * journeys it made.
 */
export async function backfillJourneys(ctx: ModuleContext): Promise<number> {
  const journeys = async () =>
    (await ctx.tx.select({ n: count() }).from(journey).where(eq(journey.tenantId, ctx.tenantId)))[0]!.n;
  const before = await journeys();
  for (const a of await listResolvedArrivals(ctx)) {
    await recordArrival(ctx, { accountId: a.accountId, sourceId: a.closestSourceId, batchId: a.batchId, at: a.resolvedAt });
  }
  const kinds = await stageKinds(ctx);
  for (const s of await listStageHistory(ctx)) await recordStage(ctx, { accountId: s.accountId, stageKey: s.toStage, at: s.at, kind: kinds.get(s.toStage) });
  for (const p of await listScoringPicks(ctx)) await recordScore(ctx, { accountId: p.accountId, practiceId: p.practiceId, offerId: p.bestOfferId });
  for (const d of await listDeals(ctx)) {
    await recordDeal(ctx, {
      accountId: d.accountId,
      system: d.system,
      dealExternalId: d.externalId,
      status: d.status,
      amountCents: d.amountCents,
      closedAt: d.closedAt,
      observedAt: d.syncedAt,
    });
  }
  return (await journeys()) - before;
}
