import { describe, expect, it } from 'vitest';
import type { Stage } from '@/modules/routing/contracts/types';
import { nextStage, type StageEvent } from '@/modules/routing/domain/stages';

describe('nextStage', () => {
  const forward: [Stage, StageEvent, Stage][] = [
    ['arrived', 'reviewed', 'reviewed'],
    ['arrived', 'assigned', 'assigned'],
    ['reviewed', 'assigned', 'assigned'],
    ['arrived', 'engaged', 'engaged'],
    ['assigned', 'engaged', 'engaged'],
    ['assigned', 'opportunity', 'opportunity'],
    ['engaged', 'opportunity', 'opportunity'],
    ['opportunity', 'won', 'won'],
    ['opportunity', 'lost', 'lost'],
    ['lost', 'opportunity', 'opportunity'],
    ['arrived', 'declined', 'declined'],
    ['reviewed', 'declined', 'declined'],
    ['assigned', 'declined', 'declined'],
  ];
  it.each(forward)('%s + %s moves to %s', (from, event, to) => {
    expect(nextStage(from, event)).toBe(to);
  });

  const returns: [Stage, StageEvent, Stage][] = [
    ['assigned', 'assignment_declined', 'reviewed'],
    ['assigned', 'withdrawn', 'reviewed'],
    ['declined', 'reopened', 'arrived'],
  ];
  it.each(returns)('%s + %s returns to %s', (from, event, to) => {
    expect(nextStage(from, event)).toBe(to);
  });

  it('never moves backwards otherwise', () => {
    expect(nextStage('assigned', 'reviewed')).toBeNull();
    expect(nextStage('engaged', 'assigned')).toBeNull();
    expect(nextStage('opportunity', 'engaged')).toBeNull();
    expect(nextStage('won', 'opportunity')).toBeNull();
    expect(nextStage('won', 'lost')).toBeNull();
    expect(nextStage('engaged', 'withdrawn')).toBeNull();
    expect(nextStage('reviewed', 'reopened')).toBeNull();
  });

  it('does nothing when the stage would not change', () => {
    expect(nextStage('reviewed', 'reviewed')).toBeNull();
    expect(nextStage('assigned', 'assigned')).toBeNull();
  });

  it('ignores a late assigned or engaged after declined', () => {
    expect(nextStage('declined', 'assigned')).toBeNull();
    expect(nextStage('declined', 'engaged')).toBeNull();
    expect(nextStage('declined', 'reviewed')).toBeNull();
  });

  it('does nothing for declined + withdraw or assignment decline', () => {
    expect(nextStage('declined', 'withdrawn')).toBeNull();
    expect(nextStage('declined', 'assignment_declined')).toBeNull();
  });
});
