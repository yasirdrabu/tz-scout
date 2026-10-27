import { describe, expect, it } from 'vitest';
import type { ScoringAccount, ScoringOffer, ScoringSignal } from '@/modules/scoring/contracts/types';
import { matchTotal } from '@/modules/scoring/domain/combine';
import { buildExplanation, summarySentence, wouldRaise, type Explanation } from '@/modules/scoring/domain/explain';
import { fit } from '@/modules/scoring/domain/fit';
import { intent } from '@/modules/scoring/domain/intent';
import { priority } from '@/modules/scoring/domain/priority';
import { applyFloors, tierFor } from '@/modules/scoring/domain/tiers';
import { account, daysAgo, NOW, offer, person, profile, rule, signal } from './fixtures';

type Extras = {
  warm?: { name: string; points: number };
  trust?: { value: number; sourceName: string };
  others?: Explanation['otherOffers'];
  researchTier?: 'A' | 'B' | 'C';
};

/** Runs the real scoring functions for one offer, then explains the result. */
function explain(acc: ScoringAccount, off: ScoringOffer, signals: ScoringSignal[], x: Extras = {}) {
  const f = fit(acc, off, profile);
  const i = intent(acc, signals, off.rules, profile, NOW);
  const combine = matchTotal(f.fit, i.intent, profile);
  const computed = tierFor(
    { fit: f.fit, intent: i.intent, total: combine.total, disqualifiedReason: f.disqualifiedReason, hasResearchOrTrigger: i.hits.some((h) => h.kind !== 'pain') },
    profile,
  );
  const floored = applyFloors(
    computed,
    { disqualified: f.disqualifiedReason !== null, researchTier: x.researchTier ?? null, researchSignalAt: daysAgo(30), warmIntro: x.warm !== undefined, bestFit: f.fit },
    profile,
    NOW,
  );
  const p = priority({ matchTotal: combine.total, finalTier: floored.tier, warmPoints: x.warm?.points ?? 0, trust: x.trust?.value ?? null }, profile);
  const e = buildExplanation({
    offer: { id: off.id, name: 'Modernization Blueprint' },
    fit: f,
    hits: i.hits,
    intent: i.intent,
    signals,
    now: NOW,
    combine,
    profile,
    tier: floored.tier,
    tierReason: floored.tierReason,
    ...(floored.text ? { tierText: floored.text } : {}),
    priority: p,
    warmIntroFrom: x.warm?.name ?? null,
    trust: x.trust ?? null,
    otherOffers: x.others ?? [],
    computedAt: NOW,
    profileVersion: 3,
  });
  return { e, f, i, p };
}

/** The priority the lines add up to: fit lines (or the capped fit) and intent lines by weight, then adjustments. */
function sumLines(e: Explanation): number {
  const sum = (group: string) => e.lines.filter((l) => l.group === group).reduce((s, l) => s + (l.points ?? 0), 0);
  const capped = e.lines.find((l) => l.group === 'combine' && l.label === 'Hard miss');
  const fitPts = capped ? capped.points! : sum('fit');
  const intentPts = Math.min(100, sum('intent'));
  const w = profile.fitWeight + profile.intentWeight;
  let total = Math.round((fitPts * profile.fitWeight + intentPts * profile.intentWeight) / w);
  if (fitPts < 50) total = Math.min(total, fitPts);
  return total + sum('adjust');
}

const exampleA = () => {
  const off = offer({
    industries: ['Government'],
    companySizeMin: 1000,
    companySizeMax: 50000,
    revenueMinCents: null,
    revenueMaxCents: null,
    targetTitles: ['Chief'],
    targetBuyingRoles: ['business_owner'],
    rules: [
      rule({ id: 'r_news', type: 'news', weight: 25, label: 'Re-solicitation of the paratransit software contract', match: ['re-solicitation'] }),
      rule({ id: 'r_lead', type: 'leadership', weight: 25, label: 'Leadership change' }),
    ],
  });
  const acc = account({ industry: 'Government transit', employees: 2800, people: [person('Chief of Paratransit Operations', ['business_owner'])] });
  const sigs = [
    signal({ id: 'sig_news', type: 'news', title: 'RFP re-solicitation for paratransit', occurredAt: daysAgo(30) }),
    signal({ id: 'sig_lead', type: 'leadership', title: 'New director', occurredAt: daysAgo(90) }),
  ];
  return { off, acc, sigs };
};

