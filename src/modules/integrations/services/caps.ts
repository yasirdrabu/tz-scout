import { and, eq, inArray, sql } from 'drizzle-orm';
import { tenantTimezone } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { usageThresholdReached } from '../contracts/events';
import { usageCap, usagePeriod } from '../db/schema';
import { DEFAULT_CAPS, levelOf, periodBounds, type CapLevel, type CapPeriod, type CapUnit } from '../domain/caps';
import { providerName } from '../providers';

export type CapView = {
  providerKey: string;
  unit: CapUnit;
  period: CapPeriod;
  limit: number;
  used: number;
  reserved: number;
  level: CapLevel;
  resetsAt: Date;
  overage: boolean;
};

/** What `reserve` holds; pass it to `settle` after the call. `reservationId` is null when the provider has no limit. */
export type Reservation =
  | { reservationId: null; level: 'ok' }
  | { reservationId: string; level: CapLevel; providerKey: string; periodStart: string; resetsAt: Date; amount: number };

type CapRow = typeof usageCap.$inferSelect;
type PeriodRow = typeof usagePeriod.$inferSelect;
type Bounds = { start: string; resetsAt: Date };

export const LIMIT_INVALID = 'Enter a whole number of 1 or more.';

const periodWord = (period: string) => (period === 'day' ? 'daily' : 'monthly');

/** Ruling 8: the refusal the AI runner falls back on. */
function capBlocked(providerKey: string, period: string, resetsAt: Date, now: Date): ScoutError {
  return new ScoutError({
    slug: 'blocked_by_cap',
    status: 429,
    title: `${providerName(providerKey)} reached its ${periodWord(period)} limit.`,
    detail: 'An owner can raise it in Settings, Integrations.',
    headers: { 'retry-after': String(Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))) },
    extensions: { resets_at: resetsAt.toISOString() },
  });
}

const noCap = (providerKey: string) =>
  new ScoutError({ slug: 'not-found', status: 404, title: `${providerName(providerKey)} has no usage limit.` });

/** Ruling 2: the defaults are inserted the first time a tenant's caps are read or checked. */
async function ensureDefaults(tx: Tx, tenantId: string): Promise<void> {
  await tx
    .insert(usageCap)
    .values(Object.entries(DEFAULT_CAPS).map(([providerKey, c]) => ({ tenantId, providerKey, ...c })))
    .onConflictDoNothing();
}

async function findCap(tx: Tx, tenantId: string, providerKey: string): Promise<CapRow | undefined> {
  await ensureDefaults(tx, tenantId);
  const [cap] = await tx
    .select()
    .from(usageCap)
    .where(and(eq(usageCap.tenantId, tenantId), eq(usageCap.providerKey, providerKey)));
  return cap;
}

const periodKey = (tenantId: string, providerKey: string, start: string) =>
  and(eq(usagePeriod.tenantId, tenantId), eq(usagePeriod.providerKey, providerKey), eq(usagePeriod.periodStart, start));

const boundsOf = (cap: CapRow, now: Date, timeZone: string) => periodBounds(cap.period as CapPeriod, now, timeZone);

/** Publishes the level's threshold event unless this period already did (Ruling 7). The row must be locked. */
async function notify(ctx: ModuleContext, cap: CapRow, bounds: Bounds, row: PeriodRow, level: CapLevel): Promise<void> {
  if (level === 'ok') return;
  const flag = level === 'warn' ? 'warned' : 'blocked';
  if (row[flag]) return;
  await ctx.tx
    .update(usagePeriod)
    .set({ [flag]: true })
    .where(periodKey(ctx.tenantId, cap.providerKey, bounds.start));
  await publish(
    ctx,
    usageThresholdReached,
    {
      providerKey: cap.providerKey,
      unit: cap.unit as CapUnit,
      period: cap.period as CapPeriod,
      periodStart: bounds.start,
      level,
      used: row.used,
      limit: cap.limit,
      resetsAt: bounds.resetsAt.toISOString(),
    },
    { type: 'usage_cap', id: cap.providerKey },
  );
}

