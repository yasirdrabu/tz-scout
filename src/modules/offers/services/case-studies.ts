import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { caseStudy, offer, offerCaseStudy } from '../db/schema';

export type CaseStudy = typeof caseStudy.$inferSelect;
export type CaseStudyInput = {
  title: string;
  clientName?: string | null;
  industry?: string | null;
  result?: string | null;
  linkUrl?: string | null;
  /** May be quoted to buyers. Defaults to false. */
  public?: boolean;
};

const caseNotFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That case study was not found.' });
const invalidTitle = () =>
  new ScoutError({
    slug: 'validation',
    status: 400,
    title: 'Check the case study.',
    errors: [{ path: 'title', message: 'Add a title.' }],
  });

async function load(ctx: ModuleContext, id: string): Promise<CaseStudy> {
  const [row] = await ctx.tx
    .select()
    .from(caseStudy)
    .where(and(eq(caseStudy.id, id), eq(caseStudy.tenantId, ctx.tenantId)));
  if (!row) throw caseNotFound();
  return row;
}

export async function createCaseStudy(ctx: ModuleContext, input: CaseStudyInput): Promise<CaseStudy> {
  const title = input.title?.trim() ?? '';
  if (!title) throw invalidTitle();
  const [row] = await ctx.tx
    .insert(caseStudy)
    .values({
      id: newId('cs'),
      tenantId: ctx.tenantId,
      title,
      clientName: input.clientName ?? null,
      industry: input.industry ?? null,
      result: input.result ?? null,
      linkUrl: input.linkUrl ?? null,
      public: input.public ?? false,
    })
    .returning();
  return row!;
}

export async function updateCaseStudy(ctx: ModuleContext, id: string, patch: Partial<CaseStudyInput>): Promise<CaseStudy> {
  const before = await load(ctx, id);
  const set: Partial<typeof caseStudy.$inferInsert> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw invalidTitle();
    set.title = patch.title.trim();
  }
  if (patch.clientName !== undefined) set.clientName = patch.clientName;
  if (patch.industry !== undefined) set.industry = patch.industry;
  if (patch.result !== undefined) set.result = patch.result;
  if (patch.linkUrl !== undefined) set.linkUrl = patch.linkUrl;
  if (patch.public !== undefined) set.public = patch.public;
  if (Object.keys(set).length === 0) return before;
  const [row] = await ctx.tx
    .update(caseStudy)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(caseStudy.id, id), eq(caseStudy.tenantId, ctx.tenantId)))
    .returning();
  return row!;
}

/** Hides a case study from future briefs and emails. Records already written keep it, and so do its links. */
export async function archiveCaseStudy(ctx: ModuleContext, id: string): Promise<CaseStudy> {
  const before = await load(ctx, id);
  if (before.archivedAt) return before;
  const [row] = await ctx.tx
    .update(caseStudy)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(caseStudy.id, id), eq(caseStudy.tenantId, ctx.tenantId)))
    .returning();
  return row!;
}

export async function linkCaseStudy(ctx: ModuleContext, offerId: string, caseStudyId: string): Promise<void> {
  const [o] = await ctx.tx
    .select({ id: offer.id })
    .from(offer)
    .where(and(eq(offer.id, offerId), eq(offer.tenantId, ctx.tenantId)));
  if (!o) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That offer was not found.' });
  await load(ctx, caseStudyId);
  await ctx.tx
    .insert(offerCaseStudy)
    .values({ tenantId: ctx.tenantId, offerId, caseStudyId })
    .onConflictDoNothing();
}

export async function unlinkCaseStudy(ctx: ModuleContext, offerId: string, caseStudyId: string): Promise<void> {
  await ctx.tx
    .delete(offerCaseStudy)
    .where(
      and(
        eq(offerCaseStudy.tenantId, ctx.tenantId),
        eq(offerCaseStudy.offerId, offerId),
        eq(offerCaseStudy.caseStudyId, caseStudyId),
      ),
    );
}

/** Case studies, newest first. `offerId` keeps the ones linked to that offer. Archived ones only on request. */
export async function listCaseStudies(
  ctx: ModuleContext,
  opts: { offerId?: string; buyerVisibleOnly?: boolean; includeArchived?: boolean } = {},
): Promise<CaseStudy[]> {
  const linked = opts.offerId
    ? ctx.tx
        .select({ id: offerCaseStudy.caseStudyId })
        .from(offerCaseStudy)
        .where(and(eq(offerCaseStudy.tenantId, ctx.tenantId), eq(offerCaseStudy.offerId, opts.offerId)))
    : null;
  return ctx.tx
    .select()
    .from(caseStudy)
    .where(
      and(
        eq(caseStudy.tenantId, ctx.tenantId),
        linked ? inArray(caseStudy.id, linked) : undefined,
        opts.includeArchived ? undefined : isNull(caseStudy.archivedAt),
        opts.buyerVisibleOnly ? eq(caseStudy.public, true) : undefined,
      ),
    )
    .orderBy(desc(caseStudy.createdAt), desc(caseStudy.id));
}

/**
 * Linked, unarchived case studies for an offer: the ones in `industry` first, then the most recent.
 * `buyerVisibleOnly` keeps only those that may be quoted to buyers (emails, proposals, public report).
 */
export async function matchCaseStudies(
  ctx: ModuleContext,
  offerId: string,
  industry: string | null | undefined,
  limit: number,
  opts: { buyerVisibleOnly?: boolean } = {},
): Promise<CaseStudy[]> {
  const wanted = (industry ?? '').trim().toLowerCase();
  const rows = await listCaseStudies(ctx, { offerId, buyerVisibleOnly: opts.buyerVisibleOnly });
  const sameIndustry = (c: CaseStudy) => wanted !== '' && (c.industry ?? '').trim().toLowerCase() === wanted;
  // Array sort is stable, so the newest-first order from the query holds inside each group.
  return [...rows].sort((a, b) => Number(sameIndustry(b)) - Number(sameIndustry(a))).slice(0, limit);
}
