import { and, eq, inArray, sql } from 'drizzle-orm';
import { tenantTimezone } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { CATEGORY_OF_PROVIDER, PAUSABLE, categoryLabel, type CostCategory } from '../contracts/costs';
import { usageThresholdReached } from '../contracts/events';
import { paidPause, usageCap, usagePeriod } from '../db/schema';
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

/**
 * What `reserve` holds; pass it to `settle` exactly once after the call (a second settle of the same
 * object is a no-op). `reservationId` is null when the provider has no limit.
 */
export type Reservation =
  | { reservationId: null; level: 'ok' }
  | { reservationId: string; level: CapLevel; providerKey: string; periodStart: string; resetsAt: Date; amount: number };

type CapRow = typeof usageCap.$inferSelect;
type PeriodRow = typeof usagePeriod.$inferSelect;
type Bounds = { start: string; resetsAt: Date };

export const LIMIT_INVALID = 'Enter a whole number of 1 or more.';
/** How long a transaction here waits for a row lock before it fails, rather than hanging. */
export const LOCK_TIMEOUT = '5s';

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

/** Whether `e` is a usage-limit refusal (Ruling 8): a job should wait for the limit (Ruling 10), not record a failure. */
export const isCapWait = (e: unknown): e is ScoutError => e instanceof ScoutError && e.slug === 'blocked_by_cap';

/**
 * R3a Ruling 9: a paid call refused because its cost category is over 110% of this month's budget. It uses the cap
 * slug, so `isCapWait` is true and the worker puts the job back; the flag clears when the budget is raised.
 */
export function budgetPaused(category: CostCategory): ScoutError {
  const label = categoryLabel(category);
  return new ScoutError({
    slug: 'blocked_by_cap',
    status: 429,
    title: `${label} is over its monthly budget.`,
    detail: `${label} is over its monthly budget. An owner or leader can raise it on the Costs page.`,
    extensions: { category },
  });
}

/** The provider's category when it is paused for the tenant month containing `now`, else null. Unpaid providers never are. */
async function pausedCategory(ctx: ModuleContext, providerKey: string, now: Date, timeZone: string): Promise<CostCategory | null> {
  const category = CATEGORY_OF_PROVIDER[providerKey];
  if (!category || !PAUSABLE.has(category)) return null;
  // The current tenant month only: a pause left from an earlier month never blocks this one.
  const month = periodBounds('month', now, timeZone).start.slice(0, 7);
  const [row] = await ctx.tx
    .select({ paused: paidPause.paused })
    .from(paidPause)
    .where(and(eq(paidPause.tenantId, ctx.tenantId), eq(paidPause.category, category), eq(paidPause.month, month)));
  return row?.paused ? category : null;
}

/** Whether the provider's cost category is paused over its budget for the current tenant month (R3a Ruling 9). */
export async function isPaused(ctx: ModuleContext, providerKey: string, now = new Date()): Promise<boolean> {
  if (!CATEGORY_OF_PROVIDER[providerKey]) return false;
  return (await pausedCategory(ctx, providerKey, now, await tenantTimezone(ctx))) !== null;
}

const noCap = (providerKey: string) =>
  new ScoutError({ slug: 'not-found', status: 404, title: `${providerName(providerKey)} has no usage limit.` });

/** Reservations already settled, so a second settle of the same object does nothing. */
const settled = new WeakSet<Reservation>();

/** A whole, non-negative amount; fractions go `up` (reservations) or to the nearest (settled usage). */
function wholeAmount(amount: number, round: (n: number) => number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`usage amount must be a finite number of 0 or more, got ${amount}`);
  return round(amount);
}

const defaultRow = (tenantId: string, providerKey: string): CapRow | undefined => {
  const d = DEFAULT_CAPS[providerKey];
  return d && { tenantId, providerKey, ...d, overagePeriodStart: null, updatedBy: null, updatedAt: new Date() };
};

