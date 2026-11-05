import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { COST_CATEGORIES, type CostCategory } from '@/modules/integrations/contracts/costs';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { costLine } from '../db/schema';

type Row = typeof costLine.$inferSelect;

export type CostLineView = {
  id: string;
  occurredOn: string;
  category: CostCategory;
  provider: string | null;
  amountCents: number;
  origin: 'usage' | 'manual';
  accountId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  voidedBy: string | null;
  replacesId: string | null;
};

/** A usage line, from one `integrations.usage.recorded` event (Ruling 5). */
export type UsageLineInput = {
  originEventId: string;
  occurredOn: string;
  category: CostCategory;
  provider: string;
  amountCents: number;
  accountId: string | null;
};

export type ManualLineInput = { occurredOn: string; category: CostCategory; amountCents: number; note: string | null };

export type LinesQuery = { category?: CostCategory; from?: string; to?: string; includeVoided?: boolean; cursor?: string; limit?: number };

export const AMOUNT_ABOVE_ZERO = 'Enter an amount above zero.';
export const ONLY_MANUAL = 'Only costs added by hand can be edited.';
export const VOID_REASON_NEEDED = "Say why you're voiding this cost.";
export const MAX_NOTE = 500;
const EDITED = 'Edited';
const OLD_CURSOR = 'That page link is out of date. Start from the first page.';
const KEYS: readonly string[] = COST_CATEGORIES.map((c) => c.key);

const invalid = (path: string, title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });
const conflict = (title: string) => new ScoutError({ slug: 'conflict', status: 409, title });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That cost was not found.' });

const view = (r: Row): CostLineView => ({
  id: r.id,
  occurredOn: r.occurredOn,
  category: r.category as CostCategory,
  provider: r.provider,
  amountCents: r.amountCents,
  origin: r.origin as CostLineView['origin'],
  accountId: r.accountId,
  note: r.note,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  voidedAt: r.voidedAt,
  voidReason: r.voidReason,
  voidedBy: r.voidedBy,
  replacesId: r.replacesId,
});

/**
 * Runs after any line is added or voided, with the category and date it touched. Budget levels hook in
 * here; for now it does nothing.
 */
export async function afterLinesChanged(_ctx: ModuleContext, _category: CostCategory, _occurredOn: string): Promise<void> {}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function checked(input: ManualLineInput): ManualLineInput {
  if (!isDate(input.occurredOn)) throw invalid('occurred_on', 'Enter a date like 2026-11-05.');
  if (!KEYS.includes(input.category)) throw invalid('category', `Category must be one of: ${KEYS.join(', ')}.`);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw invalid('amount_cents', AMOUNT_ABOVE_ZERO);
  const note = input.note?.trim() || null;
  if (note && note.length > MAX_NOTE) throw invalid('note', `Keep the note to ${MAX_NOTE} characters.`);
  return { ...input, note };
}

/** One usage line per event: a redelivered event adds nothing. Null when the line was already there. */
export async function recordLine(ctx: ModuleContext, input: UsageLineInput): Promise<CostLineView | null> {
  const [row] = await ctx.tx
    .insert(costLine)
    .values({
      id: newId('cst'),
      tenantId: ctx.tenantId,
      occurredOn: input.occurredOn,
      category: input.category,
      provider: input.provider,
      amountCents: input.amountCents,
      origin: 'usage',
      originEventId: input.originEventId,
      accountId: input.accountId,
    })
    .onConflictDoNothing({ target: costLine.originEventId })
    .returning();
  if (!row) return null;
  await afterLinesChanged(ctx, input.category, input.occurredOn);
  return view(row);
}

async function insertManual(ctx: ModuleContext, input: ManualLineInput, replacesId: string | null): Promise<Row> {
  const [row] = await ctx.tx
    .insert(costLine)
    .values({
      id: newId('cst'),
      tenantId: ctx.tenantId,
      occurredOn: input.occurredOn,
      category: input.category,
      amountCents: input.amountCents,
      origin: 'manual',
      note: input.note,
      createdBy: ctx.actor.id,
      replacesId,
    })
    .returning();
  return row!;
}

export async function addManualLine(ctx: ModuleContext, input: ManualLineInput): Promise<CostLineView> {
  const row = await insertManual(ctx, checked(input), null);
  await afterLinesChanged(ctx, row.category as CostCategory, row.occurredOn);
  return view(row);
}

