import { describe, expect, it } from 'vitest';
import { intent } from '@/modules/scoring/domain/intent';
import { account, daysAgo, NOW, profile, rule, signal } from './fixtures';

const run = (
  a = account(),
  signals: ReturnType<typeof signal>[] = [],
  rules = [rule({ id: 'r', type: 'hiring', weight: 30, match: ['ai'] })],
  p = profile,
) => intent(a, signals, rules, p, NOW);

const rules = [
  rule({ id: 'h', type: 'hiring', label: 'Hiring AI', weight: 30, match: ['ai', 'machine learning'] }),
  rule({ id: 't', type: 'tech', label: 'Legacy', weight: 40, match: ['microsoft access'] }),
  rule({ id: 'g', type: 'growth', label: 'Growth', weight: 20, minValue: 0.1 }),
];

describe('recency (SCO-E1-S2-AC1)', () => {
  const at = (n: number, type = 'hiring', occurredAt: Date | null = daysAgo(n), recordedAt = NOW) =>
    run(
      account(),
      [signal({ id: '1', type, title: 'AI role', occurredAt, recordedAt })],
      [rule({ id: 'r', type, weight: 100, match: type === 'hiring' ? ['ai'] : [] })],
    ).hits[0]?.points ?? 0;
  it('halves every 45 days', () => {
    expect(at(0)).toBe(100);
    expect(at(45)).toBe(50);
    expect(at(90)).toBe(25);
  });
  it('older than 365 days counts nothing', () => {
    expect(at(365)).toBeGreaterThan(0);
    expect(at(366)).toBe(0);
  });
  it('news fades but workforce does not', () => {
    expect(at(900, 'news')).toBe(0);
    expect(at(900, 'workforce')).toBe(100);
  });
  it('a signal with no date uses its recorded day', () => {
    const midnight = new Date('2026-08-30T00:00:00Z'); // 45.5 days before NOW
    expect(at(0, 'hiring', null, new Date('2026-08-30T23:00:00Z'))).toBe(at(0, 'hiring', midnight));
    expect(at(0, 'hiring', null, midnight)).toBeLessThan(50);
  });
  it('follows the profile half-life and age limit', () => {
    const s = [signal({ id: '1', type: 'hiring', title: 'AI role', occurredAt: daysAgo(30) })];
    const r = [rule({ id: 'r', type: 'hiring', weight: 100, match: ['ai'] })];
    expect(intent(account(), s, r, { ...profile, halfLifeDays: 30 }, NOW).intent).toBe(50);
    expect(intent(account(), s, r, { ...profile, maxSignalAgeDays: 20 }, NOW).intent).toBe(0);
  });
});

describe('keywords', () => {
  it('a fresh matching signal earns the rule full weight and lists its signal', () => {
    const r = run(account(), [signal({ id: '1', type: 'hiring', title: 'Hiring: Director of AI' })], rules);
    expect(r.intent).toBe(30);
    expect(r.hits[0]!.signalIds).toEqual(['1']);
  });
  it('short keywords match whole words only: AI matches "AI strategy" and not "paid"', () => {
    const on = (title: string) => run(account(), [signal({ id: '1', type: 'hiring', title })]).intent;
    expect(on('AI strategy lead')).toBe(30);
    expect(on('Paid media planner')).toBe(0);
    expect(on('Hiring: Maintenance Planner')).toBe(0);
  });
  it('keywords match the detail too', () => {
    expect(run(account(), [signal({ id: '1', type: 'hiring', title: 'Open role', detail: 'Lead our AI work' })]).intent).toBe(30);
  });
  it('an empty keyword list matches any signal of the type', () => {
    expect(run(account(), [signal({ id: '1', type: 'funding', title: 'Raised' })], [rule({ id: 'f', type: 'funding', weight: 50 })]).intent).toBe(50);
  });
  it('a disabled rule earns nothing', () => {
    expect(run(account(), [signal({ id: '1', type: 'hiring', title: 'AI' })], [rule({ id: 'r', type: 'hiring', weight: 30, enabled: false })]).intent).toBe(0);
  });
});