describe('buildExplanation', () => {
  it('SCO-E4-S1-AC1: example A lines add up to the priority, with warm and trust lines', () => {
    const { off, acc, sigs } = exampleA();
    const { e, f, i, p } = explain(acc, off, sigs, { warm: { name: 'Zach Wiant', points: 8 }, trust: { value: 0.72, sourceName: "Yasir's research agent" } });
    expect([f.fit, i.intent, p.priority]).toEqual([100, 22, 76]);
    expect(e.priority).toBe(76);
    expect(Math.abs(sumLines(e) - e.priority)).toBeLessThanOrEqual(1);
    expect(e.lines.find((l) => l.group === 'combine' && l.label === 'Match')).toMatchObject({ points: 65, text: '55% fit (100) and 45% intent (22).' });
    expect(e.lines.filter((l) => l.group === 'adjust')).toEqual([
      { group: 'adjust', label: 'Warm intro from Zach Wiant', points: 8, max: 20 },
      { group: 'adjust', label: "Source trust 0.72 (Yasir's research agent)", points: 3, max: 5 },
    ]);
    const news = e.lines.find((l) => l.label.startsWith('Re-solicitation'));
    expect(news).toMatchObject({ group: 'intent', points: 15.7, max: 25, kind: 'trigger', signalIds: ['sig_news'] });
    expect(news?.text).toBe('News from Sep 14, 2026 (30 days ago, counts 63%).');
    expect(e.profileVersion).toBe(3);
    expect(e.computedAt).toBe('2026-10-14T12:00:00.000Z');
  });

  it('SCO-E4-S1-AC1: example B shows the hard miss and the low fit cap and still adds up', () => {
    const off = offer({
      industries: ['Government'],
      rules: [rule({ id: 'r1', type: 'news', weight: 50 }), rule({ id: 'r2', type: 'leadership', weight: 30 })],
    });
    const acc = account({ industry: 'Retail', employees: 400, revenueCents: null, people: [person('CEO')] });
    const sigs = [signal({ id: 's1', type: 'news', title: 'a' }), signal({ id: 's2', type: 'leadership', title: 'b' })];
    const { e, f, i, p } = explain(acc, off, sigs);
    expect([f.fit, i.intent, p.priority]).toEqual([45, 80, 45]);
    const text = e.lines.filter((l) => l.group === 'combine').map((l) => l.text);
    expect(text).toContain('Hard miss: fit capped at 45.');
    expect(text).toContain('Fit below 50: total capped at fit (45).');
    expect(Math.abs(sumLines(e) - e.priority)).toBeLessThanOrEqual(1);
  });

  it('SCO-E4-S1-AC1: example C adds up and lists unknown revenue and region', () => {
    const off = offer({
      industries: ['Logistics'],
      rules: [rule({ id: 'r_res', type: 'intent', weight: 40, label: 'AI strategy research' })],
    });
    const acc = account({ revenueCents: null, country: null });
    const sigs = [signal({ id: 'sig_res', type: 'intent', title: 'AI strategy', value: 0.7, occurredAt: daysAgo(10) })];
    const { e, f, i, p } = explain(acc, off, sigs);
    expect([f.fit, i.intent, p.priority]).toEqual([70, 26, 50]);
    expect(Math.abs(sumLines(e) - e.priority)).toBeLessThanOrEqual(1);
    expect(e.lines.find((l) => l.group === 'intent')).toMatchObject({ kind: 'research', signalIds: ['sig_res'] });
    expect(e.missing).toEqual([
      'Revenue unknown: adding it could change fit by up to 10 points.',
      'Location unknown: adding it could change fit by up to 5 points.',
    ]);
  });

  it('SCO-E3-S2-AC2: other offers are listed with totals and tiers', () => {
    const { off, acc, sigs } = exampleA();
    const { e } = explain(acc, off, sigs, { others: [{ id: 'off_2', name: 'FDE Sprint', total: 58, tier: 'good_fit' }] });
    expect(e.otherOffers).toEqual([{ id: 'off_2', name: 'FDE Sprint', total: 58, tier: 'good_fit' }]);
  });

  it('SCO-E3-S3-AC1: the research floor text appears in the explanation', () => {
    const off = offer({ industries: ['Logistics'] });
    const { e } = explain(account(), off, [], { researchTier: 'A' });
    expect(e.tier).toBe('act_now');
    expect(e.tierReason).toBe('research_floor');
    expect(e.lines.some((l) => l.text === 'Researcher rated A with a signal from 2026-09-14: act now')).toBe(true);
  });

  it('SCO-E3-S3-AC4: a disqualified account stays not a fit and names the exclusion', () => {
    const off = offer({ excludedDomains: ['acme.com'] });
    const rules = [rule({ id: 'r1', type: 'news', weight: 50 })];
    const sigs = [signal({ id: 's1', type: 'news', title: 'a' })];
    const { e } = explain(account(), { ...off, rules }, sigs, { researchTier: 'A', warm: { name: 'Zach Wiant', points: 8 } });
    expect(e.tier).toBe('not_fit');
    expect(e.lines.filter((l) => l.group === 'fit')).toHaveLength(1);
    expect(e.lines.find((l) => l.label === 'Excluded')?.text).toBe('acme.com is on the excluded list.');
    expect(e.lines.some((l) => l.group === 'adjust')).toBe(false);
    expect(Math.abs(sumLines(e) - e.priority)).toBeLessThanOrEqual(1);
  });

  it('a negative trust line shows, a zero modifier line is omitted', () => {
    const { off, acc, sigs } = exampleA();
    const low = explain(acc, off, sigs, { trust: { value: 0.4, sourceName: 'Feed' } }).e;
    expect(low.lines.filter((l) => l.group === 'adjust')).toEqual([{ group: 'adjust', label: 'Source trust 0.40 (Feed)', points: -5, max: 5 }]);
    expect(Math.abs(sumLines(low) - low.priority)).toBeLessThanOrEqual(1);
    const neutral = explain(acc, off, sigs, { trust: { value: 0.6, sourceName: 'Feed' } }).e;
    expect(neutral.lines.some((l) => l.group === 'adjust')).toBe(false);
  });

  it('intent lines above 100 still add up through the clamp', () => {
    const { acc } = exampleA();
    const off = offer({
      industries: ['Government'],
      companySizeMin: 1000,
      companySizeMax: 50000,
      rules: [rule({ id: 'a', type: 'news', weight: 80 }), rule({ id: 'b', type: 'leadership', weight: 80 })],
    });
    const sigs = [signal({ id: 's1', type: 'news', title: 'a' }), signal({ id: 's2', type: 'leadership', title: 'b' })];
    const { e, i } = explain(acc, off, sigs);
    expect(i.intent).toBe(100);
    expect(e.lines.filter((l) => l.group === 'intent').reduce((s, l) => s + (l.points ?? 0), 0)).toBeGreaterThan(100);
    expect(Math.abs(sumLines(e) - e.priority)).toBeLessThanOrEqual(1);
  });
});

