import { and, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { stageOutcomes } from '../contracts/ports';
import { sourceTrustChanged } from '../contracts/events';
import { arrival, source, sourceFeedback, sourceTrustHistory } from '../db/schema';
import { HALF_LIFE_DAYS, PUBLISH_STEP, ZERO_SELLER_REASONS, arrivalQuality, stageQualities, trustOf } from '../domain/trust';

const DAY_MS = 86_400_000;

type Level = 'person' | 'agent' | 'vendor';
export type TrustResult = { sourceId: string; from: number; to: number; sampleSize: number; published: boolean };

/** A source with no arrival yet is rated at the level its kind sends at (see `senderOf`). */
const levelOfKind = (kind: string): Level => (kind === 'person' || kind === 'partner' ? 'person' : kind === 'agent' || kind === 'list' || kind === 'scheduled_pull' ? 'agent' : 'vendor');

/**
 * R3b-2: learns each source's trust from what its accounts became (Rulings 1-8, 14). Reads current truth, nothing cached:
 * intake's resolved arrivals and feedback, plus the pipeline's stages and stage moves through the `StageOutcomes` port.
 * Writes `source.trust`, its sample and wins, and one history row per source; publishes `trust_changed` only when trust
 * has moved `PUBLISH_STEP` from the last value published. `from` in the result is the trust before this run.
 */
export async function computeTrust(
  ctx: ModuleContext,
  opts: { cause: 'outcomes' | 'conflict_lost'; sourceIds?: string[]; now?: Date },
): Promise<TrustResult[]> {
  const now = opts.now ?? new Date();
  const tenantId = ctx.tenantId;
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];

  // Removed sources are skipped; archived ones are still computed. The rows are locked in id order before anything is
  // computed, so the nightly run and conflict recomputes queue up instead of deadlocking or losing `trust_published`.
  const sources = await ctx.tx
    .select({ id: source.id, kind: source.kind, trust: source.trust, published: source.trustPublished })
    .from(source)
    .where(and(eq(source.tenantId, tenantId), ne(source.status, 'removed'), opts.sourceIds ? inArray(source.id, opts.sourceIds) : undefined))
    .orderBy(source.id)
    .for('update');
  if (sources.length === 0) return [];
  const ids = sources.map((s) => s.id);

  const outcomes = stageOutcomes();
  const stages = await outcomes.stages(ctx);
  const qualities = stageQualities(stages);
  const accepts = stages.find((s) => s.trigger === 'ae_accepts');
  const assigned = new Set(accepts ? stages.filter((s) => s.kind === 'flow' && s.position >= accepts.position).map((s) => s.key) : []);

  const entries = new Map<string, { stage: string; at: Date }[]>();
  for (const h of await outcomes.history(ctx)) {
    const list = entries.get(h.accountId) ?? [];
    list.push({ stage: h.toStage, at: h.at });
    entries.set(h.accountId, list);
  }

  const arrivals = await ctx.tx
    .select({ id: arrival.id, accountId: arrival.accountId, resolvedAt: arrival.resolvedAt, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(
      and(
        eq(arrival.tenantId, tenantId),
        eq(arrival.status, 'resolved'),
        isNotNull(arrival.accountId),
        isNotNull(arrival.resolvedAt),
        opts.sourceIds ? or(inArray(arrival.personSourceId, ids), inArray(arrival.agentSourceId, ids), inArray(arrival.vendorSourceId, ids)) : undefined,
      ),
    );

  // Decline feedback is about the account, whichever source it was written for.
  const declines = new Map<string, Date[]>();
  const declineRows = await ctx.tx
    .select({ accountId: sourceFeedback.accountId, kind: sourceFeedback.kind, reasonKey: sourceFeedback.reasonKey, at: sourceFeedback.createdAt })
    .from(sourceFeedback)
    .where(and(eq(sourceFeedback.tenantId, tenantId), inArray(sourceFeedback.kind, ['declined_at_review', 'declined_by_seller'])));
  for (const d of declineRows) {
    if (d.kind === 'declined_by_seller' && !(d.reasonKey && ZERO_SELLER_REASONS.includes(d.reasonKey))) continue;
    declines.set(d.accountId, [...(declines.get(d.accountId) ?? []), d.at]);
  }

  const since = new Date(now.getTime() - HALF_LIFE_DAYS * DAY_MS);
  const lostRows = await ctx.tx
    .select({ sourceId: sourceFeedback.sourceId, n: sql<number>`count(*)::int` })
    .from(sourceFeedback)
    .where(and(eq(sourceFeedback.tenantId, tenantId), eq(sourceFeedback.kind, 'conflict_lost'), inArray(sourceFeedback.sourceId, ids), gte(sourceFeedback.createdAt, since)))
    .groupBy(sourceFeedback.sourceId);
  const conflictsLost = new Map(lostRows.map((r) => [r.sourceId, r.n]));

  // One credit per (source, account): the earliest resolved arrival (Ruling 5).
  const idSet = new Set(ids);
  const levelOf = new Map<string, Level>();
  const credit = new Map<string, { sourceId: string; accountId: string; resolvedAt: Date; id: string }>();
  for (const a of arrivals) {
    for (const [sourceId, level] of [[a.person, 'person'], [a.agent, 'agent'], [a.vendor, 'vendor']] as const) {
      if (!sourceId || !idSet.has(sourceId)) continue;
      if (!levelOf.has(sourceId)) levelOf.set(sourceId, level);
      const key = `${sourceId}\u0000${a.accountId}`;
      const held = credit.get(key);
      const resolvedAt = a.resolvedAt!;
      if (!held || resolvedAt < held.resolvedAt || (+resolvedAt === +held.resolvedAt && a.id < held.id)) {
        credit.set(key, { sourceId, accountId: a.accountId!, resolvedAt, id: a.id });
      }
    }
  }

  const judged = new Map<string, { quality: number; ageDays: number }[]>();
  for (const c of credit.values()) {
    const moves = entries.get(c.accountId) ?? [];
    // An account already assigned when this arrival came in was not this source's work (Ruling 5).
    if (moves.some((m) => assigned.has(m.stage) && m.at < c.resolvedAt)) continue;
    const quality = arrivalQuality({ resolvedAt: c.resolvedAt, entries: moves, declines: declines.get(c.accountId) ?? [], stages, qualities, now });
    if (quality === null) continue;
    const list = judged.get(c.sourceId) ?? [];
    list.push({ quality, ageDays: Math.max(0, (now.getTime() - c.resolvedAt.getTime()) / DAY_MS) });
    judged.set(c.sourceId, list);
  }

  const results: TrustResult[] = [];
  for (const s of sources) {
    const mine = judged.get(s.id) ?? [];
    const lost = conflictsLost.get(s.id) ?? 0;
    const to = trustOf(mine, lost);
    const won = mine.filter((j) => j.quality === 1).length;
    const level = levelOf.get(s.id) ?? levelOfKind(s.kind);
    const publishes = Math.abs(to - s.published) >= PUBLISH_STEP - 1e-9;
    await ctx.tx
      .update(source)
      .set({ trust: to, trustSample: mine.length, trustWon: won, trustUpdatedAt: now, ...(publishes ? { trustPublished: to } : {}) })
      .where(and(eq(source.tenantId, tenantId), eq(source.id, s.id)));
    await ctx.tx
      .insert(sourceTrustHistory)
      .values({ tenantId, sourceId: s.id, computedAt: now, trust: to, sampleSize: mine.length, won, inputs: { cause: opts.cause, conflictsLost: lost, level } })
      .onConflictDoUpdate({
        target: [sourceTrustHistory.tenantId, sourceTrustHistory.sourceId, sourceTrustHistory.computedAt],
        set: { trust: to, sampleSize: mine.length, won, inputs: { cause: opts.cause, conflictsLost: lost, level } },
      });
    if (publishes) {
      await publish(ctx, sourceTrustChanged, { sourceId: s.id, level, from: s.published, to, sampleSize: mine.length, cause: opts.cause }, { type: 'source', id: s.id });
    }
    results.push({ sourceId: s.id, from: s.trust, to, sampleSize: mine.length, published: publishes });
  }
  return results;
}
