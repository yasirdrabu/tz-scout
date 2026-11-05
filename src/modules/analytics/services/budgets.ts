import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { COST_CATEGORIES, PAUSABLE, type CostCategory } from '@/modules/integrations/contracts/costs';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { budgetLevelChanged } from '../contracts/events';
import { budgetState, costBudget, costLine } from '../db/schema';
import { addDays, addMonths, budgetFor, dayOf, isMonth, levelOf, monthOf, monthsBack, type BudgetLevel } from '../domain/budgets';

export const PAST_MONTH = "Past months can't be changed.";
const KEYS: readonly string[] = COST_CATEGORIES.map((c) => c.key);

const invalid = (path: string, title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });

export type BudgetsView = {
  month: string;
  totalCents: number;
  budgets: { category: CostCategory; label: string; amountCents: number | null; pausable: boolean }[];
};

export type CostsSummary = {
  month: string;
  spendMonthCents: number;
  budgetMonthCents: number;
  spend90dCents: number;
  categories: { key: CostCategory; label: string; spend90dCents: number; spendMonthCents: number; budgetCents: number | null; level: BudgetLevel; pausable: boolean }[];
  months: { month: string; spendCents: number; budgetCents: number }[];
};

/** The current calendar month in the tenant timezone. */
export const currentMonth = async (ctx: ModuleContext, now = new Date()) => monthOf(now, await tenantTimezone(ctx));

const budgetRows = (ctx: ModuleContext) =>
  ctx.tx.select({ category: costBudget.category, month: costBudget.month, amountCents: costBudget.amountCents }).from(costBudget).where(eq(costBudget.tenantId, ctx.tenantId));

function checkMonth(month: string): string {
  if (!isMonth(month)) throw invalid('month', 'Enter a month like 2026-11.');
  return month;
}

/** Each category's budget for a month (the current one by default), carried forward where the month has no row. */
export async function getBudgets(ctx: ModuleContext, month?: string): Promise<BudgetsView> {
  const m = month === undefined ? await currentMonth(ctx) : checkMonth(month);
  const rows = await budgetRows(ctx);
  const budgets = COST_CATEGORIES.map((c) => ({ category: c.key, label: c.label, amountCents: budgetFor(rows, c.key, m), pausable: PAUSABLE.has(c.key) }));
  return { month: m, totalCents: budgets.reduce((s, b) => s + (b.amountCents ?? 0), 0), budgets };
}

/**
 * Writes a month's budgets (Ruling 7). The current and future months can be saved; a past month is a 409.
 * Saving the current month recomputes every category's level.
 */
export async function saveBudgets(ctx: ModuleContext, month: string, budgets: { category: CostCategory; amountCents: number }[]): Promise<BudgetsView> {
  checkMonth(month);
  const byCategory = new Map<CostCategory, number>();
  for (const b of budgets) {
    if (!KEYS.includes(b.category)) throw invalid('budgets.category', `Category must be one of: ${KEYS.join(', ')}.`);
    if (!Number.isSafeInteger(b.amountCents) || b.amountCents < 0) throw invalid('budgets.amount_cents', "A budget can't be negative.");
    byCategory.set(b.category, b.amountCents);
  }
  const current = await currentMonth(ctx);
  if (month < current) throw new ScoutError({ slug: 'conflict', status: 409, title: PAST_MONTH });
  if (byCategory.size > 0) {
    await ctx.tx
      .insert(costBudget)
      .values([...byCategory].map(([category, amountCents]) => ({ tenantId: ctx.tenantId, category, month, amountCents })))
      .onConflictDoUpdate({ target: [costBudget.tenantId, costBudget.category, costBudget.month], set: { amountCents: sql`excluded.amount_cents` } });
  }
  // A future month's row can't change this month's budget: only an earlier row carries forward.
  // Sorted, so two transactions locking several state rows take them in the same order.
  if (month === current) for (const c of [...byCategory.keys()].sort()) await recomputeLevel(ctx, c, current);
  return getBudgets(ctx, month);
}

/** Non-voided spend per category for `[from, to)` (dates). */
const spendWhere = (ctx: ModuleContext, from: string, to: string) =>
  and(eq(costLine.tenantId, ctx.tenantId), isNull(costLine.voidedAt), gte(costLine.occurredOn, from), lt(costLine.occurredOn, to));