/** The line, locked for this change. 404 when missing, 409 when already voided. */
async function openLine(ctx: ModuleContext, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(costLine).where(and(eq(costLine.tenantId, ctx.tenantId), eq(costLine.id, id))).for('update');
  if (!row) throw notFound();
  if (row.voidedAt) throw conflict('This cost was voided, so it can no longer change.');
  return row;
}

async function markVoided(ctx: ModuleContext, id: string, reason: string): Promise<Row> {
  const [row] = await ctx.tx
    .update(costLine)
    .set({ voidedAt: new Date(), voidReason: reason, voidedBy: ctx.actor.id })
    .where(and(eq(costLine.tenantId, ctx.tenantId), eq(costLine.id, id)))
    .returning();
  return row!;
}

/** Lines are never changed in place: the old one is voided "Edited" and a new one replaces it. */
export async function editManualLine(ctx: ModuleContext, id: string, patch: Partial<ManualLineInput>): Promise<CostLineView> {
  const old = await openLine(ctx, id);
  if (old.origin !== 'manual') throw conflict(ONLY_MANUAL);
  const next = checked({
    occurredOn: patch.occurredOn ?? old.occurredOn,
    category: patch.category ?? (old.category as CostCategory),
    amountCents: patch.amountCents ?? old.amountCents,
    note: patch.note !== undefined ? patch.note : old.note,
  });
  // Nothing changed: the line stays as it is.
  if (next.occurredOn === old.occurredOn && next.category === old.category && next.amountCents === old.amountCents && next.note === old.note) return view(old);
  await markVoided(ctx, id, EDITED);
  const row = await insertManual(ctx, next, id);
  await afterLinesChanged(ctx, old.category as CostCategory, old.occurredOn);
  if (row.category !== old.category || row.occurredOn !== old.occurredOn) await afterLinesChanged(ctx, row.category as CostCategory, row.occurredOn);
  return view(row);
}

/** Any line, usage or manual, can be voided with a reason. */
export async function voidLine(ctx: ModuleContext, id: string, reason: string): Promise<CostLineView> {
  const why = reason.trim();
  if (!why) throw invalid('reason', VOID_REASON_NEEDED);
  if (why.length > MAX_NOTE) throw invalid('reason', `Keep the reason to ${MAX_NOTE} characters.`);
  await openLine(ctx, id);
  const row = await markVoided(ctx, id, why);
  await afterLinesChanged(ctx, row.category as CostCategory, row.occurredOn);
  return view(row);
}

/** Lines newest first (by date, then when added), 50 a page. Voided lines only with `includeVoided`. */
export async function listLines(ctx: ModuleContext, q: LinesQuery = {}): Promise<{ data: CostLineView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  if (q.category !== undefined && !KEYS.includes(q.category)) throw invalid('category', `Category must be one of: ${KEYS.join(', ')}.`);
  for (const [path, v] of [['from', q.from], ['to', q.to]] as const) {
    if (v !== undefined && !isDate(v)) throw invalid(path, 'Enter a date like 2026-11-05.');
  }
  if (q.cursor) {
    const [known] = await ctx.tx.select({ id: costLine.id }).from(costLine).where(and(eq(costLine.tenantId, ctx.tenantId), eq(costLine.id, q.cursor)));
    if (!known) throw invalid('cursor', OLD_CURSOR);
  }
  const rows = await ctx.tx
    .select()
    .from(costLine)
    .where(
      and(
        eq(costLine.tenantId, ctx.tenantId),
        q.includeVoided ? undefined : isNull(costLine.voidedAt),
        q.category ? eq(costLine.category, q.category) : undefined,
        q.from ? gte(costLine.occurredOn, q.from) : undefined,
        q.to ? lte(costLine.occurredOn, q.to) : undefined,
        q.cursor
          ? sql`(${costLine.occurredOn}, ${costLine.createdAt}, ${costLine.id}) < (select c.occurred_on, c.created_at, c.id from analytics.cost_line c where c.tenant_id = ${ctx.tenantId} and c.id = ${q.cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(costLine.occurredOn), desc(costLine.createdAt), desc(costLine.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { data: page.map(view), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}
