import { describe, expect, it } from 'vitest';
import { fit, industryMatches, titleMatches } from '@/modules/scoring/domain/fit';
import { account, offer, person, profile } from './fixtures';

const score = (a = account(), o = offer()) => fit(a, o, profile);
const part = (r: ReturnType<typeof fit>, key: string) => r.parts.find((p) => p.key === key)!;
const coo = [person('Chief Operating Officer')];

describe('fit', () => {
  it('a perfect fit with a buyer on file scores 100', () => {
    expect(score(account({ people: coo })).fit).toBe(100);
  });
  it('no buyer contact yet costs 15', () => {
    expect(score().fit).toBe(85);
  });
  it('unknowns earn half credit', () => {
    const r = score(account({ industry: null, employees: null, revenueCents: null, country: null }));
    expect(r.fit).toBe(15 + 12 + 10 + 5);
    expect(r.hardMiss).toBe(false);
  });
  it('wrong industry and out-of-range size lose those points', () => {
    const r = score(account({ industry: 'Retail', employees: 40 }));
    expect(part(r, 'industry').points).toBe(0);
    expect(part(r, 'size').points).toBe(0);
  });
  it('SCO-E1-S1-AC5: a known wrong industry caps fit at 45 even when everything else fits', () => {
    const r = score(account({ industry: 'Logistics', people: [person('COO')] }), offer({ industries: ['Healthcare'] }));
    expect(r.fit).toBe(45);
    expect(r.hardMiss).toBe(true);
    expect(score(account({ employees: 9000, people: [person('COO')] })).fit).toBe(45);
  });
  it('just outside the size range gets partial credit', () => {
    expect(part(score(account({ employees: 80 })), 'size').points).toBe(10);
    expect(part(score(account({ employees: 3000 })), 'size').points).toBe(10);
  });
  it('SCO-E1-S1-AC4: an excluded domain gives fit 0 and names the domain', () => {
    const r = score(account({ domain: 'taazaa.com' }));
    expect(r.fit).toBe(0);
    expect(r.disqualifiedReason).toContain('taazaa.com');
  });
  it('an excluded category disqualifies', () => {
    const r = score(account({ industry: 'Gambling' }));
    expect(r.fit).toBe(0);
    expect(r.disqualifiedReason).toContain('Gambling');
    expect(r.parts).toHaveLength(5);
    expect(r.parts.every((p) => p.points === 0 && p.note === r.disqualifiedReason)).toBe(true);
  });
  it('an account excluded for every offer disqualifies with its label', () => {
    const r = score(account({ excluded: { label: 'Software vendor' } }));
    expect(r.fit).toBe(0);
    expect(r.disqualifiedReason).toContain('Software vendor');
  });
  it('US aliases are equal', () => {
    for (const country of ['USA', 'US', 'U.S.', 'United States of America']) {
      expect(part(score(account({ country })), 'region').points).toBe(10);
    }
    expect(part(score(account({ country: 'Canada' })), 'region').points).toBe(0);
  });
  it('a buyer is found by title or by buying role', () => {
    expect(part(score(account({ people: [person('Janitor', ['business_owner'])] }), offer({ targetBuyingRoles: ['business_owner'] })), 'buyer').points).toBe(15);
    expect(part(score(account({ people: [person('Janitor', ['user'])] }), offer({ targetBuyingRoles: ['business_owner'] })), 'buyer').points).toBe(0);
  });
  it('part maxes come from the profile', () => {
    const p = { ...profile, fitParts: { industry: 20, size: 20, revenue: 20, region: 20, buyer: 20 } };
    expect(fit(account({ people: coo }), offer(), p).fit).toBe(100);
    expect(part(fit(account({ industry: null }), offer(), p), 'industry').points).toBe(10);
  });
});

describe('matching helpers', () => {
  it('industry matching is loose', () => {
    expect(industryMatches('Commercial real estate', 'Real estate')).toBe(true);
    expect(industryMatches('Healthcare services', 'Hospital and healthcare')).toBe(true);
    expect(industryMatches('Logistics', 'Retail')).toBe(false);
    expect(industryMatches('Government', 'Government transit')).toBe(true);
  });
  it('title matching by function', () => {
    expect(titleMatches('Chief Operating Officer', ['COO'])).toBe(true);
    expect(titleMatches('VP of Operations', ['VP Operations'])).toBe(true);
    expect(titleMatches('VP Sales', ['COO', 'VP Operations'])).toBe(false);
  });
});
