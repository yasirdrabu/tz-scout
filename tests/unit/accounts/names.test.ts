import { describe, expect, it } from 'vitest';
import { matchName, regionKey, splitName, trigramSimilarity } from '@/modules/accounts/domain/names';

describe('splitName', () => {
  it('splits first and last, keeping extra words in the last name', () => {
    expect(splitName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(splitName('  Mary Ann  Smith ')).toEqual({ firstName: 'Mary', lastName: 'Ann Smith' });
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null });
  });
});

describe('matchName', () => {
  it('drops a trailing legal suffix', () => {
    expect(matchName('Keystone Ridge Properties LLC')).toBe(matchName('Keystone Ridge Properties'));
    expect(matchName('Acme, Inc.')).toBe('acme');
  });
  it('treats hyphens as spaces', () => {
    expect(matchName('Miami-Dade County')).toBe(matchName('Miami Dade County'));
  });
});

describe('trigramSimilarity', () => {
  it('is high for near names, low for different ones, zero for disjoint', () => {
    expect(trigramSimilarity('Keystone Ridge Properties', 'Keystone Ridge Property')).toBeGreaterThan(0.75); // pg_trgm gives 0.786, not above 0.85
    expect(trigramSimilarity('Keystone Ridge Properties', 'Harbor Point Holdings')).toBeLessThan(0.2);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    expect(trigramSimilarity('Same Name', 'same name')).toBe(1);
  });
  it('matches the pg_trgm value for a known pair', () => {
    // select similarity('word', 'two words') = 0.36363637 in Postgres
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(0.3636, 3);
  });
});

describe('regionKey', () => {
  it('maps a US state name or code to US-XX', () => {
    expect(regionKey('United States', 'Florida')).toBe('US-FL');
    expect(regionKey('US', 'FL')).toBe('US-FL');
    expect(regionKey('USA', 'fl')).toBe('US-FL');
  });
  it('upper-cases other countries and is null when either is missing', () => {
    expect(regionKey('ca', 'Ontario')).toBe('CA-ONTARIO');
    expect(regionKey(null, 'FL')).toBeNull();
    expect(regionKey('US', null)).toBeNull();
  });
});
