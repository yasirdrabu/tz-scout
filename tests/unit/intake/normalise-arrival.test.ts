import { describe, expect, it } from 'vitest';
import { ArrivalV1Schema } from '@/modules/intake/contracts/arrival';
import { lockKeyOf, normaliseArrival, revive, unmapped, waitingFor, withInput } from '@/modules/intake/domain/normalise-arrival';

const parse = (body: unknown, strict = false) => ArrivalV1Schema({ strict }).parse(body);

describe('normaliseArrival', () => {
  it('maps the account, people, signals, facts and research for Accounts', () => {
    const n = normaliseArrival(
      parse({
        account: {
          name: ' Miami-Dade County DTPW ',
          website: 'https://www.miamidade.gov/global/transportation/home.page',
          country: 'United States',
          region: 'FL',
          city: 'Miami',
          industry: 'Public transportation',
          employees_range: '1001-5000',
          revenue_range: '75M-200M',
          practice_hint: 'ai-operating-platforms',
        },
        people: [{ name: 'Jarice Rodriguez', email: 'JR@miamidade.gov', buying_role: 'business_owner', notes: 'Leads STS' }],
        signals: [{ type: 'trigger', title: 'Re-solicitation', occurred_at: '2026-06-02', confidence: 0.9 }],
        facts: { contract_value_cents: 2090000000, not_a_key: 1 },
        research: { hook: 'h', pilot: null },
      }),
      null,
    );
    expect(n.account).toEqual({
      name: 'Miami-Dade County DTPW',
      domain: 'miamidade.gov',
      websiteUrl: 'https://www.miamidade.gov/global/transportation/home.page',
      industry: 'Public transportation',
      industryKey: 'transportation',
      employeesMin: 1001,
      employeesMax: 5000,
      revenueMinCents: 7_500_000_000,
      revenueMaxCents: 20_000_000_000,
      hqCity: 'Miami',
      hqState: 'FL',
      hqCountry: 'US',
    });
    expect(n.people).toEqual([
      { firstName: 'Jarice', lastName: 'Rodriguez', email: 'jr@miamidade.gov', roleKeys: ['business_owner'], decisionNote: 'Leads STS' },
    ]);
    expect(n.signals).toEqual([{ kind: 'trigger', title: 'Re-solicitation', occurredAt: new Date('2026-06-02'), confidence: 0.9 }]);
    expect(n.facts).toEqual([{ key: 'contract_value_cents', value: 2090000000 }]);
    expect(n.research).toEqual({ hook: 'h' });
    expect(n.practiceHint).toBe('ai-operating-platforms');
  });

  it('takes the domain from a work email, never from a free one or for a sole proprietor', () => {
    expect(normaliseArrival(parse({ account: { name: 'A' }, people: [{ email: 'a@gmail.com' }, { email: 'b@acme.com' }] }), null).account.domain).toBe('acme.com');
    expect(normaliseArrival(parse({ sole_proprietor: true, people: [{ name: 'Sam', email: 'sam@acme.com' }] }), null).account.domain).toBeUndefined();
  });

  it('maps a relationship by rule, then by the AI key, else other; and asks the AI only for unmapped text', () => {
    const body = (relationship: string) => parse({ account: { name: 'A', industry: 'Widgets' }, warm_intro: { introducer_name: 'Ash', relationship } });
    expect(normaliseArrival(body('a former colleague'), null).warmIntro?.relationshipKey).toBe('employee_network');
    expect(unmapped(body('a former colleague'))).toEqual({ industry: 'Widgets' });
    expect(unmapped(body('my cousin'))).toEqual({ industry: 'Widgets', relationship: 'my cousin' });
    expect(normaliseArrival(body('my cousin'), { industryKey: 'widgets', relationshipKey: 'partner_referral' })).toMatchObject({
      account: { industryKey: 'widgets' },
      warmIntro: { relationshipKey: 'partner_referral' },
    });
    expect(normaliseArrival(body('my cousin'), { industryKey: null, relationshipKey: 'nonsense' }).warmIntro?.relationshipKey).toBe('other');
  });

  it('round-trips dates through JSON with revive', () => {
    const n = normaliseArrival(parse({ account: { name: 'A' }, signals: [{ type: 'pain', title: 'P', occurred_at: '2026-01-02' }] }), null);
    expect(revive(JSON.parse(JSON.stringify(n)))).toEqual(n);
  });
});

describe('waiting checks and lock keys', () => {
  const n = (body: unknown) => normaliseArrival(parse(body), null);

  it('waits for what a person could supply', () => {
    expect(waitingFor(n({ account: { name: 'No Site' } }), false)).toBe('needs_website');
    expect(waitingFor(n({ people: [{ email: 'x@gmail.com' }] }), false)).toBe('needs_company');
    expect(waitingFor(n({ account: { linkedin_url: 'https://linkedin.com/company/x' } }), false)).toBe('needs_company');
    expect(waitingFor(n({ sole_proprietor: true, people: [{ email: 'x@gmail.com' }] }), false)).toBe('needs_company');
    expect(waitingFor(n({ sole_proprietor: true, people: [{ name: 'Sam', email: 'x@gmail.com' }] }), false)).toBeNull();
    expect(waitingFor(n({ account: { name: 'No Site' } }), true)).toBeNull();
    expect(waitingFor(withInput(n({ account: { name: 'No Site' } }), { website: 'https://nosite.com' }), false)).toBeNull();
  });

  it('locks on the domain, else name and country, else the shell email, else the arrival', () => {
    expect(lockKeyOf(n({ account: { name: 'A', domain: 'acme.com' } }), 'arr_1')).toBe('acme.com');
    expect(lockKeyOf(n({ account: { name: 'Keystone Ridge Properties LLC', country: 'US' } }), 'arr_1')).toBe('name:keystone ridge properties|US');
    expect(lockKeyOf(n({ sole_proprietor: true, people: [{ name: 'Sam', email: 'Sam@gmail.com' }] }), 'arr_1')).toBe('email:sam@gmail.com');
    expect(lockKeyOf(n({}), 'arr_1')).toBe('arr_1');
  });
});