/** Every limit the tenant has, with the current period's usage. */
export async function listCaps(ctx: ModuleContext, now = new Date()): Promise<CapView[]> {
  const timeZone = await tenantTimezone(ctx);
  await ensureDefaults(ctx.tx, ctx.tenantId);
  const caps = await ctx.tx.select().from(usageCap).where(eq(usageCap.tenantId, ctx.tenantId)).orderBy(usageCap.providerKey);
  const bounds = new Map(caps.map((c) => [c.providerKey, boundsOf(c, now, timeZone)]));
  const starts = [...new Set([...bounds.values()].map((b) => b.start))];
  const rows = starts.length
    ? await ctx.tx
        .select()
        .from(usagePeriod)
        .where(and(eq(usagePeriod.tenantId, ctx.tenantId), inArray(usagePeriod.periodStart, starts)))
    : [];
  return caps.map((c) => {
    const b = bounds.get(c.providerKey)!;
    const row = rows.find((r) => r.providerKey === c.providerKey && r.periodStart === b.start);
    const used = row?.used ?? 0;
    const reserved = row?.reserved ?? 0;
    const overage = c.overagePeriodStart === b.start;
    return {
      providerKey: c.providerKey,
      unit: c.unit as CapUnit,
      period: c.period as CapPeriod,
      limit: c.limit,
      used,
      reserved,
      level: levelOf(used, reserved, c.limit, overage),
      resetsAt: b.resetsAt,
      overage,
    };
  });
}

/** Read-only check for estimates: the level `amount` more would reach. No limit reads as ok with `limit` null. */
export async function checkCap(
  ctx: ModuleContext,
  providerKey: string,
  amount: number,
  now = new Date(),
): Promise<{ status: CapLevel; used: number; limit: number | null; resetsAt: Date | null }> {
  const timeZone = await tenantTimezone(ctx);
  const cap = await findCap(ctx.tx, ctx.tenantId, providerKey);
  if (!cap) return { status: 'ok', used: 0, limit: null, resetsAt: null };
  const b = boundsOf(cap, now, timeZone);
  const [row] = await ctx.tx.select().from(usagePeriod).where(periodKey(ctx.tenantId, providerKey, b.start));
  const used = row?.used ?? 0;
  return {
    status: levelOf(used, (row?.reserved ?? 0) + amount, cap.limit, cap.overagePeriodStart === b.start),
    used,
    limit: cap.limit,
    resetsAt: b.resetsAt,
  };
}

/**
 * Ruling 6: holds `amount` against the provider's limit in its own committed transaction, so concurrent
 * callers see it. The period row is locked, so two reservations that together pass the limit cannot
 * both succeed. Throws `blocked_by_cap` (Ruling 8) when the reservation would pass the limit.
 */
export async function reserve(ctx: ModuleContext, providerKey: string, amount: number, now = new Date()): Promise<Reservation> {
  const timeZone = await tenantTimezone(ctx);
  const out = await withTenant(ctx.tenantId, async (tx) => {
    const cap = await findCap(tx, ctx.tenantId, providerKey);
    if (!cap) return null;
    const bounds = boundsOf(cap, now, timeZone);
    await tx
      .insert(usagePeriod)
      .values({ tenantId: ctx.tenantId, providerKey, periodStart: bounds.start })
      .onConflictDoNothing();
    const [row] = await tx.select().from(usagePeriod).where(periodKey(ctx.tenantId, providerKey, bounds.start)).for('update');
    const level = levelOf(row!.used, row!.reserved + amount, cap.limit, cap.overagePeriodStart === bounds.start);
    if (level !== 'blocked') {
      await tx
        .update(usagePeriod)
        .set({ reserved: sql`${usagePeriod.reserved} + ${amount}` })
        .where(periodKey(ctx.tenantId, providerKey, bounds.start));
    }
    // A refusal still commits its notice, so the error is thrown after the transaction.
    await notify({ ...ctx, tx }, cap, bounds, row!, level);
    return { cap, bounds, level };
  });
  if (!out) return { reservationId: null, level: 'ok' };
  const { cap, bounds, level } = out;
  if (level === 'blocked') throw capBlocked(providerKey, cap.period, bounds.resetsAt, now);
  return {
    reservationId: `${providerKey}:${bounds.start}`,
    level,
    providerKey,
    periodStart: bounds.start,
    resetsAt: bounds.resetsAt,
    amount,
  };
}

