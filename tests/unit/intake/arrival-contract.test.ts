import { describe, expect, it } from 'vitest';
import { ArrivalV1Schema, BatchV1Schema } from '@/modules/intake/contracts/arrival';

const miamiDade = {
  account: {
    name: 'Miami-Dade County DTPW',
    domain: 'miamidade.gov',
    website: 'https://www.miamidade.gov/global/transportation/home.page',
    linkedin_url: null,
    country: 'US',
    region: 'FL',
    city: 'Miami',
    industry: 'Public transportation',
    employees: 3000,
    revenue_cents: null,
    notes: 'Found while researching Florida CTCs.',
    practice_hint: 'ai-operating-platforms',
    offer_hint: null,
    external_ref: 'yasir-agent-2026-10-25-0041',
    description: "Florida's largest community transportation coordinator.",
    employees_range: null,
    revenue_range: null,
    technologies: ['Trapeze PASS'],
    keywords: ['paratransit', 'microtransit'],
    parent_domain: null,
    custom_fields: { abm_motion: 'tier_1_one_to_one', fleet_tier: 'unverified' },
  },
  people: [
    {
      name: 'Jarice Rodriguez',
      title: 'Chief of Paratransit Operations & Mobility Services',
      buying_role: 'business_owner',
      email: null,
      phone: null,
      linkedin_url: null,
      notes: 'Leads STS; FPTA 2026 speaker.',
    },
  ],
  signals: [
    {
      type: 'trigger',
      title: 'Software-only re-solicitation approved (R-481-26)',
      occurred_at: '2026-06-02',
      url: 'https://example.com/r-481-26',
      detail: null,
      confidence: 0.9,
    },
  ],
  facts: { contract_value_cents: 2090000000 },
  warm_intro: {
    introducer_name: 'Ashkan Eskandari',
    introducer_email: 'ash@taazaa.com',
    relationship: 'knows the CTC director from FPTA',
    note: null,
  },
  research: {
    hook: 'h',
    problem: 'p',
    pilot: 'pi',
    price_cents: null,
    value_hypothesis: 'v',
    incumbent: 'Trapeze',
    caveats: 'Cone of silence once the RFP is out',
    contact_route: 'c',
    next_action: 'n',
    researcher_score: 79,
    researcher_tier: 'A',
  },
  sole_proprietor: false,
  via_vendor: 'apollo',
  target_account_id: null,
};

const batch = {
  name: 'Florida transit agencies, week 43',
  run_at: '2026-10-24T18:00:00Z',
  notes: 'Searched county RFP portals for paratransit software notices.',
  criteria: { industries: ['Public transit'], regions: ['FL'] },
  metadata: { agent_version: '1.4.0' },
  items: [
    {
      external_ref: 'row-17',
      account: { name: 'Miami-Dade County DTPW', domain: 'miamidade.gov' },
      people: [{ name: 'Jarice Rodriguez', title: 'Chief of Paratransit Operations', buying_role: 'business_owner' }],
      signals: [
        { type: 'trigger', title: 'Software-only re-solicitation approved', occurred_at: '2026-06-02', url: 'https://example.com' },
      ],
      facts: { employees: 2400 },
      warm_intro: null,
      notes: 'Trapeze is the incumbent, extended to 2029.',
    },
  ],
};

