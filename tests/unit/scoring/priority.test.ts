import { describe, expect, it } from 'vitest';
import { priority } from '@/modules/scoring/domain/priority';
import type { Tier } from '@/modules/scoring/contracts/types';
import { profile } from './fixtures';

const p = (matchTotal: number, warmPoints: number, trust: number | null, finalTier: Tier = 'good_fit') =>
  priority({ matchTotal, finalTier, warmPoints, trust }, profile);

describe('priority', () => {
  it('SCO-E2-S1-AC2: 65 + 8 warm + trust 0.72 gives 76', () => {
    expect(p(65, 8, 0.72)).toEqual({ priority: 76, warmPoints: 8, trustModifier: 3 });
  });
  it('SCO-E2-S1-AC3: 98 + 15 + trust 0.9 clamps to 100', () => {
    expect(p(98, 15, 0.9).priority).toBe(100);
  });
  it('SCO-E2-S1-AC4: a not fit equals the match total despite a warm intro and trust', () => {
    expect(p(38, 15, 0.9, 'not_fit')).toEqual({ priority: 38, warmPoints: 0, trustModifier: 0 });
  });
  it('SCO-E2-S2-AC1: warm points above the cap are capped', () => {
    expect(p(50, 35, null)).toEqual({ priority: 70, warmPoints: 20, trustModifier: 0 });
  });
  it('SCO-E2-S3-AC1: trust to modifier', () => {
    const mod = (trust: number) => p(50, 0, trust).trustModifier;
    expect(mod(0.6)).toBe(0);
    expect(mod(0.8)).toBe(5);
    expect(mod(0.4)).toBe(-5);
    expect(mod(1.0)).toBe(5);
    expect(mod(0.0)).toBe(-5);
  });
  it('rounds half away from zero and never returns -0', () => {
    expect(Object.is(p(50, 0, 0.59).trustModifier, 0)).toBe(true);
    expect(p(50, 0, 0.58).trustModifier).toBe(-1);
    expect(p(50, 0, 0.62).trustModifier).toBe(1);
  });
  it('no trust leaves priority at the total plus warm points', () => {
    expect(p(50, 5, null)).toEqual({ priority: 55, warmPoints: 5, trustModifier: 0 });
  });
  it('clamps at 0', () => {
    expect(p(2, 0, 0.0).priority).toBe(0);
  });
  it('a fit-38 account lifted by the research floor gets the warm and trust adjustments', () => {
    expect(p(38, 10, 0.8, 'act_now')).toEqual({ priority: 53, warmPoints: 10, trustModifier: 5 });
  });
});
