import { describe, expect, it } from 'vitest';
import type { Journey } from '@/modules/analytics/services/journeys';
import {
  costStatus, insight, lostAt, ratio, reachedIndex, rollUp, spendBySource, stageCounts, stepPct, type StageDef,
} from '@/modules/analytics/domain/funnel';

const flow: StageDef[] = [
  { key: 'sent', name: 'Sent', kind: 'flow', assigned: false },
  { key: 'reviewed', name: 'Reviewed', kind: 'flow', assigned: false },
  { key: 'assigned', name: 'Assigned', kind: 'flow', assigned: true },
  { key: 'won', name: 'Won', kind: 'flow', assigned: false },
];
const at = new Date('2026-10-01T00:00:00Z');
const j = (keys: string[], exitStage: string | null = null): Journey => ({
  accountId: 'a', firstSourceId: 's', firstBatchId: null, arrivedAt: at, practiceId: null, offerId: null,
  exitStage, exitAt: exitStage ? at : null, stages: new Map(keys.map((k) => [k, at])), deals: [],
});

describe('funnel counts', () => {
  it('a skipped stage counts as passed', () => {
    expect(reachedIndex(j(['assigned']), flow)).toBe(2);
    expect(stageCounts([j(['assigned'])], flow)).toEqual([1, 1, 1, 0]);
  });
  it('step percentages', () => {
    expect(stepPct([10, 6, 3, 0])).toEqual([null, 60, 50, 0]);
    expect(stepPct([0, 0])).toEqual([null, null]);
  });
  it('every journey reaches position 0, unknown keys are ignored, a rename keeps the count', () => {
    expect(reachedIndex(j([]), flow)).toBe(0);
    expect(reachedIndex(j(['deleted_stage']), flow)).toBe(0);
    const renamed = flow.map((s) => (s.key === 'reviewed' ? { ...s, name: 'Looked at' } : s));
    expect(stageCounts([j(['reviewed'])], renamed)).toEqual([1, 1, 0, 0]);
  });
  it('lostAt counts journeys with an exit at their furthest stage', () => {
    const js = [j(['reviewed'], 'lost'), j(['reviewed'], 'lost'), j(['reviewed']), j(['assigned'], 'lost')];
    expect(lostAt(js, flow)).toEqual([0, 2, 1, 0]);
  });
  it('ratio rounds and guards zero', () => {
    expect(ratio(10, 3)).toBe(3);
    expect(ratio(1, 0)).toBeNull();
  });
});

describe('rollUp', () => {
  it('returns the source and descendants, safe against cycles', () => {
    const tree = new Map([['a', ['b', 'c']], ['b', ['d']], ['d', ['a']]]);
    expect([...rollUp('a', tree)].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...rollUp('x', tree)]).toEqual(['x']);
  });
});

describe('spendBySource', () => {
  it('attributes by source, then first source of the account, else shared; totals add up', () => {
    const lines = [
      { amountCents: 100, sourceId: 's1', accountId: 'a1' },
      { amountCents: 200, sourceId: null, accountId: 'a1' },
      { amountCents: 300, sourceId: null, accountId: null },
      { amountCents: 400, sourceId: null, accountId: 'missing' },
      { amountCents: 50, sourceId: 's2', accountId: null },
    ];
    const r = spendBySource(lines, new Map([['a1', 's2']]));
    expect(r.bySource.get('s1')).toBe(100);
    expect(r.bySource.get('s2')).toBe(250);
    expect(r.shared).toBe(700);
    expect([...r.bySource.values()].reduce((a, b) => a + b, 0) + r.shared).toBe(1050);
  });
});

describe('costStatus', () => {
  it('checks in order', () => {
    expect(costStatus(9, 1, 100, 200000)).toBe('not_enough_data');
    expect(costStatus(10, 0, null, 200000)).toBe('no_wins');
    expect(costStatus(10, 1, 100, null)).toBe('no_target');
    expect(costStatus(10, 1, 200000, 200000)).toBe('good');
    expect(costStatus(10, 1, 300000, 200000)).toBe('amber');
    expect(costStatus(10, 1, 300001, 200000)).toBe('red');
  });
});

describe('insight', () => {
  const names = ['Sent', 'Reviewed', 'Assigned', 'Won'];
  it('too early under 10 sent', () => expect(insight([9, 5], ['Sent', 'Won'], 9)).toBe('Too early to judge.'));
  it('names the step with most losses, earliest on a tie', () => {
    expect(insight([40, 30, 10, 8], names, 40)).toBe('Most accounts stall between Reviewed and Assigned.');
    expect(insight([40, 30, 20, 10], names, 40)).toBe('Most accounts stall between Sent and Reviewed.');
  });
  it('null with no losses', () => expect(insight([40, 40, 40, 40], names, 40)).toBeNull());
});
