import { and, eq, sql } from 'drizzle-orm';
import { getAccountForScoring, resolveAccountId, type ScoringView } from '@/modules/accounts';
import { bestTrustForAccounts, getWarmIntro } from '@/modules/intake';
import { listApprovedOffers, type ApprovedOffer } from '@/modules/offers';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { accountScored } from '../contracts/events';
import type { Match, ScoreCause, ScoringAccount, ScoringOffer, ScoringSignal, Tier, TierReason } from '../contracts/types';
import { accountScore, offerMatch, scoreChange } from '../db/schema';
import { bestOffer } from '../domain/best-offer';
import { matchTotal } from '../domain/combine';
import { buildExplanation, NO_OFFER_TEXT, type Explanation } from '../domain/explain';
import { fit } from '../domain/fit';
import { inputsHash } from '../domain/inputs-hash';
import { intent } from '../domain/intent';
import { priority } from '../domain/priority';
import { applyFloors, tierFor } from '../domain/tiers';
import { getProfile, type ProfileView } from './profile';

export type AccountScore = typeof accountScore.$inferSelect;

/** `profile` and `offers` let a rescore job load them once for many accounts. `alsoAccountIds` are accounts just merged into this one, whose warm intro and source chains count too. `now` is for tests. */
export type ScoreOptions = { now?: Date; profile?: ProfileView; offers?: ApprovedOffer[]; alsoAccountIds?: string[] };

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });

