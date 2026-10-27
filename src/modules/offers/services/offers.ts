import { and, asc, eq, exists, inArray, ne } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { memberRole } from '@/modules/tenancy';
import { offerApproved, offerArchived, offerChanged } from '../contracts/events';
import { offer, offerCaseStudy, practice } from '../db/schema';
import { BUYER_DEFINITION_WARNING, affectsMatching, approvalProblems } from '../domain/approval';
import { slugify } from '../domain/slug';
import { rethrowTaken, slugTaken } from './practices';

export type Offer = typeof offer.$inferSelect;
/** Every field a person can set on an offer. */
export type OfferPatch = Partial<
  Omit<typeof offer.$inferInsert, 'id' | 'tenantId' | 'status' | 'approvedBy' | 'approvedAt' | 'createdAt' | 'updatedAt'>
>;
export type OfferInput = OfferPatch & { name: string; practiceId: string; promise: string };

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That offer was not found.' });
const invalid = (path: string, message: string) =>
  new ScoutError({ slug: 'validation', status: 400, title: 'Check the offer.', errors: [{ path, message }] });

async function load(ctx: ModuleContext, id: string, lock = false): Promise<Offer> {
  const q = ctx.tx
    .select()
    .from(offer)
    .where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)));
  const [row] = await (lock ? q.for('update') : q);
  if (!row) throw notFound();
  return row;
}

async function assertActivePractice(ctx: ModuleContext, practiceId: string, lock = false): Promise<void> {
  const q = ctx.tx
    .select({ id: practice.id })
    .from(practice)
    .where(and(eq(practice.id, practiceId), eq(practice.tenantId, ctx.tenantId), eq(practice.status, 'active')));
  const [row] = await (lock ? q.for('share') : q);
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That practice was not found.' });
}

