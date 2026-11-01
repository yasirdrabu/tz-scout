import { and, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { offerArchived } from '../contracts/events';
import { offerUsages } from '../contracts/ports';
import { offer, offerCaseStudy, signalRule } from '../db/schema';

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That offer was not found.' });

/** True when no module keeps anything that names the offer: never matched, never a lead offer (Ruling 12). */
async function neverUsed(ctx: ModuleContext, offerId: string): Promise<boolean> {
  for (const u of offerUsages()) if (await u.hasHistory(ctx, offerId)) return false;
  return true;
}

/** Whether `DELETE /offers/{id}` would go ahead, for the offer view's Retire or Delete choice. */
export async function offerCanDelete(ctx: ModuleContext, offerId: string): Promise<boolean> {
  return neverUsed(ctx, offerId);
}

/**
 * Deletes an offer that never matched an account and was never a lead offer, with its signal rules and
 * case-study links (Ruling 12). Otherwise 409 `offer-has-history`: it can only be retired. An approved offer
 * also publishes `offers.offer.archived`, so a rescore that read it before this commits drops what it wrote.
 */
export async function deleteOffer(ctx: ModuleContext, id: string): Promise<void> {
  const [row] = await ctx.tx
    .select()
    .from(offer)
    .where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)))
    .for('update');
  if (!row) throw notFound();
  if (!(await neverUsed(ctx, id))) {
    throw new ScoutError({ slug: 'offer-has-history', status: 409, title: `${row.name} has matched accounts, so it can only be retired.` });
  }
  const mine = <T extends typeof signalRule | typeof offerCaseStudy>(t: T) => and(eq(t.tenantId, ctx.tenantId), eq(t.offerId, id));
  await ctx.tx.delete(signalRule).where(mine(signalRule));
  await ctx.tx.delete(offerCaseStudy).where(mine(offerCaseStudy));
  await ctx.tx.delete(offer).where(and(eq(offer.id, id), eq(offer.tenantId, ctx.tenantId)));
  const subject = { type: 'offer', id };
  if (row.status === 'approved') await publish(ctx, offerArchived, { offerId: id, practiceId: row.practiceId }, subject);
  await audit(ctx, { action: 'offers.offer.deleted', subject, before: { slug: row.slug, name: row.name, status: row.status } });
}
