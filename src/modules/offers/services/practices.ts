import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { memberRole, userNames } from '@/modules/tenancy';
import { practiceChanged } from '../contracts/events';
import { offer, practice } from '../db/schema';
import { slugify } from '../domain/slug';

export type Practice = typeof practice.$inferSelect;
export type PracticeInput = {
  name: string;
  slug?: string;
  description?: string | null;
  keywords?: string[];
  defaultPlaybookId?: string | null;
  briefTemplateKey?: string | null;
  sort?: number;
  /** A member of the workspace, shown as "Led by {name}"; null for none. */
  leadUserId?: string | null;
};
/** A practice with its lead's name and how many offers it has that are not retired. */
export type PracticeView = Practice & { leadName: string | null; offerCount: number };

export const slugTaken = () => new ScoutError({ slug: 'slug-taken', status: 409, title: 'That short name is taken.' });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That practice was not found.' });
const invalid = (path: string, message: string) =>
  new ScoutError({ slug: 'validation', status: 400, title: 'Check the practice.', errors: [{ path, message }] });

/** SQLSTATE 23505, whether the driver error is wrapped or not. */
export function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x as { code?: string } | null | undefined)?.code;
  return code(e) === '23505' || code((e as { cause?: unknown } | null)?.cause) === '23505';
}

async function load(ctx: ModuleContext, id: string, lock = false): Promise<Practice> {
  const q = ctx.tx
    .select()
    .from(practice)
    .where(and(eq(practice.id, id), eq(practice.tenantId, ctx.tenantId)));
  const [row] = await (lock ? q.for('update') : q);
  if (!row) throw notFound();
  return row;
}

async function assertSlugFree(ctx: ModuleContext, slug: string, selfId?: string): Promise<void> {
  const [row] = await ctx.tx
    .select({ id: practice.id })
    .from(practice)
    .where(and(eq(practice.tenantId, ctx.tenantId), eq(practice.slug, slug), selfId ? ne(practice.id, selfId) : undefined));
  if (row) throw slugTaken();
}

export const rethrowTaken = (e: unknown): never => {
  throw isUniqueViolation(e) ? slugTaken() : e;
};
const pick = (o: Practice, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k as keyof Practice]]));
/** The lead must be a member of the workspace. */
async function checkLead(ctx: ModuleContext, userId: string | null | undefined): Promise<void> {
  if (userId && !(await memberRole(ctx, userId))) throw invalid('lead_user_id', 'That person is not a member of this workspace.');
}
const cleanKeywords = (keywords: string[]) => [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];

export async function createPractice(ctx: ModuleContext, input: PracticeInput): Promise<Practice> {
  const name = input.name.trim();
  if (!name) throw invalid('name', 'Add a name.');
  const slug = slugify(input.slug ?? name);
  if (!slug) throw invalid('slug', 'Use letters or numbers in the short name.');
  await assertSlugFree(ctx, slug);
  await checkLead(ctx, input.leadUserId);
  const [row] = await ctx.tx
    .insert(practice)
    .values({
      id: newId('prc'),
      tenantId: ctx.tenantId,
      slug,
      name,
      description: input.description ?? null,
      keywords: cleanKeywords(input.keywords ?? []),
      defaultPlaybookId: input.defaultPlaybookId ?? null,
      briefTemplateKey: input.briefTemplateKey ?? null,
      sort: input.sort ?? 0,
      leadUserId: input.leadUserId ?? null,
    })
    .returning()
    .catch(rethrowTaken);
  const subject = { type: 'practice', id: row!.id };
  await publish(ctx, practiceChanged, { practiceId: row!.id, changed: ['created'] }, subject);
  await audit(ctx, { action: 'offers.practice.created', subject, after: { slug, name } });
  return row!;
}

export async function updatePractice(
  ctx: ModuleContext,
  id: string,
  patch: Partial<PracticeInput>,
): Promise<Practice> {
  const before = await load(ctx, id);
  const set: Partial<typeof practice.$inferInsert> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw invalid('name', 'Add a name.');
    set.name = patch.name.trim();
  }
  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug);
    if (!slug) throw invalid('slug', 'Use letters or numbers in the short name.');
    set.slug = slug;
  }
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.keywords !== undefined) set.keywords = cleanKeywords(patch.keywords);
  if (patch.defaultPlaybookId !== undefined) set.defaultPlaybookId = patch.defaultPlaybookId;
  if (patch.briefTemplateKey !== undefined) set.briefTemplateKey = patch.briefTemplateKey;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.leadUserId !== undefined) {
    await checkLead(ctx, patch.leadUserId);
    set.leadUserId = patch.leadUserId;
  }

  const changed = Object.keys(set).filter(
    (k) => JSON.stringify(set[k as keyof typeof set]) !== JSON.stringify(before[k as keyof Practice]),
  );
  if (changed.length === 0) return before;
  if (set.slug !== undefined && set.slug !== before.slug) await assertSlugFree(ctx, set.slug, id);

  const [row] = await ctx.tx
    .update(practice)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(practice.id, id), eq(practice.tenantId, ctx.tenantId)))
    .returning()
    .catch(rethrowTaken);
  const subject = { type: 'practice', id };
  await publish(ctx, practiceChanged, { practiceId: id, changed }, subject);
  await audit(ctx, { action: 'offers.practice.updated', subject, before: pick(before, changed), after: pick(row!, changed) });
  return row!;
}

