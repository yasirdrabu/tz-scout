import { describe, expect, it } from 'vitest';
import type { Journey } from '@/modules/analytics/services/journeys';
import type { StageDef } from '@/modules/analytics/domain/funnel';
import {
  changePct, enteredIn, medianDays, openValueCents, opportunityIndex, pace, quarterOf, stageEntry, teamTone, wonIndex, wonValueCents,
} from '@/modules/analytics/domain/overview';

const flow: StageDef[] = [
  { key: 'sent', name: 'Sent', kind: 'flow', assigned: false },
  { key: 'reviewed', name: 'Reviewed', kind: 'flow', assigned: false },
  { key: 'assigned', name: 'Assigned', kind: 'flow', assigned: true },
  { key: 'won', name: 'Won', kind: 'flow', assigned: false },
];
const T = new Date('2026-11-01T00:00:00Z');
const journey = (o: Partial<Journey> = {}): Journey => ({
  accountId: 'a', firstSourceId: 's', firstBatchId: null, arrivedAt: new Date('2026-10-05T00:00:00Z'), practiceId: null, offerId: null,
  exitStage: null, exitAt: null, stages: new Map(), deals: [], ...o,
});
const DAY = 86_400_000;

describe('quarterOf', () => {
  it('finds the quarter, week and previous window', () => {
    const q = quarterOf(new Date('2026-11-07T12:00:00Z'), 'UTC');
    expect(q.label).toBe('Q4 2026');
    expect(q.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(q.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(q.to.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(q.week).toBe(6);
    expect(q.weeks).toBe(14);
    expect(q.share).toBeCloseTo(37.5 / 92);
    expect(q.prev.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(q.prev.to.getTime()).toBe(q.prev.from.getTime() + (q.to.getTime() - q.from.getTime()));
  });
  it('starts at local midnight in the tenant timezone', () => {
    const q = quarterOf(new Date('2026-11-07T12:00:00Z'), 'America/New_York');
    expect(q.from.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    const late = journey({ arrivedAt: new Date('2026-10-01T03:30:00Z') });
    expect(enteredIn(late, flow, 0, { from: q.from, to: q.to })).toBe(false);
  });
});

describe('stageEntry', () => {
  it('counts a later stage as passing a skipped one', () => {
    expect(stageEntry(journey({ stages: new Map([['won', T]]) }), flow, 1)).toEqual(T);
  });
  it('uses arrivedAt for the first stage', () => {
    const j = journey();
    expect(stageEntry(j, flow, 0)).toEqual(j.arrivedAt);
  });
  it('is null when never reached', () => {
    expect(stageEntry(journey(), flow, 2)).toBeNull();
  });
});

describe('pace', () => {
  it('bands against the share', () => {
    expect(pace(30, 100, 0.4)).toEqual({ expected: 40, pace: 'behind' });
    expect(pace(37, 100, 0.4)?.pace).toBe('on');
    expect(pace(42, 100, 0.4)?.pace).toBe('ahead');
  });
  it('has none without a target', () => {
    expect(pace(5, null, 0.4)).toBeNull();
    expect(pace(5, 0, 0.4)).toBeNull();
  });
});

describe('medianDays', () => {
  const pair = (d: number): [Date, Date] => [T, new Date(T.getTime() + d * DAY)];
  it('takes the middle whole day', () => {
    expect(medianDays([pair(3), pair(10), pair(64)])).toBe(10);
    expect(medianDays([pair(4), pair(10)])).toBe(7);
    expect(medianDays([])).toBeNull();
  });
});

describe('value', () => {
  it('falls back to the offer price', () => {
    const open = (a: number | null) => ({ status: 'open' as const, amountCents: a, closedAt: null });
    expect(openValueCents(journey({ deals: [open(100000), open(null)] }), 50000)).toBe(150000);
    expect(openValueCents(journey(), 50000)).toBe(50000);
    expect(openValueCents(journey(), null)).toBe(0);
  });
  it('counts won deals closed in the window only', () => {
    const w = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-07T00:00:00Z') };
    const won = (d: string, a: number | null) => ({ status: 'won' as const, amountCents: a, closedAt: new Date(d) });
    const j = journey({ deals: [won('2026-09-15T00:00:00Z', 70000), won('2026-10-15T00:00:00Z', null)] });
    expect(wonValueCents(j, 50000, w)).toBe(50000);
  });
});

describe('teamTone', () => {
  it('colours against the team', () => {
    expect(teamTone(0.9, 0.8, false, 3)).toBe('good');
    expect(teamTone(0.7, 0.8, false, 3)).toBe('attention');
    expect(teamTone(0.75, 0.8, false, 3)).toBe('neutral');
    expect(teamTone(30, 20, true, 3)).toBe('attention');
    expect(teamTone(15, 20, true, 3)).toBe('good');
    expect(teamTone(0.9, 0.8, false, 1)).toBeNull();
    expect(teamTone(null, 0.8, false, 3)).toBeNull();
  });
});

describe('changePct', () => {
  it('is relative to the base', () => {
    expect(changePct(12, 10)).toBe(20);
    expect(changePct(5, 0)).toBeNull();
  });
});

describe('stage index', () => {
  const f = [
    { key: 'a', name: 'A', kind: 'flow' as const, assigned: false, trigger: 'x', locked: 'first' as const },
    { key: 'b', name: 'B', kind: 'flow' as const, assigned: false, trigger: 'deal_created', locked: null },
    { key: 'c', name: 'C', kind: 'flow' as const, assigned: false, trigger: 'y', locked: null },
    { key: 'd', name: 'D', kind: 'flow' as const, assigned: false, trigger: 'z', locked: 'won' as const },
  ];
  it('finds opportunity and won', () => {
    expect(opportunityIndex(f)).toBe(1);
    expect(wonIndex(f)).toBe(3);
    expect(opportunityIndex(f.map((s) => ({ ...s, trigger: 'x' })))).toBe(2);
  });
});
