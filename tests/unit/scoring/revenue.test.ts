import { describe, expect, it } from 'vitest';
import { revenuePotential, trustScore } from '@/modules/scoring/domain/revenue';
import { profile } from './fixtures';

const input = { typicalDealCents: 5_000_000, priceMinCents: null, expansionRate: null, sizeMin: 100, sizeMax: 2500, employees: 1500, referenceCents: null };

describe('revenuePotential', () => {
  it('SCO-E6-S2-AC1: above the size range against a 48,000 reference scores 78, medium', () => {
    expect(revenuePotential({ ...input, employees: 3000, referenceCents: 4_800_000 })).toEqual({ score: 78, cents: 7_500_000, band: 'medium', reason: null });
  });
  it('SCO-E6-S2-AC2: within the range and no reference scores 50', () => {
    expect(revenuePotential(input)).toEqual({ score: 50, cents: 5_000_000, band: 'medium', reason: null });
  });
  it('SCO-E6-S2-AC3: no deal size and no price minimum scores 50 with a reason and no band', () => {
    expect(revenuePotential({ ...input, typicalDealCents: null })).toEqual({ score: 50, cents: null, band: null, reason: 'no_deal_size' });
  });
  it('falls back to the price minimum when there is no typical deal', () => {
    expect(revenuePotential({ ...input, typicalDealCents: null, priceMinCents: 2_000_000 }).cents).toBe(2_000_000);
  });
  it('below the size midpoint takes 0.75; the midpoint itself is within', () => {
    expect(revenuePotential({ ...input, employees: 1299 }).cents).toBe(3_750_000);
    expect(revenuePotential({ ...input, employees: 1300 }).cents).toBe(5_000_000);
  });
  it('an unknown size or size range takes 1', () => {
    expect(revenuePotential({ ...input, employees: null }).cents).toBe(5_000_000);
    expect(revenuePotential({ ...input, sizeMin: null, sizeMax: null }).cents).toBe(5_000_000);
  });
  it('expansion adds a share of the base', () => {
    expect(revenuePotential({ ...input, expansionRate: 0.2 }).cents).toBe(6_000_000);
  });
  it('twice the reference is 100 and high; the score never passes 100', () => {
    expect(revenuePotential({ ...input, employees: 3000, expansionRate: 0.5 })).toMatchObject({ score: 100, band: 'high' });
  });
  it('38 is medium and 37 is low', () => {
    expect(revenuePotential({ ...input, referenceCents: 6_578_948 })).toMatchObject({ score: 38, band: 'medium' });
    expect(revenuePotential({ ...input, referenceCents: 6_700_000 })).toMatchObject({ score: 37, band: 'low' });
  });
});

describe('trustScore', () => {
  it('is the trust times 100, and the neutral value when unknown', () => {
    expect(trustScore(0.72, profile)).toBe(72);
    expect(trustScore(null, profile)).toBe(60);
  });
});
