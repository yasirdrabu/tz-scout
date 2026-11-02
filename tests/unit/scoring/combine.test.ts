import { describe, expect, it } from 'vitest';
import { matchScore } from '@/modules/scoring/domain/combine';
import { fit } from '@/modules/scoring/domain/fit';
import { intent } from '@/modules/scoring/domain/intent';
import { DEFAULT_SIGNAL_RULES } from '@/modules/offers';
import type { ScoringRule } from '@/modules/scoring/contracts/types';
import { account, daysAgo, M, NOW, offer, person, profile, rule, signal } from './fixtures';

const sc = (fit: number, intent: number, revenue = 50, trust = 60, p = profile) => matchScore({ fit, intent, revenue, trust }, p);

describe('matchScore', () => {
  it('SCO-E6-S1-AC1: fit 80, intent 40, revenue 50, trust 60 give 62', () => {
    expect(sc(80, 40)).toEqual({ score: 62, cappedAtFit: false });
  });
  it('SCO-E6-S1-AC2: fit 100, intent 80, revenue 75, trust 60 give 83', () => {
    expect(sc(100, 80, 75)).toEqual({ score: 83, cappedAtFit: false });
  });
  it('SCO-E6-S1-AC3: fit 45, intent 100, revenue 100, trust 60 weigh 70 and are capped at fit 45', () => {
    expect(sc(45, 100, 100)).toEqual({ score: 45, cappedAtFit: true });
  });
  it('SCO-E6-S1-AC4: fit 20, intent 0, revenue 50, trust 60 weigh 28 and are capped at fit 20', () => {
    expect(sc(20, 0)).toEqual({ score: 20, cappedAtFit: true });
  });
  it('fit of exactly 50 is not capped', () => {
    expect(sc(50, 100, 100, 100).cappedAtFit).toBe(false);
  });
  it('a weight of 0 ignores that score', () => {
    const noTrust = { ...profile, weights: { fit: 50, intent: 30, revenue: 20, trust: 0 } };
    expect(sc(80, 40, 50, 0, noTrust)).toEqual(sc(80, 40, 50, 100, noTrust));
  });
  it('a weight of 60 lets one score carry the blend', () => {
    const heavy = { ...profile, weights: { fit: 60, intent: 0, revenue: 0, trust: 40 } };
    expect(sc(90, 0, 0, 50, heavy).score).toBe(74);
  });
});

describe('worked examples', () => {
  it('Example A: fit 100, intent 22', () => {
    const o = offer({
      industries: ['Government'],
      companySizeMin: 1000,
      companySizeMax: 50000,
      revenueMinCents: null,
      revenueMaxCents: null,
      regions: ['United States'],
      targetTitles: ['Chief'],
      targetBuyingRoles: ['business_owner'],
    });
    const a = account({
      industry: 'Government transit',
      employees: 2800,
      revenueCents: null,
      people: [person('Chief of Paratransit Operations', ['business_owner'])],
    });
    const f = fit(a, o, profile);
    const i = intent(
      a,
      [
        signal({ id: 'n', type: 'news', title: 'RFP re-solicitation', occurredAt: daysAgo(30) }),
        signal({ id: 'l', type: 'leadership', title: 'New director', occurredAt: daysAgo(90) }),
      ],
      [rule({ id: 'n', type: 'news', weight: 25 }), rule({ id: 'l', type: 'leadership', weight: 25 })],
      profile,
      NOW,
    );
    expect([f.fit, i.intent]).toEqual([100, 22]);
    expect(sc(f.fit, i.intent).score).toBe(Math.round(0.4 * 100 + 0.25 * 22 + 0.15 * 50 + 0.2 * 60));
  });
  it('Example B: wrong industry caps fit at 45 and the score at 45', () => {
    const a = account({ industry: 'Retail', employees: 400, revenueCents: null, people: [person('COO')] });
    const f = fit(a, offer(), profile);
    expect(f.fit).toBe(45);
    // Without the cap the blend would be round(0.4 x 45 + 0.25 x 80 + 0.15 x 50 + 0.2 x 60) = 58.
    expect(sc(f.fit, 80)).toEqual({ score: 45, cappedAtFit: true });
  });
  it('Example C: fit 70, intent 26, score 54', () => {
    expect(sc(70, 26).score).toBe(54);
  });
});

describe('v1 matchAccount cases', () => {
  const rules: ScoringRule[] = [
    rule({ id: 'h', type: 'hiring', weight: 30, match: ['ai', 'machine learning'] }),
    rule({ id: 't', type: 'tech', weight: 40, match: ['microsoft access'] }),
    rule({ id: 'g', type: 'growth', weight: 20, minValue: 0.1 }),
  ];
  it('blends the four scores by the default weights', () => {
    const a = account({ technologies: ['Microsoft Access'], people: [person('COO')] });
    const f = fit(a, offer({ rules }), profile).fit;
    const i = intent(a, [], rules, profile, NOW).intent;
    expect([f, i]).toEqual([100, 40]);
    expect(sc(f, i).score).toBe(Math.round(100 * 0.4 + 40 * 0.25 + 50 * 0.15 + 60 * 0.2));
  });
  it('a poor fit cannot be lifted by signals', () => {
    const a = account({ industry: 'Retail', employees: 20, revenueCents: 1 * M, technologies: ['Microsoft Access'] });
    const f = fit(a, offer({ rules }), profile).fit;
    const i = intent(a, [], rules, profile, NOW).intent;
    expect(sc(f, i, 100, 100).score).toBeLessThanOrEqual(f);
  });
});

describe('default rules map signals to the right offer', () => {
  const rulesFor = (slug: string): ScoringRule[] =>
    DEFAULT_SIGNAL_RULES[slug]!.map((r, i) => ({ ...r, id: `${slug}${i}`, enabled: true }));
  const score = (a: ReturnType<typeof account>, signals: ReturnType<typeof signal>[], slug: string, titles: string[]) => {
    const rules = rulesFor(slug);
    const f = fit(a, offer({ targetTitles: titles, rules }), profile).fit;
    return sc(f, intent(a, signals, rules, profile, NOW).intent).score;
  };
  it('a carrier on Access hiring an Access developer is a Modernization Blueprint buyer', () => {
    const a = account({ technologies: ['Microsoft Access', 'QuickBooks'], people: [person('VP Operations')] });
    const s = [signal({ id: 'j', type: 'hiring', title: 'Hiring: Microsoft Access Developer', occurredAt: daysAgo(10) })];
    const t = (slug: string) => score(a, s, slug, ['COO', 'VP Operations', 'CIO']);
    const mb = t('modernization-blueprint');
    for (const other of ['ai-opportunity-map', 'agentready-diagnostic', 'smart-space-poc', 'company-brain']) {
      expect(mb).toBeGreaterThan(t(other));
    }
  });
  it('a healthcare group hiring an AI governance lead and using Copilot is an AgentReady buyer', () => {
    const a = account({ industry: 'Healthcare services', technologies: ['Microsoft Copilot', 'Epic'], people: [person('CIO')] });
    const s = [signal({ id: 'j', type: 'hiring', title: 'Hiring: AI Governance Lead', occurredAt: daysAgo(5) })];
    const t = (slug: string) => score(a, s, slug, ['CIO', 'COO']);
    expect(t('agentready-diagnostic')).toBeGreaterThan(t('modernization-blueprint'));
    expect(t('agentready-diagnostic')).toBeGreaterThan(t('ai-opportunity-map'));
  });
});
