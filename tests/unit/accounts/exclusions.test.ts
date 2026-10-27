import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUSION_RULES, VENDOR_PHRASES } from '@/modules/accounts/defaults';
import { evaluateExclusions, type ExclusionInput } from '@/modules/accounts/domain/exclusions';

const rules = DEFAULT_EXCLUSION_RULES.map((r) => ({ key: r.key, enabled: true }));
const lists = [
  ...VENDOR_PHRASES.map((value) => ({ kind: 'vendor_keyword', value })),
  { kind: 'parent_domain', value: 'hcahealthcare.com' },
  { kind: 'do_not_contact_domain', value: 'blocked.com' },
];
const input = (o: Partial<ExclusionInput>): ExclusionInput => ({
  industryKey: null,
  description: null,
  keywords: [],
  name: 'X',
  parentDomain: null,
  parentName: null,
  domain: 'x.com',
  crmStatus: 'none',
  ...o,
});
const run = (o: Partial<ExclusionInput>, r = rules) => evaluateExclusions(input(o), r, lists);

describe('software_vendor (v1 fixtures; a vendor NAICS or LinkedIn category becomes industryKey software)', () => {
  it('Qventus: description "uses AI to intelligently automate operations"', () => {
    expect(
      run({ name: 'Qventus', description: 'Qventus uses AI to intelligently automate operations across care settings' }),
    ).toBe('software_vendor');
  });
  it('Navis: description "...supply chain execution software platform"', () => {
    expect(
      run({
        name: 'Navis',
        description: 'Navis is the premier brand of TOS under the Kaleris supply chain execution software platform.',
      }),
    ).toBe('software_vendor');
  });
  it('X: NAICS 541511, so industryKey software', () => {
    expect(run({ industryKey: 'software' })).toBe('software_vendor');
  });
  it('a vendor phrase in keywords counts', () => {
    expect(run({ keywords: ['SaaS', 'logistics'] })).toBe('software_vendor');
  });
});

describe('unit_of_parent (v1 fixtures; the description text supplies parentName)', () => {
  it('Sunrise Hospital: parentName "HCA Healthcare"', () => {
    expect(run({ name: 'Sunrise Hospital', parentName: 'HCA Healthcare' })).toBe('unit_of_parent');
  });
  it('Allied Air: parentName "Lennox International"', () => {
    expect(run({ name: 'Allied Air', parentName: 'Lennox International' })).toBe('unit_of_parent');
  });
  it('a listed parent domain counts even with no parent name', () => {
    expect(run({ parentDomain: 'hcahealthcare.com' })).toBe('unit_of_parent');
  });
});

describe('operators are left alone', () => {
  it('Kairoi Residential: industryKey real_estate, no parent', () => {
    expect(
      run({
        name: 'Kairoi Residential',
        industryKey: 'real_estate',
        description: 'Kairoi Residential is a partner-led company investing in, developing, and managing multifamily communities.',
      }),
    ).toBeNull();
  });
  it('Emerson Health: industryKey healthcare, no parent', () => {
    expect(
      run({
        name: 'Emerson Health',
        industryKey: 'healthcare',
        description: 'Emerson Hospital has proudly served our community for more than a century.',
      }),
    ).toBeNull();
  });
});

describe('crm status, domain list and rule order', () => {
  it('existing_customer, open_deal and domain_listed', () => {
    expect(run({ crmStatus: 'customer' })).toBe('existing_customer');
    expect(run({ crmStatus: 'open_deal' })).toBe('open_deal');
    expect(run({ domain: 'Blocked.com' })).toBe('domain_listed');
  });
  it('the first matching rule in ACC-E7 order wins', () => {
    expect(run({ industryKey: 'software', crmStatus: 'customer', domain: 'blocked.com' })).toBe('software_vendor');
    expect(run({ parentName: 'P', crmStatus: 'customer' })).toBe('unit_of_parent');
  });
  it('a disabled rule is skipped', () => {
    const off = rules.map((r) => (r.key === 'software_vendor' ? { ...r, enabled: false } : r));
    expect(run({ industryKey: 'software' }, off)).toBeNull();
  });
});
