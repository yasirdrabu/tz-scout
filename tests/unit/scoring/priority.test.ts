import { describe, expect, it } from 'vitest';
import { priority } from '@/modules/scoring/domain/priority';
import type { Tier } from '@/modules/scoring/contracts/types';
import { applyFloors } from '@/modules/scoring/domain/tiers';
import { daysAgo, NOW, profile } from './fixtures';

const p = (score: number, warmPoints: number, finalTier: Tier = 'good_fit') => priority({ score, finalTier, warmPoints }, profile);

describe('priority', () => {
  it('SCO-E6-S3-AC1: score 62 and warm points 8 give 70', () => {
    expect(p(62, 8)).toEqual({ priority: 70, warmPoints: 8 });
  });
  it('SCO-E6-S3-AC2: score 96 and warm points 15 clamp to 100', () => {
    expect(p(96, 15).priority).toBe(100);
  });
  it('a not fit equals the score despite a warm intro', () => {
    expect(p(38, 15, 'not_fit')).toEqual({ priority: 38, warmPoints: 0 });
  });
  it('warm points above the cap are capped', () => {
    expect(p(50, 35)).toEqual({ priority: 70, warmPoints: 20 });
  });
  it('no warm intro leaves priority at the score', () => {
    expect(p(50, 0)).toEqual({ priority: 50, warmPoints: 0 });
  });
  it('floors then priority: a fit-38 account lifted by the research floor gets warm points', () => {
    const floored = applyFloors(
      'not_fit',
      { disqualified: false, researchTier: 'A', researchSignalAt: daysAgo(30), warmIntro: false, bestFit: 38 },
      profile,
      NOW,
    );
    expect(floored.tier).toBe('act_now');
    expect(priority({ score: 38, finalTier: floored.tier, warmPoints: 10 }, profile)).toEqual({ priority: 48, warmPoints: 10 });
  });
});