describe('rule factor', () => {
  it('SCO-E1-S2-AC3: three fresh hiring signals earn the full rule points, not three times', () => {
    const s = ['AI one', 'AI two', 'AI three'].map((title, i) => signal({ id: `${i}`, type: 'hiring', title }));
    expect(run(account(), s, [rule({ id: 'r', type: 'hiring', weight: 40, match: ['ai'] })]).intent).toBe(40);
  });
  it('more of the same adds 30% then 15%', () => {
    const s = [
      signal({ id: '1', type: 'hiring', title: 'AI Engineer', occurredAt: daysAgo(45) }),
      signal({ id: '2', type: 'hiring', title: 'Machine Learning Engineer', occurredAt: daysAgo(45) }),
    ];
    expect(run(account(), s, rules).intent).toBe(Math.round(30 * (0.5 + 0.3 * 0.5)));
    const three = [...s, signal({ id: '3', type: 'hiring', title: 'AI Analyst', occurredAt: daysAgo(45) })];
    expect(run(account(), three, rules).hits[0]!.points).toBe(Math.round(30 * (0.5 + 0.15 + 0.075) * 10) / 10);
  });
  it('rule points are rounded to one decimal', () => {
    const r = run(account(), [signal({ id: '1', type: 'hiring', title: 'AI', occurredAt: daysAgo(10) })]);
    expect(r.hits[0]!.points).toBe(25.7);
  });
});

describe('research (SCO-E1-S2-AC2, AC4)', () => {
  const ir = [rule({ id: 'i', type: 'intent', label: 'Researching AI', weight: 40, match: ['ai'], minValue: 0.6 })];
  const at = (v: number) => run(account(), [signal({ id: 'i', type: 'intent', title: 'Researching: AI strategy', value: v })], ir).intent;
  it('0.60 earns half, 0.80 earns all, below the minimum earns none', () => {
    expect(at(0.55)).toBe(0);
    expect(at(0.6)).toBe(20);
    expect(at(0.7)).toBe(30);
    expect(at(0.84)).toBe(40);
  });
  it('a research minimum of 60 means 0.60', () => {
    const r = [rule({ id: 'i', type: 'intent', weight: 40, minValue: 60 })];
    const at60 = (v: number) => run(account(), [signal({ id: 'i', type: 'intent', title: 'AI', value: v })], r).intent;
    expect(at60(0.55)).toBe(0);
    expect(at60(0.6)).toBe(20);
    expect(at60(70)).toBe(30);
  });
  it('exactly 0.80 earns all', () => {
    expect(at(0.8)).toBe(40);
  });
  it('0.40 earns none', () => {
    expect(run(account(), [signal({ id: 'i', type: 'intent', title: 'AI', value: 0.4 })], [rule({ id: 'i', type: 'intent', weight: 40 })]).intent).toBe(0);
  });
  it('a value of 70 is read as 0.70', () => {
    expect(at(70)).toBe(30);
    expect(at(55)).toBe(0);
  });
  it('related topics do not stack: the strongest counts', () => {
    const s = ['strategy', 'readiness', 'transformation'].map((t, i) =>
      signal({ id: `${i}`, type: 'intent', title: `Researching: AI ${t}`, value: 0.65 }),
    );
    const r = run(account(), s, ir);
    expect(r.intent).toBe(25);
    expect(r.hits[0]!.signalIds).toHaveLength(3);
  });
});