/**
 * Works out a category's level for a month and stores it; publishes `analytics.budget.level_changed`
 * when it changed (Ruling 8). The month's `budget_state` row is locked first, so two changes landing at
 * once take turns: the second reads the first's line and level, and a change is published once.
 * A month with no stored level starts from `ok`.
 */
export async function recomputeLevel(ctx: ModuleContext, category: CostCategory, month: string): Promise<BudgetLevel> {
  await ctx.tx.insert(budgetState).values({ tenantId: ctx.tenantId, category, month, level: 'ok' }).onConflictDoNothing();
  const key = and(eq(budgetState.tenantId, ctx.tenantId), eq(budgetState.category, category), eq(budgetState.month, month));
  const [state] = await ctx.tx.select({ level: budgetState.level }).from(budgetState).where(key).for('update');
  const [{ spent } = { spent: 0 }] = await ctx.tx
    .select({ spent: sql<number>`coalesce(sum(${costLine.amountCents}), 0)::bigint`.mapWith(Number) })
    .from(costLine)
    .where(and(spendWhere(ctx, `${month}-01`, `${addMonths(month, 1)}-01`), eq(costLine.category, category)));
  const budget = budgetFor(await budgetRows(ctx), category, month);
  const level = levelOf(spent, budget, PAUSABLE.has(category));
  if (level === state!.level) return level;
  await ctx.tx.update(budgetState).set({ level, updatedAt: new Date() }).where(key);
  await publish(ctx, budgetLevelChanged, { category, month, level, spentCents: spent, budgetCents: budget }, { type: 'cost_budget', id: category });
  return level;
}

/** Ruling 8: a line added or voided recomputes its category's level, but only when it is dated in the current tenant month. */
export async function recomputeForLine(ctx: ModuleContext, category: CostCategory, occurredOn: string): Promise<void> {
  const current = await currentMonth(ctx);
  if (occurredOn.slice(0, 7) === current) await recomputeLevel(ctx, category, current);
}

/** The Costs summary (Ruling 11): tiles, per-category spend and levels, and the last 6 months against the summed budgets. */
export async function summary(ctx: ModuleContext, now: Date = new Date()): Promise<CostsSummary> {
  const tz = await tenantTimezone(ctx);
  const month = monthOf(now, tz);
  const today = dayOf(now, tz);
  const since90 = addDays(today, -89);
  const months = monthsBack(month, 6);
  const rows = await ctx.tx
    .select({
      category: costLine.category,
      month: sql<string>`to_char(${costLine.occurredOn}, 'YYYY-MM')`,
      cents: sql<number>`sum(${costLine.amountCents})::bigint`.mapWith(Number),
      cents90: sql<number>`coalesce(sum(${costLine.amountCents}) filter (where ${costLine.occurredOn} >= ${since90} and ${costLine.occurredOn} <= ${today}), 0)::bigint`.mapWith(Number),
    })
    .from(costLine)
    // Six months back always starts before the 90 days do.
    .where(spendWhere(ctx, `${months[0]}-01`, `${addMonths(month, 1)}-01`))
    .groupBy(costLine.category, sql`2`);
  const budgets = await budgetRows(ctx);
  const sum = (pick: (r: (typeof rows)[number]) => boolean, f: 'cents' | 'cents90') => rows.filter(pick).reduce((s, r) => s + r[f], 0);
  const budgetOfMonth = (m: string) => COST_CATEGORIES.reduce((s, c) => s + (budgetFor(budgets, c.key, m) ?? 0), 0);
  const categories = COST_CATEGORIES.map((c) => {
    const spendMonthCents = sum((r) => r.category === c.key && r.month === month, 'cents');
    const budgetCents = budgetFor(budgets, c.key, month);
    const pausable = PAUSABLE.has(c.key);
    return { key: c.key, label: c.label, spend90dCents: sum((r) => r.category === c.key, 'cents90'), spendMonthCents, budgetCents, level: levelOf(spendMonthCents, budgetCents, pausable), pausable };
  });
  return {
    month,
    spendMonthCents: sum((r) => r.month === month, 'cents'),
    budgetMonthCents: budgetOfMonth(month),
    spend90dCents: sum(() => true, 'cents90'),
    categories,
    months: months.map((m) => ({ month: m, spendCents: sum((r) => r.month === m, 'cents'), budgetCents: budgetOfMonth(m) })),
  };
}
