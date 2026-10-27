import { describe, expect, it } from 'vitest';
import { BUYER_DEFINITION_FIELDS, affectsMatching, approvalProblems } from '@/modules/offers/domain/approval';

const ready = {
  promise: 'Ship an AI platform in 90 days.',
  targetTitles: ['CTO'],
  targetBuyingRoles: [] as string[],
  industries: ['logistics'],
  companySizeMin: null,
  companySizeMax: null,
  typicalDealCents: 5_000_000,
  salesCycleDays: 60,
};

describe('approvalProblems', () => {
  it('is empty for a complete offer', () => {
    expect(approvalProblems(ready)).toEqual([]);
  });

  it('asks for a promise', () => {
    expect(approvalProblems({ ...ready, promise: '  ' })).toEqual(['Add a promise before approving.']);
  });

  it('asks for a target title or buying role, and accepts either', () => {
    const none = { ...ready, targetTitles: [], targetBuyingRoles: [] };
    expect(approvalProblems(none)).toEqual(['Add at least one target title or buying role before approving.']);
    expect(approvalProblems({ ...none, targetBuyingRoles: ['business_owner'] })).toEqual([]);
  });

  it('asks for industries or a company size range, and accepts either', () => {
    const none = { ...ready, industries: [] };
    expect(approvalProblems(none)).toEqual(['Add industries or a company size range before approving.']);
    expect(approvalProblems({ ...none, companySizeMin: 50 })).toEqual([]);
    expect(approvalProblems({ ...none, companySizeMax: 500 })).toEqual([]);
  });

  it('asks for a typical deal size', () => {
    expect(approvalProblems({ ...ready, typicalDealCents: null })).toEqual(['Add a typical deal size before approving.']);
    expect(approvalProblems({ ...ready, typicalDealCents: 0 })).toEqual(['Add a typical deal size before approving.']);
  });

  it('asks for the sales cycle in days', () => {
    expect(approvalProblems({ ...ready, salesCycleDays: null })).toEqual(['Add the sales cycle in days before approving.']);
  });

  it('lists every problem in order', () => {
    expect(
      approvalProblems({
        promise: '',
        targetTitles: [],
        targetBuyingRoles: [],
        industries: [],
        companySizeMin: null,
        companySizeMax: null,
        typicalDealCents: null,
        salesCycleDays: null,
      }),
    ).toEqual([
      'Add a promise before approving.',
      'Add at least one target title or buying role before approving.',
      'Add industries or a company size range before approving.',
      'Add a typical deal size before approving.',
      'Add the sales cycle in days before approving.',
    ]);
  });
});

describe('affectsMatching', () => {
  const before = { ...ready, regions: ['EU'] };

  it('names the buyer definition fields', () => {
    expect([...BUYER_DEFINITION_FIELDS]).toEqual([
      'industries',
      'companySizeMin',
      'companySizeMax',
      'revenueMinCents',
      'revenueMaxCents',
      'regions',
      'targetTitles',
      'targetBuyingRoles',
      'excludedDomains',
      'excludedCategories',
    ]);
  });

  it('is true when a buyer definition field changes', () => {
    expect(affectsMatching({ industries: ['retail'] }, before)).toBe(true);
    expect(affectsMatching({ regions: ['EU', 'US'] }, before)).toBe(true);
  });

  it('is false for other fields', () => {
    expect(affectsMatching({ promise: 'A new promise.' }, before)).toBe(false);
    expect(affectsMatching({ typicalDealCents: 1 }, before)).toBe(false);
  });

  it('is false when a buyer definition field is set to its current value', () => {
    expect(affectsMatching({ industries: ['logistics'], regions: ['EU'] }, before)).toBe(false);
  });
});