/** Archives a practice. Blocked while it still has approved offers. */
export async function archivePractice(ctx: ModuleContext, id: string): Promise<Practice> {
  // The row lock serialises with approveOffer, which locks the practice FOR SHARE.
  const before = await load(ctx, id, true);
  if (before.status === 'archived') return before;
  const [blocking] = await ctx.tx
    .select({ id: offer.id })
    .from(offer)
    .where(and(eq(offer.tenantId, ctx.tenantId), eq(offer.practiceId, id), eq(offer.status, 'approved')))
    .limit(1);
  if (blocking) {
    throw new ScoutError({ slug: 'practice-has-offers', status: 409, title: 'Retire or move its active offers first.' });
  }
  const [row] = await ctx.tx
    .update(practice)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(practice.id, id), eq(practice.tenantId, ctx.tenantId)))
    .returning();
  const subject = { type: 'practice', id };
  await publish(ctx, practiceChanged, { practiceId: id, changed: ['status'] }, subject);
  await audit(ctx, { action: 'offers.practice.archived', subject, before: { status: before.status }, after: { status: 'archived' } });
  return row!;
}

export async function listPractices(ctx: ModuleContext, opts: { includeArchived?: boolean } = {}): Promise<Practice[]> {
  return ctx.tx
    .select()
    .from(practice)
    .where(and(eq(practice.tenantId, ctx.tenantId), opts.includeArchived ? undefined : eq(practice.status, 'active')))
    .orderBy(asc(practice.sort), asc(practice.name));
}

/** Adds each practice's lead name and its count of offers that are not retired. */
export async function practiceViews(ctx: ModuleContext, rows: Practice[]): Promise<PracticeView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((p) => p.id);
  const counts = await ctx.tx
    .select({ practiceId: offer.practiceId, n: count() })
    .from(offer)
    .where(and(eq(offer.tenantId, ctx.tenantId), inArray(offer.practiceId, ids), ne(offer.status, 'archived')))
    .groupBy(offer.practiceId);
  const byPractice = new Map(counts.map((c) => [c.practiceId, c.n]));
  const names = await userNames(ctx, rows.flatMap((p) => (p.leadUserId ? [p.leadUserId] : [])));
  return rows.map((p) => ({
    ...p,
    leadName: p.leadUserId ? (names.get(p.leadUserId) ?? null) : null,
    offerCount: byPractice.get(p.id) ?? 0,
  }));
}

export async function listPracticeViews(ctx: ModuleContext, opts: { includeArchived?: boolean } = {}): Promise<PracticeView[]> {
  return practiceViews(ctx, await listPractices(ctx, opts));
}

/** One practice, archived ones too; another tenant's is a 404. */
export async function getPractice(ctx: ModuleContext, id: string): Promise<PracticeView> {
  return (await practiceViews(ctx, [await load(ctx, id)]))[0]!;
}

const NO_HINT = new Set(['', 'null', 'unknown']);

/**
 * Finds the practice a hint points at: id, slug, name (case-insensitive), then a keyword contained in
 * the hint. When several keywords match, the longest wins, then `sort`. Archived practices never match.
 */
export async function resolvePractice(ctx: ModuleContext, hint: string | null | undefined): Promise<string | null> {
  const h = (hint ?? '').trim();
  if (NO_HINT.has(h.toLowerCase())) return null;
  const lower = h.toLowerCase();
  const active = await ctx.tx
    .select()
    .from(practice)
    .where(and(eq(practice.tenantId, ctx.tenantId), eq(practice.status, 'active')))
    .orderBy(asc(practice.sort), asc(practice.id));

  const exact =
    active.find((p) => p.id === h) ??
    active.find((p) => p.slug === lower) ??
    active.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact.id;

  let best: { id: string; len: number } | null = null;
  for (const p of active) {
    // `active` is already ordered by sort, so the first practice to reach a length keeps it.
    for (const k of p.keywords) {
      const kw = k.trim().toLowerCase();
      if (kw && lower.includes(kw) && (!best || kw.length > best.len)) best = { id: p.id, len: kw.length };
    }
  }
  return best?.id ?? null;
}
