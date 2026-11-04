import { getAccount, getFacts, getSignals, listNotes, type FactView, type SignalView } from '@/modules/accounts';
import { companyChecks } from '@/modules/crm';
import { sourceNames } from '@/modules/intake';
import { getOffer, listPractices, matchCaseStudies, type Offer } from '@/modules/offers';
import { getAccountReview, type AccountReviewView } from '@/modules/routing';
import { explainScore, getScore, TIER_NAMES, type ScoreExplanation, type Tier } from '@/modules/scoring';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { DESCRIPTION_MAX, INPUT_CAPS, INSIGHTS_MAX, SIGNAL_TITLE_MAX, type BriefInput } from '../domain/brief-io';

export type BuiltInput = { input: BriefInput; accountId: string; offerId: string | null; offerName: string | null; tier: Tier; explanation: ScoreExplanation };

/** Facts the overview leans on come first, so the cap never drops them. */
const CORE_FACT_KEYS = ['name', 'domain', 'industry', 'employees', 'hq_city', 'hq_state', 'hq_country', 'description', 'revenue_cents'];

/** Roles a person holds beyond a title guess: a guess is not a confirmed role. */
const confirmed = <T extends { origin: string }>(roles: T[]) => roles.filter((r) => r.origin !== 'guessed_from_title');

export const closestSource = (c: SignalView['sourceChain']) => c.agentSourceId ?? c.vendorSourceId ?? c.personSourceId;
const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const notFoundOr = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return null;
    throw e;
  }
};

/** Dated signals newest first, then the undated ones newest recorded first. */
function orderSignals(signals: SignalView[]): SignalView[] {
  const dated = signals.filter((s) => s.occurredAt).sort((a, b) => b.occurredAt!.getTime() - a.occurredAt!.getTime() || b.id.localeCompare(a.id));
  const undated = signals.filter((s) => !s.occurredAt).sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  return [...dated, ...undated].slice(0, INPUT_CAPS.signals);
}

/** Account facts only, no contact details, core keys first. */
function pickFacts(facts: FactView[]): FactView[] {
  const own = facts.filter((f) => f.personId === null && f.kind !== 'contact');
  const rank = (f: FactView) => {
    const i = CORE_FACT_KEYS.indexOf(f.key);
    return i < 0 ? CORE_FACT_KEYS.length : i;
  };
  return [...own].sort((a, b) => rank(a) - rank(b)).slice(0, INPUT_CAPS.facts);
}

/**
 * Everything the `account_brief` task reads for one account, within the input caps (Global Constraints). Null when the
 * account is missing or hidden, or has no score yet.
 */
export async function buildBriefInput(ctx: ModuleContext, accountId: string): Promise<BuiltInput | null> {
  const account = await getAccount(ctx, accountId);
  if (!account) return null;
  const id = account.id;
  const score = await getScore(ctx, id);
  if (!score) return null;
  const review: AccountReviewView | null = await notFoundOr(getAccountReview(ctx, id));
  const leadOfferId = review?.leadOffer?.offerId ?? score.bestOfferId ?? null;
  const explanation = (leadOfferId ? await explainScore(ctx, id, { offerId: leadOfferId }) : null) ?? (await explainScore(ctx, id));
  if (!explanation) return null;
  const offer: Offer | null = explanation.offerId ? await notFoundOr(getOffer(ctx, explanation.offerId)) : null;

  const signals = orderSignals(await getSignals(ctx, id));
  const names = await sourceNames(ctx, [...new Set(signals.map((s) => closestSource(s.sourceChain)).filter((x): x is string => !!x))]);
  const facts = pickFacts(await getFacts(ctx, id));
  const caseStudies = offer ? await matchCaseStudies(ctx, offer.id, account.industry, INPUT_CAPS.caseStudies) : [];
  const [check] = await companyChecks(ctx, [id]);
  const notes = (await listNotes(ctx, id)).data.slice(0, INPUT_CAPS.notes);
  const warm = explanation.lines.find((l) => l.group === 'adjust' && l.label.startsWith('Warm intro'));
  // The tier the account holds, a manual one included; the explanation keeps the computed one.
  const tier = score.tier as Tier;

  const input: BriefInput = {
    account: {
      name: account.name,
      industry: account.industry,
      employees: account.employees,
      location: [account.hqCity, account.hqState, account.hqCountry].filter(Boolean).join(', ') || null,
      description: account.description?.slice(0, DESCRIPTION_MAX) ?? null,
      technologies: account.technologies.slice(0, 20),
    },
    offer: offer
      ? {
          id: offer.id,
          name: offer.name,
          promise: offer.promise,
          priceMinCents: offer.priceMinCents,
          priceMaxCents: offer.priceMaxCents,
          salesCycleDays: offer.salesCycleDays,
          targetTitles: offer.targetTitles,
          targetBuyingRoles: offer.targetBuyingRoles,
          proofPoints: offer.proofPoints,
        }
      : null,
    practiceName: offer ? ((await listPractices(ctx, { includeArchived: true })).find((p) => p.id === offer.practiceId)?.name ?? null) : null,
    caseStudies: caseStudies.map((c) => ({ id: c.id, title: c.title, clientName: c.clientName, result: c.result })),
    signals: signals.map((s) => ({
      id: s.id,
      type: s.type,
      kind: s.kind,
      title: s.title.slice(0, SIGNAL_TITLE_MAX),
      occurredAt: s.occurredAt?.toISOString() ?? null,
      sourceName: names.get(closestSource(s.sourceChain) ?? '') ?? null,
    })),
    facts: facts.map((f) => ({ id: f.id, key: f.key, value: text(f.value).slice(0, 500) })),
    people: account.people.slice(0, INPUT_CAPS.people).map((p) => ({
      id: p.id,
      name: [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed contact',
      title: p.title,
      roleKeys: confirmed(p.roles).map((r) => r.key),
      roleLabels: confirmed(p.roles).map((r) => r.label),
      isPrimary: p.isPrimary,
    })),
    score: {
      tier,
      tierLabel: TIER_NAMES[tier],
      priority: explanation.priority,
      fit: explanation.fit,
      intent: explanation.intent,
      fitParts: explanation.lines
        .filter((l) => l.group === 'fit')
        .map((l) => ({ label: l.label, points: l.points ?? 0, max: l.max ?? 0, note: l.text ?? '' })),
      wouldRaise: explanation.wouldRaise,
    },
    crm: check ? { exists: check.exists, ownerName: check.ownerName, lifecycle: check.lifecycle, openDeals: check.openDeals } : null,
    warmIntro: warm ? { introducerName: warm.label === 'Warm intro' ? 'your contact' : warm.label.slice('Warm intro from '.length) } : null,
    notes: notes.map((n) => ({ text: n.body.slice(0, 1000), at: n.at.toISOString() })),
    insights: review?.insights?.text.slice(0, INSIGHTS_MAX) ?? null,
  };
  return { input, accountId: id, offerId: offer?.id ?? null, offerName: offer?.name ?? null, tier, explanation };
}

/** Every id the task may cite. */
export const citableIds = (input: BriefInput) => new Set([...input.facts.map((f) => f.id), ...input.signals.map((s) => s.id), ...input.people.map((p) => p.id)]);