describe('current-state signals', () => {
  it('SCO-E1-S2-AC5: a technology on the account earns full points whenever it was seen', () => {
    const r = run(account({ technologies: ['Microsoft Access', 'Salesforce'] }), [], rules);
    expect(r.intent).toBe(40);
    expect(r.hits[0]!.kind).toBe('pain');
  });
  it('a technology signal matches too', () => {
    expect(run(account(), [signal({ id: 't', type: 'tech', title: 'Microsoft Access', occurredAt: daysAgo(800) })], rules).intent).toBe(40);
  });
  it('growth respects the minimum', () => {
    const g = (v: number) => run(account(), [signal({ id: 'g', type: 'growth', title: 'Headcount up', value: v })], rules).intent;
    expect(g(0.08)).toBe(0);
    expect(g(0.18)).toBe(20);
  });
  it('growth reads the current headcount growth on the account', () => {
    expect(run(account({ headcountGrowth6m: 0.18 }), [], rules).intent).toBe(20);
    expect(run(account({ headcountGrowth6m: 0.05 }), [], rules).intent).toBe(0);
  });
  it('the account growth column adds to matching growth signals and never replaces them', () => {
    const g = [rule({ id: 'g', type: 'growth', weight: 10, minValue: 0.1 })];
    const old = signal({ id: 'g', type: 'growth', title: 'Headcount up', value: 0.18, occurredAt: daysAgo(400) });
    expect(run(account({ headcountGrowth6m: 0.05 }), [old], g).intent).toBe(10);
    expect(run(account({ headcountGrowth6m: 0.05 }), [], g).intent).toBe(0);
    expect(run(account({ headcountGrowth6m: 0.12 }), [], g).intent).toBe(10);
    expect(run(account({ headcountGrowth6m: 0.12 }), [old], [rule({ id: 'g', type: 'growth', weight: 100, minValue: 0.1 })]).intent).toBe(100);
    const free = [rule({ id: 'g', type: 'growth', weight: 10 })];
    expect(run(account({ headcountGrowth6m: 0.02 }), [], free).intent).toBe(10);
    expect(run(account({ headcountGrowth6m: 0 }), [], free).intent).toBe(0);
    expect(run(account({ headcountGrowth6m: -0.2 }), [], free).intent).toBe(0);
    expect(run(account(), [signal({ id: 'g', type: 'growth', title: 'Headcount down', value: -0.1 })], free).intent).toBe(0);
    expect(run(account(), [signal({ id: 'g', type: 'growth', title: 'Headcount up', value: 0.05 })], free).intent).toBe(10);
  });
  it('workforce respects the minimum on its value', () => {
    const w = [rule({ id: 'w', type: 'workforce', weight: 20, minValue: 0.3 })];
    expect(run(account(), [signal({ id: 'w', type: 'workforce', title: 'Operations is 25% of staff', value: 0.25 })], w).intent).toBe(0);
    expect(run(account(), [signal({ id: 'w', type: 'workforce', title: 'Operations is 35% of staff', value: 0.35 })], w).intent).toBe(20);
  });
});

it('intent is capped at 100', () => {
  const big = [1, 2, 3].map((i) => rule({ id: `${i}`, type: 'funding', weight: 50 }));
  expect(run(account(), [signal({ id: 'x', type: 'funding', title: 'Raised' })], big).intent).toBe(100);
});

it('hits are sorted by points and carry the kind and reason', () => {
  const r = run(
    account({ technologies: ['Microsoft Access'] }),
    [signal({ id: 'h', type: 'hiring', title: 'AI role' })],
    [
      rule({ id: 'a', type: 'hiring', weight: 10, match: ['ai'], why: 'because' }),
      rule({ id: 'b', type: 'tech', weight: 40, match: ['microsoft access'] }),
    ],
  );
  expect(r.hits.map((h) => h.ruleId)).toEqual(['b', 'a']);
  expect(r.hits[1]).toMatchObject({ kind: 'pain', why: 'because', max: 10 });
});

describe('worked examples', () => {
  it('Example A intent: news 30 days old and leadership 90 days old, 25 points each, give 22', () => {
    const r = run(
      account(),
      [
        signal({ id: 'n', type: 'news', title: 'RFP re-solicitation', occurredAt: daysAgo(30) }),
        signal({ id: 'l', type: 'leadership', title: 'New director', occurredAt: daysAgo(90) }),
      ],
      [rule({ id: 'n', type: 'news', weight: 25 }), rule({ id: 'l', type: 'leadership', weight: 25 })],
    );
    expect(r.hits.map((h) => h.points)).toEqual([15.7, 6.3]);
    expect(r.intent).toBe(22);
  });
  it('Example C intent: research 0.70, 10 days old, 40-point rule gives 26', () => {
    const r = run(
      account(),
      [signal({ id: 'i', type: 'intent', title: 'AI', value: 0.7, occurredAt: daysAgo(10) })],
      [rule({ id: 'i', type: 'intent', weight: 40 })],
    );
    expect(r.hits[0]!.points).toBe(25.7);
    expect(r.intent).toBe(26);
  });
});
