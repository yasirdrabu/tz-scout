import { describe, expect, it } from 'vitest';
import type { Match } from '@/modules/scoring/contracts/types';
import { bestOffer } from '@/modules/scoring/domain/best-offer';

const m = (offerId: string, total: number, tier: Match['tier'], fit = 70): Match => ({ offerId, fit, intent: 40, total, tier });

describe('bestOffer', () => {
  it('SCO-E3-S2-AC1: equal totals pick the better tier', () => {
    expect(bestOffer([m('x', 62, 'good_fit'), m('y', 62, 'act_now')], ['x', 'y'])?.offerId).toBe('y');
  });
  it('picks the highest total first', () => {
    expect(bestOffer([m('x', 60, 'act_now'), m('y', 61, 'watch')], ['x', 'y'])?.offerId).toBe('y');
  });
  it('then the higher fit', () => {
    expect(bestOffer([m('x', 62, 'good_fit', 65), m('y', 62, 'good_fit', 70)], ['x', 'y'])?.offerId).toBe('y');
  });
  it('then the offer approved first', () => {
    expect(bestOffer([m('x', 62, 'good_fit'), m('y', 62, 'good_fit')], ['y', 'x'])?.offerId).toBe('y');
  });
  it('is null with no matches and does not reorder its input', () => {
    expect(bestOffer([], [])).toBeNull();
    const list = [m('x', 50, 'watch'), m('y', 60, 'watch')];
    bestOffer(list, []);
    expect(list.map((r) => r.offerId)).toEqual(['x', 'y']);
  });
});