describe('summarySentence', () => {
  it('example A with a warm intro', () => {
    const { off, acc, sigs } = exampleA();
    const { e } = explain(acc, off, sigs, { warm: { name: 'Zach Wiant', points: 8 }, trust: { value: 0.72, sourceName: 'Agent' } });
    expect(summarySentence(e)).toBe(
      'Good fit for Modernization Blueprint (priority 76): strong fit, Re-solicitation of the paratransit software contract 30 days ago, and a warm intro from Zach Wiant.',
    );
  });
});

describe('wouldRaise', () => {
  it('lists missing inputs, the two biggest unmet rules and a missing buying role', () => {
    const off = offer({
      industries: ['Logistics'],
      targetBuyingRoles: ['technical_buyer'],
      rules: [
        rule({ id: 'a', type: 'news', weight: 10, label: 'Small rule' }),
        rule({ id: 'b', type: 'leadership', weight: 40, label: 'Big rule' }),
        rule({ id: 'c', type: 'funding', weight: 30, label: 'Medium rule' }),
        rule({ id: 'd', type: 'intent', weight: 20, label: 'Met rule' }),
      ],
    });
    const acc = account({ revenueCents: null, people: [person('CEO', ['business_owner'])] });
    const sigs = [signal({ id: 's', type: 'intent', title: 'x', value: 0.8 })];
    const { e } = explain(acc, off, sigs);
    expect(wouldRaise(e, off, acc)).toEqual(['Revenue on file', 'A signal for Big rule', 'A signal for Medium rule', 'A technical buyer on file']);
  });
});