const messages = (r: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('ArrivalV1Schema', () => {
  it('parses the SRC-E2 example in both modes', () => {
    expect(ArrivalV1Schema({ strict: true }).safeParse(miamiDade).success).toBe(true);
    expect(ArrivalV1Schema({ strict: false }).safeParse(miamiDade).success).toBe(true);
  });

  it('fails an unknown account key at its path', () => {
    const r = ArrivalV1Schema({ strict: true }).safeParse({ ...miamiDade, account: { ...miamiDade.account, colour: 'red' } });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.path.join('.') === 'account' && /colour/.test(i.message))).toBe(true);
  });

  it('strict mode asks for a company name and an identity', () => {
    const noName = ArrivalV1Schema({ strict: true }).safeParse({ account: { domain: 'acme.com' } });
    expect(messages(noName)).toContain('account.name: Add the company name.');
    const nameOnly = ArrivalV1Schema({ strict: true }).safeParse({ account: { name: 'Acme' } });
    expect(messages(nameOnly)).toEqual(['account.domain: Add a website, domain or LinkedIn page.']);
  });

  it('strict mode asks for the date on every signal, lenient mode does not', () => {
    const body = { account: { name: 'Acme', domain: 'acme.com' }, signals: [{ type: 'research', title: 'Hiring a CTO' }] };
    expect(messages(ArrivalV1Schema({ strict: true }).safeParse(body))).toEqual([
      'signals.0.occurred_at: Add the date it happened.',
    ]);
    expect(ArrivalV1Schema({ strict: false }).safeParse(body).success).toBe(true);
    const fine = { ...body, signals: [{ fine_type: 'intent', title: 'Reading about AI' }] };
    expect(ArrivalV1Schema({ strict: false }).safeParse(fine).success).toBe(true);
  });

  it('only a research signal may be undated, even in lenient mode', () => {
    const s = ArrivalV1Schema({ strict: false });
    for (const signals of [[{ type: 'trigger', title: 'Funding' }], [{ type: 'pain', title: 'Hiring' }], [{ fine_type: 'funding', title: 'Raised' }]]) {
      expect(messages(s.safeParse({ account: { name: 'Acme' }, signals }))).toEqual(['signals.0.occurred_at: Add the date it happened.']);
    }
  });

  it('a signal says what kind it is', () => {
    const body = { account: { name: 'Acme', domain: 'acme.com' }, signals: [{ title: 'Something', occurred_at: '2026-01-01' }] };
    for (const strict of [true, false]) {
      expect(messages(ArrivalV1Schema({ strict }).safeParse(body))).toEqual(['signals.0.type: Say what kind of signal this is.']);
    }
  });

  it('strict mode: a sole proprietor needs no company but needs the person email', () => {
    const s = ArrivalV1Schema({ strict: true });
    expect(s.safeParse({ sole_proprietor: true, people: [{ name: 'Ada Lovelace', email: 'ada@gmail.com' }] }).success).toBe(true);
    expect(messages(s.safeParse({ sole_proprietor: true }))).toEqual(["people: Add the person's email."]);
    expect(messages(s.safeParse({ sole_proprietor: true, people: [{ name: 'Ada' }] }))).toEqual(["people: Add the person's email."]);
  });

  it('strict mode: a website or LinkedIn value that is not one is not an identity', () => {
    const s = ArrivalV1Schema({ strict: true });
    expect(messages(s.safeParse({ account: { name: 'Acme', website: 'not a url' } }))).toEqual([
      'account.website: Must be a website like https://acme.com.',
    ]);
    expect(s.safeParse({ account: { name: 'Acme', linkedin_url: 'https://linkedin.com/company/acme' } }).success).toBe(true);
    expect(s.safeParse({ account: { name: 'Acme', linkedin_url: 'acme' } }).success).toBe(false);
  });

  it('lenient mode accepts a name-only account and a lone person', () => {
    expect(ArrivalV1Schema({ strict: false }).safeParse({ account: { name: 'Acme' } }).success).toBe(true);
    expect(ArrivalV1Schema({ strict: false }).safeParse({ people: [{ name: 'Ada', email: 'ada@gmail.com' }] }).success).toBe(true);
  });

  it('a targeted arrival needs no company', () => {
    const r = ArrivalV1Schema({ strict: true }).safeParse({ target_account_id: 'acc_1', people: [{ name: 'Ada Lovelace' }] });
    expect(r.success).toBe(true);
  });

  it('says what a bad domain should look like', () => {
    const r = ArrivalV1Schema({ strict: true }).safeParse({ account: { name: 'Acme', domain: 'gmail.com' } });
    expect(messages(r)).toEqual(['account.domain: Must be a domain like acme.com.']);
  });

  it('caps people, signals and facts', () => {
    const base = { account: { name: 'Acme', domain: 'acme.com' } };
    const s = ArrivalV1Schema({ strict: true });
    const people = Array.from({ length: 26 }, (_, i) => ({ name: `P ${i}` }));
    expect(messages(s.safeParse({ ...base, people }))).toContain('people: At most 25 people.');
    const signals = Array.from({ length: 51 }, () => ({ type: 'research', title: 's', occurred_at: '2026-01-01' }));
    expect(messages(s.safeParse({ ...base, signals }))).toContain('signals: At most 50 signals.');
    const facts = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]));
    expect(messages(s.safeParse({ ...base, facts }))).toContain('facts: At most 200 facts.');
    const factList = Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, value: i }));
    expect(s.safeParse({ ...base, facts: factList }).success).toBe(false);
  });

  it('keeps unknown facts keys and accepts the list form', () => {
    const s = ArrivalV1Schema({ strict: true });
    const a = s.parse({ account: { name: 'Acme', domain: 'acme.com' }, facts: { whatever_we_dont_know: 1, employees: 5 } });
    expect(a.facts).toEqual({ whatever_we_dont_know: 1, employees: 5 });
    const b = s.parse({
      account: { name: 'Acme', domain: 'acme.com' },
      facts: [{ key: 'employees', value: 5, observed_at: '2026-10-01', url: 'https://x.test', note: 'n' }],
    });
    expect(Array.isArray(b.facts)).toBe(true);
  });
});

describe('BatchV1Schema', () => {
  it('leaves an item whose account is not an object for the item check', () => {
    const r = BatchV1Schema({ strict: true }).safeParse({ ...batch, items: [{ external_ref: 'r', account: 'Acme' }] });
    expect(r.success).toBe(false);
  });

  it('parses the async-and-batches example and moves item external_ref and notes into account', () => {
    const r = BatchV1Schema({ strict: true }).parse(batch);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.account).toMatchObject({
      name: 'Miami-Dade County DTPW',
      external_ref: 'row-17',
      notes: 'Trapeze is the incumbent, extended to 2029.',
    });
  });

  it('needs a name and 1 to 1,000 items', () => {
    const s = BatchV1Schema({ strict: true });
    expect(s.safeParse({ ...batch, name: '' }).success).toBe(false);
    expect(s.safeParse({ ...batch, items: [] }).success).toBe(false);
    const item = batch.items[0]!;
    expect(s.safeParse({ ...batch, items: Array.from({ length: 1001 }, () => item) }).success).toBe(false);
  });
});