/**
 * Ruling 2: the defaults are stored the first time a reservation or an owner action needs the row.
 * Reads fall back to `DEFAULT_CAPS` in memory: an insert in the caller's transaction would make the
 * reservation's own transaction wait on it.
 */
async function ensureDefaults(tx: Tx, tenantId: string): Promise<void> {
  await tx
    .insert(usageCap)
    .values(Object.entries(DEFAULT_CAPS).map(([providerKey, c]) => ({ tenantId, providerKey, ...c })))
    .onConflictDoNothing();
}

/** The stored cap, or the default one when none is stored yet. Never writes. */
async function readCap(tx: Tx, tenantId: string, providerKey: string): Promise<CapRow | undefined> {
  const [cap] = await tx
    .select()
    .from(usageCap)
    .where(and(eq(usageCap.tenantId, tenantId), eq(usageCap.providerKey, providerKey)));
  return cap ?? defaultRow(tenantId, providerKey);
}

async function findCap(tx: Tx, tenantId: string, providerKey: string): Promise<CapRow | undefined> {
  await ensureDefaults(tx, tenantId);
  return readCap(tx, tenantId, providerKey);
}

const periodKey = (tenantId: string, providerKey: string, start: string) =>
  and(eq(usagePeriod.tenantId, tenantId), eq(usagePeriod.providerKey, providerKey), eq(usagePeriod.periodStart, start));

const boundsOf = (cap: CapRow, now: Date, timeZone: string) => periodBounds(cap.period as CapPeriod, now, timeZone);

/**
 * Publishes each threshold event `level` reaches that this period has not yet published (Ruling 7):
 * a period that goes straight to blocked publishes warn first, so warn never follows blocked. The row must be locked.
 */
async function notify(ctx: ModuleContext, cap: CapRow, bounds: Bounds, row: PeriodRow, level: CapLevel): Promise<void> {
  const reached = level === 'blocked' ? (['warn', 'blocked'] as const) : level === 'warn' ? (['warn'] as const) : [];
  for (const l of reached) {
    const flag = l === 'warn' ? 'warned' : 'blocked';
    if (row[flag]) continue;
    await ctx.tx
      .update(usagePeriod)
      .set({ [flag]: true })
      .where(periodKey(ctx.tenantId, cap.providerKey, bounds.start));
    await publishThreshold(ctx, cap, bounds, row, l);
  }
}

