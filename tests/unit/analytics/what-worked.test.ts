import { describe, expect, it } from 'vitest';
import { rollUp } from '@/modules/analytics/domain/what-worked';

let n = 0;
const credit = (outcomeKind: string, stepType: string | null, outcomeId = `out_${n++}`) => ({ outcomeId, outcomeKind, stepType });
const done = (n: number, channel: string) => Array.from({ length: n }, () => ({ channel }));

describe('rollUp', () => {
  it('per10 rounds to one decimal', () => {
    const w = rollUp([credit('reply', 'email'), credit('reply', 'email'), credit('meeting', 'email')], done(7, 'email'));
    expect(w.rows[0]!.per10).toEqual({ reply: 2.9, meeting: 1.4, opportunity: 0, won: 0 });
    expect(w.minSteps).toBe(10);
  });

  it('per10 is null with 0 steps done', () => {
    const w = rollUp([credit('reply', 'call')], []);
    expect(w.rows).toEqual([
      { stepType: 'call', stepsDone: 0, counts: { reply: 1, meeting: 0, opportunity: 0, won: 0 }, per10: { reply: null, meeting: null, opportunity: null, won: null } },
    ]);
  });

  it('rows keep channel order and drop all-zero channels', () => {
    const w = rollUp([credit('won', 'task'), credit('reply', 'email')], [...done(1, 'meeting'), ...done(2, 'linkedin')]);
    expect(w.rows.map((r) => r.stepType)).toEqual(['email', 'linkedin', 'meeting', 'task']);
    expect(rollUp([], []).rows).toEqual([]);
  });

  it('no_response and lost credits are not counted in rows', () => {
    const w = rollUp([credit('no_response', 'email'), credit('lost', 'email'), credit('lost', null), credit('no_response', null)], done(3, 'email'));
    expect(w.rows[0]!.counts).toEqual({ reply: 0, meeting: 0, opportunity: 0, won: 0 });
    expect(w.noRecentStep).toEqual({ reply: 0, meeting: 0, opportunity: 0, won: 0 });
  });

  it('a step credited by two outcomes counts once per outcome', () => {
    const w = rollUp([credit('reply', 'email'), credit('meeting', 'email'), credit('reply', null)], done(10, 'email'));
    expect(w.rows[0]!.counts).toEqual({ reply: 1, meeting: 1, opportunity: 0, won: 0 });
    expect(w.noRecentStep).toEqual({ reply: 1, meeting: 0, opportunity: 0, won: 0 });
  });

  it('one outcome crediting two email steps counts once under email', () => {
    const w = rollUp([credit('reply', 'email', 'o1'), credit('reply', 'email', 'o1'), credit('reply', 'call', 'o1'), credit('won', null, 'o2')], done(4, 'email'));
    expect(w.rows.map((r) => [r.stepType, r.counts.reply])).toEqual([['email', 1], ['call', 1]]);
    expect(w.rows[0]!.per10.reply).toBe(2.5);
    expect(w.noRecentStep.won).toBe(1);
  });
});