async function assertSlugFree(ctx: ModuleContext, slug: string, selfId?: string): Promise<void> {
  const [row] = await ctx.tx
    .select({ id: offer.id })
    .from(offer)
    .where(and(eq(offer.tenantId, ctx.tenantId), eq(offer.slug, slug), selfId ? ne(offer.id, selfId) : undefined));
  if (row) throw slugTaken();
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export async function createOffer(ctx: ModuleContext, input: OfferInput): Promise<Offer> {
  const name = input.name?.trim() ?? '';
  if (!name) throw invalid('name', 'Add a name.');
  if (!input.practiceId) throw invalid('practice_id', 'Pick a practice.');
  const promise = input.promise?.trim() ?? '';
  if (!promise) throw invalid('promise', 'Add a promise.');
  await assertActivePractice(ctx, input.practiceId);
  const slug = slugify(input.slug ?? name);
  if (!slug) throw invalid('slug', 'Use letters or numbers in the short name.');
  await assertSlugFree(ctx, slug);

  const [row] = await ctx.tx
    .insert(offer)
    .values({ ...input, id: newId('off'), tenantId: ctx.tenantId, slug, name, promise })
    .returning()
    .catch(rethrowTaken);
  await audit(ctx, { action: 'offers.offer.created', subject: { type: 'offer', id: row!.id }, after: { slug, name } });
  return row!;
}

/**
 * Edits an offer. Changing the buyer definition of an approved offer sends it back to draft and
 * returns `warning` (OFF-E2-S2-AC3). Publishes `offers.offer.changed` when something changed.
 */
export async function updateOffer(
  ctx: ModuleContext,
  id: string,
  patch: OfferPatch,
): Promise<{ offer: Offer; warning?: string }> {
  const before = await load(ctx, id, true);
  if (before.status === 'archived') {
    throw new ScoutError({ slug: 'offer-archived', status: 409, title: 'An archived offer cannot be edited.' });
  }
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  if (typeof set.name === 'string') {
    set.name = set.name.trim();
    if (!set.name) throw invalid('name', 'Add a name.');
  }
  if (typeof set.promise === 'string') {
    set.promise = set.promise.trim();
    if (!set.promise) throw invalid('promise', 'Add a promise.');
  }
  if (typeof set.slug === 'string') {
    set.slug = slugify(set.slug);
    if (!set.slug) throw invalid('slug', 'Use letters or numbers in the short name.');
  }
  const prev = before as Record<string, unknown>;
  const changed = Object.keys(set).filter((k) => JSON.stringify(set[k]) !== JSON.stringify(prev[k]));
  if (changed.length === 0) return { offer: before };

  if (changed.includes('slug')) await assertSlugFree(ctx, set.slug as string, id);
  if (changed.includes('practiceId')) await assertActivePractice(ctx, set.practiceId as string);

  const buyerEdit = affectsMatching(set, prev);
  const backToDraft = buyerEdit && before.status === 'approved';
  const [row] = await ctx.tx
    .update(offer)
    .set({
      ...set,
      ...(backToDraft ? { status: 'draft', approvedBy: null, approvedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)))
    .returning()
    .catch(rethrowTaken);

  const subject = { type: 'offer', id };
  await publish(
    ctx,
    offerChanged,
    {
      offerId: id,
      practiceId: row!.practiceId,
      changed: backToDraft ? [...changed, 'status'] : changed,
      affectsMatching: buyerEdit,
    },
    subject,
  );
  await audit(ctx, {
    action: 'offers.offer.updated',
    subject,
    before: pick(prev, changed),
    after: pick(row as Record<string, unknown>, backToDraft ? [...changed, 'status'] : changed),
  });
  return backToDraft ? { offer: row!, warning: BUYER_DEFINITION_WARNING } : { offer: row! };
}

/** Approves a draft offer. Needs a person with the owner role; API keys cannot approve. */
export async function approveOffer(ctx: ModuleContext, id: string): Promise<Offer> {
  const role = ctx.actor.kind === 'user' ? await memberRole(ctx, ctx.actor.id) : null;
  if (role !== 'owner') {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only an owner can approve an offer.' });
  }
  const before = await load(ctx, id, true);
  if (before.status === 'approved') return before;
  if (before.status === 'archived') {
    throw new ScoutError({ slug: 'offer-archived', status: 409, title: 'An archived offer cannot be approved.' });
  }
  // A share lock keeps the practice from being archived until this transaction ends.
  await assertActivePractice(ctx, before.practiceId, true);
  const problems = approvalProblems(before);
  if (problems.length > 0) {
    throw new ScoutError({
      slug: 'offer-incomplete',
      status: 400,
      title: 'This offer is not ready to approve.',
      errors: problems.map((message) => ({ path: 'offer', message })),
    });
  }
  const [row] = await ctx.tx
    .update(offer)
    .set({ status: 'approved', approvedBy: ctx.actor.id, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)))
    .returning();
  const subject = { type: 'offer', id };
  await publish(ctx, offerApproved, { offerId: id, practiceId: row!.practiceId, approvedBy: ctx.actor.id }, subject);
  await audit(ctx, { action: 'offers.offer.approved', subject, before: { status: before.status }, after: { status: 'approved' } });
  return row!;
}

export async function archiveOffer(ctx: ModuleContext, id: string): Promise<Offer> {
  const before = await load(ctx, id, true);
  if (before.status === 'archived') return before;
  const [row] = await ctx.tx
    .update(offer)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)))
    .returning();
  const subject = { type: 'offer', id };
  await publish(ctx, offerArchived, { offerId: id, practiceId: row!.practiceId }, subject);
  await audit(ctx, { action: 'offers.offer.archived', subject, before: { status: before.status }, after: { status: 'archived' } });
  return row!;
}

export function getOffer(ctx: ModuleContext, id: string): Promise<Offer> {
  return load(ctx, id);
}

export async function listOffers(
  ctx: ModuleContext,
  opts: { practiceId?: string; status?: Offer['status'] | Offer['status'][]; caseStudyId?: string } = {},
): Promise<Offer[]> {
  const statuses = opts.status === undefined ? undefined : Array.isArray(opts.status) ? opts.status : [opts.status];
  return ctx.tx
    .select()
    .from(offer)
    .where(
      and(
        eq(offer.tenantId, ctx.tenantId),
        opts.practiceId ? eq(offer.practiceId, opts.practiceId) : undefined,
        statuses ? inArray(offer.status, statuses) : undefined,
        opts.caseStudyId
          ? exists(
              ctx.tx
                .select({ one: offerCaseStudy.offerId })
                .from(offerCaseStudy)
                .where(and(eq(offerCaseStudy.offerId, offer.id), eq(offerCaseStudy.caseStudyId, opts.caseStudyId))),
            )
          : undefined,
      ),
    )
    .orderBy(asc(offer.name), asc(offer.id));
}