/**
 * Ruling 6: after the call, success or not, `used += actual` and the reservation is released. Pass
 * `tx` to commit with the caller's transaction (the gateway's call log); otherwise it commits on its own.
 */
export async function settle(ctx: ModuleContext, reservation: Reservation, actual: number, tx?: Tx): Promise<void> {
  if (reservation.reservationId === null) return;
  const r = reservation;
  const run = async (t: Tx) => {
    const [row] = await t
      .update(usagePeriod)
      .set({
        used: sql`${usagePeriod.used} + ${actual}`,
        reserved: sql`greatest(${usagePeriod.reserved} - ${r.amount}, 0)`,
      })
      .where(periodKey(ctx.tenantId, r.providerKey, r.periodStart))
      .returning();
    if (!row) return;
    const [cap] = await t
      .select()
      .from(usageCap)
      .where(and(eq(usageCap.tenantId, ctx.tenantId), eq(usageCap.providerKey, r.providerKey)));
    if (!cap) return;
    const level = levelOf(row.used, row.reserved, cap.limit, cap.overagePeriodStart === r.periodStart);
    await notify({ ...ctx, tx: t }, cap, { start: r.periodStart, resetsAt: r.resetsAt }, row, level);
  };
  await (tx ? run(tx) : withTenant(ctx.tenantId, run));
}

/** Ruling 9: an owner sets the limit, a whole number of 1 or more. Takes effect for the next reservation. */
export async function setCapLimit(ctx: ModuleContext, providerKey: string, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ScoutError({ slug: 'validation', status: 400, title: LIMIT_INVALID });
  }
  const cap = await findCap(ctx.tx, ctx.tenantId, providerKey);
  if (!cap) throw noCap(providerKey);
  await ctx.tx
    .update(usageCap)
    .set({ limit, updatedBy: ctx.actor.id, updatedAt: sql`now()` })
    .where(and(eq(usageCap.tenantId, ctx.tenantId), eq(usageCap.providerKey, providerKey)));
  await audit(ctx, {
    action: 'integrations.cap.set',
    subject: { type: 'usage_cap', id: providerKey },
    before: { limit: cap.limit },
    after: { limit },
  });
}

/** Ruling 9: lets the provider go over its limit until the current period resets. */
export async function allowOverage(ctx: ModuleContext, providerKey: string, now = new Date()): Promise<void> {
  const timeZone = await tenantTimezone(ctx);
  const cap = await findCap(ctx.tx, ctx.tenantId, providerKey);
  if (!cap) throw noCap(providerKey);
  const b = boundsOf(cap, now, timeZone);
  await ctx.tx
    .update(usageCap)
    .set({ overagePeriodStart: b.start, updatedBy: ctx.actor.id, updatedAt: sql`now()` })
    .where(and(eq(usageCap.tenantId, ctx.tenantId), eq(usageCap.providerKey, providerKey)));
  await audit(ctx, {
    action: 'integrations.cap.overage',
    subject: { type: 'usage_cap', id: providerKey },
    before: { overagePeriodStart: cap.overagePeriodStart },
    after: { overagePeriodStart: b.start, resetsAt: b.resetsAt },
  });
}
