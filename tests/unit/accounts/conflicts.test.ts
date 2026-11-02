import { describe, expect, it } from 'vitest';
import { differs, toleranceFor } from '@/modules/accounts/domain/conflicts';

describe('toleranceFor', () => {
  it.each([
    ['employees', { kind: 'count', percent: 20 }],
    ['revenue_cents', { kind: 'money', percent: 25 }],
    ['contract_value_cents', { kind: 'money', percent: 10 }],
    ['budget_cents', { kind: 'money', percent: 10 }],
    ['price_cents', { kind: 'money', percent: 10 }],
    ['industry_key', { kind: 'category' }],
    ['hq_country', { kind: 'category' }],
    ['email', { kind: 'contact' }],
    ['phone', { kind: 'contact' }],
    ['mobile_phone', { kind: 'contact' }],
    ['title', { kind: 'contact' }],
  ])('%s can conflict', (key, expected) => {
    expect(toleranceFor(key)).toEqual(expected);
  });
  it.each(['description', 'technologies', 'employees_min', 'employees_max', 'revenue_min_cents', 'revenue_max_cents', 'name'])(
    '%s never conflicts',
    (key) => expect(toleranceFor(key)).toBeNull(),
  );
});

describe('differs', () => {
  it('counts: 3,000 vs 3,500 is 14.3%, within 20%', () => {
    expect(differs('employees', 3000, 3500)).toBe(false);
    expect(differs('employees', 100, 200)).toBe(true);
  });
  it('money: $20.9M vs $18.4M contract value is 12.0%, beyond 10%', () => {
    expect(differs('contract_value_cents', 2_090_000_000, 1_840_000_000)).toBe(true);
  });
  it('revenue uses 25%, measured against the larger value', () => {
    expect(differs('revenue_cents', 100, 133)).toBe(false); // 24.8%
    expect(differs('revenue_cents', 100, 134)).toBe(true); // 25.4%
  });
  it('equal values and zeros do not differ', () => {
    expect(differs('employees', 0, 0)).toBe(false);
    expect(differs('employees', 50, 50)).toBe(false);
  });
  it('categories differ on any change', () => {
    expect(differs('industry_key', 'transit', 'transit')).toBe(false);
    expect(differs('industry_key', 'transit', 'water')).toBe(true);
  });
  it('contact values compare after normalising', () => {
    expect(differs('email', 'A@x.gov ', 'a@x.gov')).toBe(false);
    expect(differs('email', 'a@x.gov', 'b@x.gov')).toBe(true);
    expect(differs('title', ' CIO ', 'cio')).toBe(false);
    expect(differs('phone', '(305) 555-0100', '305.555.0100')).toBe(false);
    expect(differs('mobile_phone', '305-555-0100', '305-555-0101')).toBe(true);
  });
  it('null or non-number count/money values never differ', () => {
    expect(differs('employees', null, 100)).toBe(false);
    expect(differs('revenue_cents', 100, 'lots')).toBe(false);
    expect(differs('budget_cents', undefined, 5)).toBe(false);
  });
  it('keys that never conflict never differ', () => {
    expect(differs('description', 'a', 'b')).toBe(false);
    expect(differs('employees_min', 1, 100)).toBe(false);
  });
});
