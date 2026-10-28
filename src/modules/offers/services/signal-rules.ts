import { and, asc, eq, inArray } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { offerChanged } from '../contracts/events';
import { offer, signalRule } from '../db/schema';
import { defaultSignalRulesFor, signalRuleProblems, type SignalRuleInput } from '../domain/signal-rules';
import type { Offer } from './offers';

export type SignalRule = typeof signalRule.$inferSelect;
export type ApprovedOffer = Offer & { signalRules: SignalRule[] };

const clean = (r: SignalRuleInput): SignalRuleInput => ({
  ...r,
  label: r.label.trim(),
  why: r.why.trim(),
  match: r.match.map((k) => k.trim()).filter(Boolean),
});

async function lockOffer(ctx: ModuleContext, offerId: string): Promise<Offer> {
  const [row] = await ctx.tx
    .select()
    .from(offer)
    .where(and(eq(offer.id, offerId), eq(offer.tenantId, ctx.tenantId)))
    .for('update');
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That offer was not found.' });
  return row;
}

export async function listSignalRules(ctx: ModuleContext, offerId: string): Promise<SignalRule[]> {
  return ctx.tx
    .select()
    .from(signalRule)
    .where(and(eq(signalRule.tenantId, ctx.tenantId), eq(signalRule.offerId, offerId)))
    .orderBy(asc(signalRule.sort), asc(signalRule.id));
}

/** Writes the rules for an offer with no check on the offer row, for seeding and the two public writers. */
async function insertRules(ctx: ModuleContext, offerId: string, rules: SignalRuleInput[], origin: 'default' | 'manual') {
  if (rules.length === 0) return;
  await ctx.tx.insert(signalRule).values(
    rules.map((r, sort) => ({ ...r, id: newId('sr'), tenantId: ctx.tenantId, offerId, origin, sort })),
  );
}

async function replace(
  ctx: ModuleContext,
  offerId: string,
  rules: SignalRuleInput[],
  origin: 'default' | 'manual',
  action: string,
): Promise<SignalRule[]> {
  const row = await lockOffer(ctx, offerId);
  const before = await listSignalRules(ctx, offerId);
  await ctx.tx.delete(signalRule).where(and(eq(signalRule.tenantId, ctx.tenantId), eq(signalRule.offerId, offerId)));
  await insertRules(ctx, offerId, rules, origin);
  const subject = { type: 'offer', id: offerId };
  await publish(
    ctx,
    offerChanged,
    { offerId, practiceId: row.practiceId, changed: ['signal_rules'], affectsMatching: true },
    subject,
  );
  await audit(ctx, { action, subject, before: { count: before.length }, after: { count: rules.length } });
  return listSignalRules(ctx, offerId);
}

/** Replaces an offer's rules with exactly these, in this order. Refuses the whole set if any rule has a problem. */
export async function replaceSignalRules(ctx: ModuleContext, offerId: string, input: SignalRuleInput[]): Promise<SignalRule[]> {
  const rules = input.map(clean);
  const problems = signalRuleProblems(rules);
  if (problems.length > 0) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the signal rules.', errors: problems });
  }
  return replace(ctx, offerId, rules, 'manual', 'offers.signal_rules.replaced');
}

/** Restores the offer's own default set, or the generic set when its slug has none. */
export async function resetSignalRules(ctx: ModuleContext, offerId: string): Promise<SignalRule[]> {
  const [row] = await ctx.tx
    .select({ slug: offer.slug })
    .from(offer)
    .where(and(eq(offer.id, offerId), eq(offer.tenantId, ctx.tenantId)));
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That offer was not found.' });
  const rules = defaultSignalRulesFor(row.slug).map((r) => ({ ...r, enabled: true }));
  return replace(ctx, offerId, rules, 'default', 'offers.signal_rules.reset');
}

/** Gives an offer its default rules when it has none yet. Used by the seed; publishes nothing. */
export async function seedSignalRules(ctx: ModuleContext, offerId: string, slug: string): Promise<void> {
  const have = await ctx.tx
    .select({ id: signalRule.id })
    .from(signalRule)
    .where(and(eq(signalRule.tenantId, ctx.tenantId), eq(signalRule.offerId, offerId)))
    .limit(1);
  if (have.length > 0) return;
  await insertRules(ctx, offerId, defaultSignalRulesFor(slug).map((r) => ({ ...r, enabled: true })), 'default');
}

/** Gives every offer that has no rules its defaults (OFF-E4). Idempotent. Returns how many offers it seeded. */
export async function seedMissingSignalRules(ctx: ModuleContext): Promise<number> {
  const have = new Set(
    (await ctx.tx.selectDistinct({ id: signalRule.offerId }).from(signalRule).where(eq(signalRule.tenantId, ctx.tenantId))).map((r) => r.id),
  );
  const offers = await ctx.tx.select({ id: offer.id, slug: offer.slug }).from(offer).where(eq(offer.tenantId, ctx.tenantId)).orderBy(asc(offer.id));
  let seeded = 0;
  for (const o of offers) {
    if (have.has(o.id)) continue;
    await seedSignalRules(ctx, o.id, o.slug);
    seeded++;
  }
  return seeded;
}

/**
 * Approved offers with their fit criteria and enabled rules, oldest approval first. An empty or
 * missing `practiceIds` means every practice.
 */
export async function listApprovedOffers(ctx: ModuleContext, opts: { practiceIds?: string[] } = {}): Promise<ApprovedOffer[]> {
  const offers = await ctx.tx
    .select()
    .from(offer)
    .where(
      and(
        eq(offer.tenantId, ctx.tenantId),
        eq(offer.status, 'approved'),
        opts.practiceIds?.length ? inArray(offer.practiceId, opts.practiceIds) : undefined,
      ),
    )
    .orderBy(asc(offer.approvedAt), asc(offer.id));
  if (offers.length === 0) return [];
  const rules = await ctx.tx
    .select()
    .from(signalRule)
    .where(
      and(
        eq(signalRule.tenantId, ctx.tenantId),
        eq(signalRule.enabled, true),
        inArray(
          signalRule.offerId,
          offers.map((o) => o.id),
        ),
      ),
    )
    .orderBy(asc(signalRule.sort), asc(signalRule.id));
  return offers.map((o) => ({ ...o, signalRules: rules.filter((r) => r.offerId === o.id) }));
}