async function publishThreshold(ctx: ModuleContext, cap: CapRow, bounds: Bounds, row: PeriodRow, level: 'warn' | 'blocked') {
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
  const stored = await ctx.tx.select().from(usageCap).where(eq(usageCap.tenantId, ctx.tenantId));
  const missing = Object.keys(DEFAULT_CAPS)
    .filter((key) => !stored.some((c) => c.providerKey === key))
    .map((key) => defaultRow(ctx.tenantId, key)!);
  const caps = [...stored, ...missing].sort((a, b) => a.providerKey.localeCompare(b.providerKey));
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

/** The unit of the provider's limit, or null when it has none. Never writes. */
export async function capUnit(ctx: ModuleContext, providerKey: string): Promise<CapUnit | null> {
  const cap = await readCap(ctx.tx, ctx.tenantId, providerKey);
  return cap ? (cap.unit as CapUnit) : null;
}

/**
 * Read-only check for estimates: the level `amount` more would reach. No limit reads as ok with `limit` null.
 * A provider whose cost category is paused over its budget reads as blocked, with `paused` naming the category (R3a Ruling 9).
 */
export async function checkCap(
  ctx: ModuleContext,
  providerKey: string,
  amount: number,
  now = new Date(),
): Promise<{ status: CapLevel; used: number; limit: number | null; resetsAt: Date | null; paused?: CostCategory }> {
  const timeZone = await tenantTimezone(ctx);
  const paused = await pausedCategory(ctx, providerKey, now, timeZone);
  const orPaused = (status: CapLevel) => (paused ? { status: 'blocked' as const, paused } : { status });
  const cap = await readCap(ctx.tx, ctx.tenantId, providerKey);
  if (!cap) return { ...orPaused('ok'), used: 0, limit: null, resetsAt: null };
  const b = boundsOf(cap, now, timeZone);
  const [row] = await ctx.tx.select().from(usagePeriod).where(periodKey(ctx.tenantId, providerKey, b.start));
  const used = row?.used ?? 0;
  return {
    ...orPaused(levelOf(used, (row?.reserved ?? 0) + amount, cap.limit, cap.overagePeriodStart === b.start)),
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
export async function reserve(ctx: ModuleContext, providerKey: string, requested: number, now = new Date()): Promise<Reservation> {
  const amount = wholeAmount(requested, Math.ceil);
  const timeZone = await tenantTimezone(ctx);
  const out = await withTenant(ctx.tenantId, async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
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
export async function settle(ctx: ModuleContext, reservation: Reservation, measured: number, tx?: Tx): Promise<void> {
  const actual = wholeAmount(measured, Math.round);
  if (reservation.reservationId === null || settled.has(reservation)) return;
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
  settled.add(reservation);
}

/**
 * Adds usage for a call that reserved nothing because its amount was only known afterwards (its
 * estimate was 0). Never refuses. Pass `tx` to commit with the caller's transaction.
 */
export async function recordUsage(ctx: ModuleContext, providerKey: string, measured: number, tx?: Tx, now = new Date()): Promise<void> {
  const actual = wholeAmount(measured, Math.round);
  if (actual === 0) return;
  const timeZone = await tenantTimezone(ctx);
  const run = async (t: Tx) => {
    const cap = await findCap(t, ctx.tenantId, providerKey);
    if (!cap) return;
    const bounds = boundsOf(cap, now, timeZone);
    await t.insert(usagePeriod).values({ tenantId: ctx.tenantId, providerKey, periodStart: bounds.start }).onConflictDoNothing();
    const [row] = await t
      .update(usagePeriod)
      .set({ used: sql`${usagePeriod.used} + ${actual}` })
      .where(periodKey(ctx.tenantId, providerKey, bounds.start))
      .returning();
    const level = levelOf(row!.used, row!.reserved, cap.limit, cap.overagePeriodStart === bounds.start);
    await notify({ ...ctx, tx: t }, cap, bounds, row!, level);
  };
  await (tx ? run(tx) : withTenant(ctx.tenantId, run));
}

/**
 * Ruling 9: an owner sets the limit, a whole number of 1 or more. Takes effect for the next reservation. A level
 * the current period no longer reaches under the new limit has its flag cleared, so reaching it publishes again.
 */
export async function setCapLimit(ctx: ModuleContext, providerKey: string, limit: number, now = new Date()): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: LIMIT_INVALID,
      errors: [{ path: 'limit', message: LIMIT_INVALID }],
    });
  }
  const cap = await findCap(ctx.tx, ctx.tenantId, providerKey);
  if (!cap) throw noCap(providerKey);
  await ctx.tx
    .update(usageCap)
    .set({ limit, updatedBy: ctx.actor.id, updatedAt: sql`now()` })
    .where(and(eq(usageCap.tenantId, ctx.tenantId), eq(usageCap.providerKey, providerKey)));
  const b = boundsOf(cap, now, await tenantTimezone(ctx));
  const [row] = await ctx.tx.select().from(usagePeriod).where(periodKey(ctx.tenantId, providerKey, b.start)).for('update');
  if (row) {
    const level = levelOf(row.used, row.reserved, limit, cap.overagePeriodStart === b.start);
    const clear = { ...(level === 'ok' && row.warned ? { warned: false } : {}), ...(level !== 'blocked' && row.blocked ? { blocked: false } : {}) };
    if (Object.keys(clear).length > 0) await ctx.tx.update(usagePeriod).set(clear).where(periodKey(ctx.tenantId, providerKey, b.start));
  }
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