/** The scoring aggregate's consistency boundary: a transaction-scoped advisory lock per resolved account id. */
async function lockScoring(ctx: ModuleContext, accountId: string): Promise<void> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':scoring:' || ${accountId}))`);
}

const toScoringAccount = (v: ScoringView): ScoringAccount => ({
  domain: v.domain ?? '',
  industry: v.industry,
  industryKey: v.industryKey,
  employees: v.employees,
  revenueCents: v.revenueCents,
  country: v.hqCountry,
  technologies: v.technologies,
  headcountGrowth6m: v.headcountGrowth6m,
  excluded: v.excludedReasonKey && !v.excludedOverride ? { label: v.excludedLabel ?? v.excludedReasonKey } : null,
  people: v.people.map((p) => ({ title: p.title, roleKeys: p.roles.map((r) => r.key) })),
});

const toScoringSignals = (v: ScoringView): ScoringSignal[] =>
  v.signals.map((s) => ({
    id: s.id,
    type: s.type,
    kind: s.kind,
    title: s.title,
    detail: s.detail,
    value: typeof s.value === 'number' ? s.value : null,
    occurredAt: s.occurredAt,
    recordedAt: s.recordedAt,
  }));

const toScoringOffer = (o: ApprovedOffer): ScoringOffer => ({
  id: o.id,
  industries: o.industries,
  excludedCategories: o.excludedCategories,
  excludedDomains: o.excludedDomains,
  companySizeMin: o.companySizeMin,
  companySizeMax: o.companySizeMax,
  revenueMinCents: o.revenueMinCents,
  revenueMaxCents: o.revenueMaxCents,
  regions: o.regions,
  targetTitles: o.targetTitles,
  targetBuyingRoles: o.targetBuyingRoles,
  rules: o.signalRules.map((r) => ({
    id: r.id,
    type: r.type,
    label: r.label,
    weight: r.weight,
    match: r.match,
    minValue: r.minValue,
    why: r.why,
    enabled: r.enabled,
  })),
});

/** The calendar day of `d` in `timeZone`, for "the same day". */
const dayIn = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);

/**
 * Scores one account against its approved offers and stores the result. A merged id follows the survivor,
 * and the scoring lock is taken on the survivor before anything is read. Inputs unchanged on the same day
 * (tenant timezone) write and publish nothing.
 */
export async function scoreAccount(
  ctx: ModuleContext,
  accountId: string,
  cause: ScoreCause,
  causeEventId?: string,
  opts: ScoreOptions = {},
): Promise<{ changed: boolean; score: AccountScore }> {
  const now = opts.now ?? new Date();
  const resolved = await resolveAccountId(ctx, accountId);
  if (!resolved) throw notFound();
  let id = resolved.id;
  await lockScoring(ctx, id);

  let view = await getAccountForScoring(ctx, id);
  if (!view) throw notFound();
  if (view.accountId !== id) {
    // A merge committed between resolving and locking: lock and read the survivor instead, once.
    id = view.accountId;
    await lockScoring(ctx, id);
    view = await getAccountForScoring(ctx, id);
    if (!view || view.accountId !== id) throw notFound();
  }
  const profile = opts.profile ?? (await getProfile(ctx));
  const loaded = opts.offers ?? (await listApprovedOffers(ctx, { practiceIds: view.practiceIds }));
  const offers = loaded.filter((o) => view.practiceIds.length === 0 || view.practiceIds.includes(o.practiceId));
  const chainIds = [id, ...(opts.alsoAccountIds ?? [])];
  const warm = await getWarmIntro(ctx, chainIds);
  const trust = await bestTrustForAccounts(ctx, chainIds);

  const account = toScoringAccount(view);
  const signals = toScoringSignals(view);
  const scoringOffers = offers.map(toScoringOffer);

  const hash = inputsHash({
    profile,
    account,
    signals,
    offers: offers.map((o, i) => ({ name: o.name, practiceId: o.practiceId, ...scoringOffers[i] })),
    researchTier: view.researchTier,
    researchTierSignalAt: view.researchTierSignalAt,
    warm: warm && { name: warm.introducerName, points: warm.points },
    trust,
  });
  const [prev] = await ctx.tx
    .select()
    .from(accountScore)
    .where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id)));
  if (prev && prev.inputsHash === hash) {
    const timeZone = await tenantTimezone(ctx);
    if (dayIn(prev.computedAt, timeZone) === dayIn(now, timeZone)) return { changed: false, score: prev };
  }

  const computed = offers.map((o, i) => {
    const so = scoringOffers[i]!;
    const f = fit(account, so, profile);
    const found = f.disqualifiedReason === null ? intent(account, signals, so.rules, profile, now) : { intent: 0, hits: [] };
    const combine = matchTotal(f.fit, found.intent, profile);
    const tier = tierFor(
      {
        fit: f.fit,
        intent: found.intent,
        total: combine.total,
        disqualifiedReason: f.disqualifiedReason,
        hasResearchOrTrigger: found.hits.some((h) => h.kind !== 'pain'),
      },
      profile,
    );
    const match: Match = { offerId: o.id, fit: f.fit, intent: found.intent, total: combine.total, tier };
    return { offer: o, fit: f, intent: found, combine, match };
  });
  const best = bestOffer(
    computed.map((c) => c.match),
    offers.map((o) => o.id),
  );
  const top = computed.find((c) => c.offer.id === best?.offerId);

  let tier: Tier = 'not_fit';
  let tierReason: TierReason = 'computed';
  let pri = { priority: 0, warmPoints: 0, trustModifier: 0 };
  let explanation: Explanation = {
    priority: 0,
    tier,
    tierReason,
    bestOffer: null,
    lines: [{ group: 'combine', label: 'Match', text: NO_OFFER_TEXT }],
    otherOffers: [],
    missing: [],
    computedAt: now.toISOString(),
    profileVersion: profile.version,
  };
  if (top && best) {
    const floors = applyFloors(
      best.tier,
      {
        disqualified: top.fit.disqualifiedReason !== null,
        researchTier: view.researchTier,
        researchSignalAt: view.researchTierSignalAt,
        warmIntro: warm !== null,
        bestFit: best.fit,
      },
      profile,
      now,
    );
    tier = floors.tier;
    tierReason = floors.tierReason;
    pri = priority({ matchTotal: best.total, finalTier: tier, warmPoints: warm?.points ?? 0, trust: trust?.trust ?? null }, profile);
    explanation = buildExplanation({
      offer: { id: top.offer.id, name: top.offer.name },
      fit: top.fit,
      hits: top.intent.hits,
      intent: top.intent.intent,
      signals,
      now,
      combine: top.combine,
      profile,
      tier,
      tierReason,
      ...(floors.text === undefined ? {} : { tierText: floors.text }),
      priority: pri,
      warmIntroFrom: warm?.introducerName ?? null,
      trust: trust && { value: trust.trust, sourceName: trust.sourceName },
      otherOffers: computed
        .filter((c) => c !== top)
        .map((c) => ({ id: c.offer.id, name: c.offer.name, total: c.match.total, tier: c.match.tier })),
      computedAt: now,
      profileVersion: profile.version,
    });
  }

  await ctx.tx.delete(offerMatch).where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.accountId, id)));
  if (computed.length > 0) {
    await ctx.tx.insert(offerMatch).values(
      computed.map((c) => ({
        id: newId('om'),
        tenantId: ctx.tenantId,
        accountId: id,
        offerId: c.offer.id,
        fit: c.match.fit,
        intent: c.match.intent,
        matchTotal: c.match.total,
        tier: c.match.tier,
        fitParts: c.fit.parts,
        ruleHits: c.intent.hits,
        disqualifiedReason: c.fit.disqualifiedReason,
        profileVersion: profile.version,
        computedAt: now,
      })),
    );
  }

  const values = {
    bestOfferId: best?.offerId ?? null,
    practiceId: top?.offer.practiceId ?? null,
    fit: best?.fit ?? 0,
    intent: best?.intent ?? 0,
    matchTotal: best?.total ?? 0,
    warmPoints: pri.warmPoints,
    warmIntroducerId: warm?.introducerUserId ?? null,
    warmIntroducerName: warm?.introducerName ?? null,
    trust: trust?.trust ?? null,
    trustSourceId: trust?.sourceId ?? null,
    trustModifier: pri.trustModifier,
    priority: pri.priority,
    tier,
    tierReason,
    explanation,
    inputsHash: hash,
    profileVersion: profile.version,
    version: (prev?.version ?? 0) + 1,
    computedAt: now,
  };
  const [score] = prev
    ? await ctx.tx
        .update(accountScore)
        .set(values)
        .where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id)))
        .returning()
    : await ctx.tx.insert(accountScore).values({ tenantId: ctx.tenantId, accountId: id, ...values }).returning();
  if (!score) throw new Error('The score was not saved.');

  const moved = !prev || prev.priority !== score.priority || prev.tier !== score.tier || prev.bestOfferId !== score.bestOfferId;
  if (moved) {
    await ctx.tx.insert(scoreChange).values({
      id: newId('scc'),
      tenantId: ctx.tenantId,
      accountId: id,
      fromPriority: prev?.priority ?? null,
      toPriority: score.priority,
      fromTier: prev?.tier ?? null,
      toTier: score.tier,
      fromOfferId: prev?.bestOfferId ?? null,
      toOfferId: score.bestOfferId,
      cause,
      causeEventId: causeEventId ?? null,
    });
    await publish(
      ctx,
      accountScored,
      {
        accountId: id,
        priority: score.priority,
        fit: score.fit,
        intent: score.intent,
        tier,
        previousTier: (prev?.tier as Tier | undefined) ?? null,
        bestOfferId: score.bestOfferId,
        previousBestOfferId: prev?.bestOfferId ?? null,
        practiceId: score.practiceId,
        revenueBand: null,
        cause,
        profileVersion: profile.version,
        version: score.version,
      },
      { type: 'account', id },
    );
  }
  return { changed: true, score };
}
