import { describe, expect, it } from 'vitest';
import { isFreeEmailDomain } from '@/modules/intake/domain/free-email';
import { industryKey } from '@/modules/intake/domain/industry';
import { countryCode, domainFromEmail, normaliseDomain, parseRange } from '@/modules/intake/domain/normalise';

describe('normaliseDomain', () => {
  it.each([
    ['HTTP://WWW.Example.CO.UK/about?x=1', 'example.co.uk'],
    ['example.com.', 'example.com'],
    ['example.com:8080', 'example.com'],
    ['mailto:a@b.com', null],
    ['192.168.0.1', null],
    ['not a url', null],
    ['gmail.com', null],
    ['https://www.miamidade.gov/global/transportation/home.page', 'miamidade.gov'],
    ['  Acme.COM ', 'acme.com'],
    ['https://blog.acme.com/post', 'acme.com'],
    ['', null],
    [null, null],
    [undefined, null],
  ])('%s gives %s', (input, expected) => {
    expect(normaliseDomain(input)).toBe(expected);
  });
});

describe('email domains', () => {
  it('reads the domain after the @', () => {
    expect(domainFromEmail('Ada@Acme.com')).toBe('acme.com');
    expect(domainFromEmail('nobody')).toBeNull();
    expect(domainFromEmail(null)).toBeNull();
  });
  it('knows the free providers', () => {
    expect(isFreeEmailDomain('Gmail.com')).toBe(true);
    expect(isFreeEmailDomain('acme.com')).toBe(false);
  });
});

describe('countryCode', () => {
  it.each([
    ['United States', 'US'],
    ['USA', 'US'],
    ['us', 'US'],
    ['United Kingdom', 'GB'],
    ['GB', 'GB'],
    ['Narnia', null],
    ['', null],
  ])('%s gives %s', (input, expected) => {
    expect(countryCode(input)).toBe(expected);
  });
});

describe('parseRange', () => {
  it.each([
    ['501-1000', { min: 501, max: 1000 }],
    ['10001+', { min: 10001, max: null }],
    ['75M-200M', { min: 75_000_000, max: 200_000_000 }],
    ['[201-500]', { min: 201, max: 500 }],
    ['1,001 - 5,000', { min: 1001, max: 5000 }],
    ['$1.5M-$3B', { min: 1_500_000, max: 3_000_000_000 }],
    ['lots', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(parseRange(input)).toEqual(expected);
  });
});

describe('industryKey', () => {
  it.each(['5112', '5132', '5182', '54151', '541511'])('NAICS %s is software', (naics) => {
    expect(industryKey(naics)).toBe('software');
  });
  it('maps LinkedIn categories and offer words', () => {
    expect(industryKey('Software Development')).toBe('software');
    expect(industryKey('Commercial real estate')).toBe('commercial_real_estate');
    expect(industryKey('Healthcare services: hospitals')).toBe('healthcare_services');
    expect(industryKey('Logistics and transportation')).toBe('logistics');
    expect(industryKey('IT Services and IT Consulting')).toBe('it_services');
  });
  it('uses the longest NAICS prefix', () => {
    expect(industryKey('5311')).toBe('commercial_real_estate');
    expect(industryKey('5312')).toBe('real_estate');
    expect(industryKey('5411')).toBe('legal_services');
    expect(industryKey('5416')).toBe('professional_services');
  });
  it('leaves unknown text unmapped', () => {
    expect(industryKey('Underwater basket weaving')).toBeNull();
    expect(industryKey('')).toBeNull();
  });
});
