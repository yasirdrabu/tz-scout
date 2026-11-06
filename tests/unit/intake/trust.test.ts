import { describe, expect, it } from 'vitest';
import { arrivalQuality, decayWeight, stageQualities, trustBand, trustOf, type TrustStage } from '@/modules/intake/domain/trust';
import { DEFAULT_STAGES } from '@/modules/routing/domain/pipeline';

const stages: TrustStage[] = DEFAULT_STAGES.map(({ key, kind, position, trigger }) => ({ key, kind, position, trigger }));
const qualities = stageQualities(stages);
const now = new Date('2026-11-06T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const withByHand = [...stages, { key: 'warm', kind: 'flow' as const, position: 3.5, trigger: 'by_hand' }];

const quality = (keys: string[], opts: { age?: number; declines?: Date[]; at?: Date[] } = {}) =>
  arrivalQuality({
    resolvedAt: daysAgo(opts.age ?? 60),
    entries: keys.map((stage, i) => ({ stage, at: opts.at?.[i] ?? daysAgo(50 - i) })),
    declines: opts.declines ?? [],
    stages,
    qualities,
    now,
  });

describe('trustOf', () => {
  it('is the prior with no arrivals', () => expect(trustOf([], 0)).toBe(0.6));
  it('rises with wins and falls with declines', () => {
    expect(trustOf(Array(20).fill({ quality: 1, ageDays: 0 }), 0)).toBe(0.8667);
    expect(trustOf(Array(40).fill({ quality: 0, ageDays: 0 }), 0)).toBe(0.12);
  });
  it('drops per conflict lost and never goes below 0', () => {
    expect(trustOf([], 3)).toBe(0.57);
    expect(trustOf(Array(40).fill({ quality: 0, ageDays: 0 }), 20)).toBe(0);
  });
});

describe('decayWeight', () => {
  it('halves every 180 days', () => {
    expect(decayWeight(0)).toBe(1);
    expect(decayWeight(360)).toBe(0.25);
  });
});

describe('stageQualities', () => {
  it('scores the default flow stages by trigger and skips exits', () => {
    expect(Object.fromEntries(qualities)).toEqual({ arrived: 0.1, reviewed: 0.3, assigned: 0.5, engaged: 0.7, opportunity: 0.9, won: 1 });
  });
  it('gives a by_hand stage the best quality at or before it', () => {
    expect(stageQualities(withByHand).get('warm')).toBe(0.7);
  });
});

describe('arrivalQuality', () => {
  it('scores the furthest stage entered', () => expect(quality(['arrived', 'reviewed', 'assigned'])).toBe(0.5));
  it('leaves out an undecided arrival under 30 days', () => expect(quality(['arrived'], { age: 10 })).toBeNull());
  it('scores an undecided arrival 0.10 at 30 days', () => expect(quality(['arrived'], { age: 31 })).toBe(0.1));
  it('zeroes an arrival declined at review', () => expect(quality(['arrived', 'declined'], { declines: [daysAgo(48)] })).toBe(0));
  it('zeroes a seller decline with no later progress', () => expect(quality(['arrived', 'assigned'], { declines: [daysAgo(20)] })).toBe(0));
  it('lets later progress override a decline', () => {
    const at = [daysAgo(50), daysAgo(40), daysAgo(10)];
    expect(quality(['arrived', 'declined', 'won'], { at, declines: [daysAgo(40)] })).toBe(1);
  });
  it('zeroes on a reviewer_rejects exit entry alone', () => expect(quality(['arrived', 'declined'])).toBe(0));
  it('keeps the best quality after a lost exit', () => expect(quality(['arrived', 'reviewed', 'assigned', 'lost'])).toBe(0.5));
  it('treats entering an exit as decided', () => expect(quality(['back_to_nurture'], { age: 5 })).toBe(0.1));
  it('scores a custom by_hand stage between engaged and opportunity 0.70', () => {
    const q = arrivalQuality({ resolvedAt: daysAgo(60), entries: [{ stage: 'warm', at: daysAgo(5) }], declines: [], stages: withByHand, qualities: stageQualities(withByHand), now });
    expect(q).toBe(0.7);
  });
});

describe('trustBand', () => {
  it('bands by trust and sample', () => {
    expect(trustBand(0.8, 10)).toBe('high');
    expect(trustBand(0.79, 10)).toBe('mid');
    expect(trustBand(0.59, 10)).toBe('low');
    expect(trustBand(0.9, 9)).toBe('not_enough');
  });
});
