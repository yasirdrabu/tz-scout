import { describe, expect, it } from 'vitest';
import { matchTotal } from '@/modules/scoring/domain/combine';
import { fit } from '@/modules/scoring/domain/fit';
import { intent } from '@/modules/scoring/domain/intent';
import { DEFAULT_SIGNAL_RULES } from '@/modules/offers';
import type { ScoringRule } from '@/modules/scoring/contracts/types';
import { account, daysAgo, M, NOW, offer, person, profile, rule, signal } from './fixtures';

describe('matchTotal', () => {
  it('SCO-E1-S3-AC1: fit 80 and intent 40 give 62', () => {
    expect(matchTotal(80, 40, profile)).toEqual({ total: 62, cappedAtFit: false });
  });
  it('SCO-E1-S3-AC2: fit 45 and intent 100 give 45', () => {
    expect(matchTotal(45, 100, profile)).toEqual({ total: 45, cappedAtFit: true });
  });
  it('fit of exactly 50 is not capped', () => {
    expect(matchTotal(50, 100, profile)).toEqual({ total: 73, cappedAtFit: false });
  });
  it('is normalised by the weights: 0.3 and 0.3 equal 0.5 and 0.5', () => {
    const w = (n: number) => ({ ...profile, fitWeight: n, intentWeight: n });
    expect(matchTotal(80, 40, w(0.3))).toEqual(matchTotal(80, 40, w(0.5)));
    expect(matchTotal(80, 40, w(0.3)).total).toBe(60);
  });
  it('a lone fit weight scores on fit alone', () => {
    expect(matchTotal(80, 40, { ...profile, fitWeight: 1, intentWeight: 0 }).total).toBe(80);
  });
});

describe('worked examples', () => {
  it('Example A: fit 100, intent 22, total 65', () => {
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
    expect(matchTotal(f.fit, i.intent, profile).total).toBe(65);
  });
  it('Example B: wrong industry caps fit at 45 and the total at 45', () => {
    const a = account({ industry: 'Retail', employees: 400, revenueCents: null, people: [person('COO')] });
    const f = fit(a, offer(), profile);
    expect(f.fit).toBe(45);
    // Without the cap the blend would be round(0.55 x 45 + 0.45 x 80) = 61.
    expect(matchTotal(f.fit, 80, profile)).toEqual({ total: 45, cappedAtFit: true });
  });
  it('Example C: fit 70, intent 26, total 50', () => {
    expect(matchTotal(70, 26, profile).total).toBe(50);
  });
});

describe('v1 matchAccount cases', () => {
  const rules: ScoringRule[] = [
    rule({ id: 'h', type: 'hiring', weight: 30, match: ['ai', 'machine learning'] }),
    rule({ id: 't', type: 'tech', weight: 40, match: ['microsoft access'] }),
    rule({ id: 'g', type: 'growth', weight: 20, minValue: 0.1 }),
  ];
  it('blends 55% fit and 45% intent', () => {
    const a = account({ technologies: ['Microsoft Access'], people: [person('COO')] });
    const f = fit(a, offer({ rules }), profile).fit;
    const i = intent(a, [], rules, profile, NOW).intent;
    expect([f, i]).toEqual([100, 40]);
    expect(matchTotal(f, i, profile).total).toBe(Math.round(100 * 0.55 + 40 * 0.45));
  });
  it('a poor fit cannot be lifted by signals', () => {
    const a = account({ industry: 'Retail', employees: 20, revenueCents: 1 * M, technologies: ['Microsoft Access'] });
    const f = fit(a, offer({ rules }), profile).fit;
    const i = intent(a, [], rules, profile, NOW).intent;
    expect(matchTotal(f, i, profile).total).toBeLessThanOrEqual(f);
  });
});

describe('default rules map signals to the right offer', () => {
  const rulesFor = (slug: string): ScoringRule[] =>
    DEFAULT_SIGNAL_RULES[slug]!.map((r, i) => ({ ...r, id: `${slug}${i}`, enabled: true }));
  const total = (a: ReturnType<typeof account>, signals: ReturnType<typeof signal>[], slug: string, titles: string[]) => {
    const rules = rulesFor(slug);
    const f = fit(a, offer({ targetTitles: titles, rules }), profile).fit;
    return matchTotal(f, intent(a, signals, rules, profile, NOW).intent, profile).total;
  };
  it('a carrier on Access hiring an Access developer is a Modernization Blueprint buyer', () => {
    const a = account({ technologies: ['Microsoft Access', 'QuickBooks'], people: [person('VP Operations')] });
    const s = [signal({ id: 'j', type: 'hiring', title: 'Hiring: Microsoft Access Developer', occurredAt: daysAgo(10) })];
    const t = (slug: string) => total(a, s, slug, ['COO', 'VP Operations', 'CIO']);
    const mb = t('modernization-blueprint');
    for (const other of ['ai-opportunity-map', 'agentready-diagnostic', 'smart-space-poc', 'company-brain']) {
      expect(mb).toBeGreaterThan(t(other));
    }
  });
  it('a healthcare group hiring an AI governance lead and using Copilot is an AgentReady buyer', () => {
    const a = account({ industry: 'Healthcare services', technologies: ['Microsoft Copilot', 'Epic'], people: [person('CIO')] });
    const s = [signal({ id: 'j', type: 'hiring', title: 'Hiring: AI Governance Lead', occurredAt: daysAgo(5) })];
    const t = (slug: string) => total(a, s, slug, ['CIO', 'COO']);
    expect(t('agentready-diagnostic')).toBeGreaterThan(t('modernization-blueprint'));
    expect(t('agentready-diagnostic')).toBeGreaterThan(t('ai-opportunity-map'));
  });
});
