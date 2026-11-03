// v1's Vibe mapping tests (`vibe.test.ts`, `vibeExport.test.ts`) against the one copy of the mapping (intake's Vibe
// layout, Ruling 2), plus the step to arrival-shaped values. v1's matching and brief cases test other modules.
import { describe, expect, it } from 'vitest';
import {
  fromVibeExportRow,
  fromVibeProspectRow,
  industryFor,
  isParty,
  mapEvent,
  nameKey,
  rangeMid,
  seniority,
  toCompanyFacts,
  toPerson,
  toSignals,
  topicLabel,
  vibeSignals,
  type VibeCompany,
} from '@/modules/enrichment/adapters/vibe/mapping';

const NOW = new Date('2026-10-15T12:00:00Z');
const ev = (o: Record<string, unknown>) => JSON.stringify([o]);

describe('ranges', () => {
  it('takes the geometric middle of a range', () => {
    expect(rangeMid('501-1000')).toBe(708);
    expect(rangeMid('75M-200M')).toBe(122474487);
    expect(rangeMid('10001+')).toBe(10001);
    expect(rangeMid(null)).toBeNull();
  });
});

describe('topics', () => {
  it('drops the category and fixes capitals', () => {
    expect(topicLabel('machine learning & artificial intelligence: ai risk management')).toBe('AI risk management');
    expect(topicLabel('it management: legacy system modernization')).toBe('Legacy system modernization');
  });
});

describe('events', () => {
  it('maps Vibe events to our signal types', () => {
    expect(mapEvent({ type: 'hiring_in_operations_department', date: '2026-10-01' })).toEqual({ type: 'hiring', title: 'Hiring in operations' });
    expect(mapEvent({ type: 'increase_in_operations_department', date: '2026-10-01' })?.type).toBe('workforce');
    expect(mapEvent({ type: 'merger_and_acquisitions', date: '2026-10-01', title: 'Acquires Acme' })).toEqual({ type: 'news', title: 'Acquisition or merger: Acquires Acme' });
    expect(mapEvent({ type: 'outages_and_security_breaches', date: '2026-10-01' })?.type).toBe('risk');
    expect(mapEvent({ type: 'lawsuits_and_legal_issues', date: '2026-10-01' })?.type).toBe('risk');
    expect(mapEvent({ type: 'new_funding_round', date: '2026-10-01', title: 'Raised $40M Series C' })).toEqual({ type: 'funding', title: 'Raised $40M Series C' });
    expect(mapEvent({ type: 'decrease_in_sales_department', date: '2026-10-01' })?.title).toMatch(/^Cost cutting/);
  });
  it("only counts a new hire as a leadership change when it's an executive", () => {
    expect(mapEvent({ type: 'employee_joined_company', date: '2026-10-01', title: 'Jane Doe, Chief Operating Officer' })?.type).toBe('leadership');
    expect(mapEvent({ type: 'employee_joined_company', date: '2026-10-01', title: 'Sam Lee, Staff Accountant' })).toBeNull();
  });
});

describe('signals from a Vibe company', () => {
  // Intake's mapping gives arrival signals: v1's `value` is in the detail, its `externalId` is gone, its date is `occurred_at`.
  const company: VibeCompany = {
    businessId: 'b1', name: 'Sentral', domain: 'sentral.com', website: null, linkedin: null, city: null, region: null, country: null, naics: null,
    naicsDescription: null, linkedinCategory: null, employeesRange: null, revenueRange: null, description: null, techStack: [],
    intent: [{ topic: 'machine learning & artificial intelligence: ai risk management', score: 84 }, { topic: 'x: noise', score: 30 }],
    workforce: { share: { operations: 0.21 }, change: { operations: 6, sales: 1 } },
    events: [{ type: 'outages_and_security_breaches', date: '2026-09-20' }, { type: 'company_award', date: '2026-09-01', title: 'Best place to work' }],
  };
  const sigs = vibeSignals(company, NOW);
  it('keeps intent of 50 or more with its score', () => {
    const intent = sigs.filter((s) => s.fine_type === 'intent');
    expect(intent).toHaveLength(1);
    expect(intent[0]).toMatchObject({ title: 'Researching: AI risk management', detail: expect.stringMatching(/^Research score 84 of 100/) });
  });
  it('adds team makeup and growth', () => {
    expect(sigs.find((s) => s.title === 'Operations is 21% of staff')).toMatchObject({ fine_type: 'workforce' });
    expect(sigs.some((s) => s.title.startsWith('Operations team growing: 6'))).toBe(true);
    expect(sigs.some((s) => s.title.startsWith('Sales team growing'))).toBe(false);
  });
  it('dates events', () => {
    expect(sigs.find((s) => s.fine_type === 'risk')?.occurred_at).toBe('2026-09-20');
  });
  it('become arrival signals with the kind for each type, every one dated', () => {
    const out = toSignals(sigs, NOW);
    expect(out.find((s) => s.fine_type === 'intent')).toEqual({ type: 'research', fine_type: 'intent', title: 'Researching: AI risk management', occurred_at: '2026-10-15', detail: expect.stringMatching(/^Research score 84/) });
    expect(out.find((s) => s.fine_type === 'risk')).toMatchObject({ type: 'trigger', occurred_at: '2026-09-20' });
    expect(out.find((s) => s.fine_type === 'workforce')).toMatchObject({ type: 'pain' });
  });
});

const row = {
  business_id: 'b1',
  business_name: 'Fortegra',
  business_domain: 'fortegra.com',
  business_country_name: 'united states',
  business_naics: '524',
  business_naics_description: 'Insurance Carriers and Related Activities',
  business_number_of_employees_range: '[501-1000]',
  business_yearly_revenue_range: '[200M-500M]',
  business_business_intent_topics: JSON.stringify([{ topic: 'machine learning & artificial intelligence: ai usage control (aiuc)', score: 73 }]),
  tech_full_tech_stack: JSON.stringify(['Microsoft Copilot', 'Salesforce']),
  work_trend_perc_operations_roles: '21',
  work_trend_perc_sales_roles: '',
  event_employee_joined_company: JSON.stringify([
    { event_name: 'employee_joined_company', job_role_title: 'Executive Vice President', full_name: 'Pat Lee', job_department: 'C-Suite', linkedin_url: 'linkedin.com/in/pat', event_time: '2026-06-01T00:00:00+00:00' },
    { event_name: 'employee_joined_company', job_role_title: 'Claims Adjuster', full_name: 'Sam Roe', event_time: '2026-06-01T00:00:00+00:00' },
  ]),
  event_merger_and_acquisitions: JSON.stringify([
    { event_name: 'merger_and_acquisitions', title: 'Fortegra Joins DB Insurance', description: 'DB Insurance completed its acquisition of Fortegra Group Inc.', companies_involved: ['fortegra group', 'db insurance'], event_time: '2026-05-01T00:00:00+00:00' },
    { event_name: 'merger_and_acquisitions', title: 'Bloomberg', description: 'Someone else bought someone else.', companies_involved: ['go residential', 'h and r reit'], event_time: '2026-08-01T00:00:00+00:00' },
  ]),
  event_lawsuits_and_legal_issues: JSON.stringify([
    { event_name: 'lawsuits_and_legal_issues', case_type: 'Breach of contract', title: 'Property manager sues insurer', event_time: '2026-03-01T00:00:00+00:00' },
    { event_name: 'lawsuits_and_legal_issues', case_type: 'Murder', title: 'DA charges man', event_time: '2026-03-02T00:00:00+00:00' },
  ]),
  event_increase_in_operations_department: JSON.stringify([
    { event_name: 'increase_in_operations_department', department_change: 33, event_time: '2026-09-30T00:00:00+00:00' },
    { event_name: 'increase_in_operations_department', department_change: 25, event_time: '2017-12-31T00:00:00+00:00' },
  ]),
  event_outages_and_security_breaches: ev({ event_name: 'outages_and_security_breaches', incident_type: 'unauthorized access', number_of_affected_customers: 3803750, title: 'HIPAA Pulse', event_time: '2026-08-19T00:00:00+00:00' }),
  event_new_investment: ev({ event_name: 'new_investment', title: 'Breaks ground on a new campus', event_time: '2026-01-28T00:00:00+00:00' }),
};

describe('Vibe export rows', () => {
  const c = fromVibeExportRow(row, NOW);
  const sigs = vibeSignals(c, NOW);

  it('reads firmographics, unwrapping ranges', () => {
    expect(c).toMatchObject({ businessId: 'b1', domain: 'fortegra.com', employeesRange: '501-1000', revenueRange: '200M-500M', techStack: ['Microsoft Copilot', 'Salesforce'] });
    expect(c.intent).toEqual([{ topic: 'machine learning & artificial intelligence: ai usage control (aiuc)', score: 73 }]);
    expect(c.workforce?.share).toEqual({ operations: 0.21 });
  });
  it('drops events older than a year', () => {
    expect(c.events!.filter((e) => e.type === 'increase_in_operations_department')).toHaveLength(1);
  });
  it('keeps M&A only when the company is a party, titled by the headline that names it', () => {
    const ma = sigs.filter((s) => s.title.startsWith('Acquisition'));
    expect(ma.map((s) => s.title)).toEqual(['Acquisition or merger: Fortegra Joins DB Insurance']);
  });
  it('skips crime stories in the legal feed', () => {
    expect(sigs.filter((s) => s.fine_type === 'risk' && s.title.startsWith('Lawsuit')).map((s) => s.title)).toEqual(['Lawsuit: Property manager sues insurer']);
  });
  it('describes breaches by what happened, not the newsletter headline', () => {
    expect(sigs.find((s) => s.title.startsWith('Security'))?.title).toBe('Security breach or outage: Unauthorized access, 3,803,750 people affected');
  });
  it('counts executive hires only', () => {
    expect(sigs.filter((s) => s.fine_type === 'leadership').map((s) => s.title)).toEqual(['New leader joined: Executive Vice President']);
  });
  it("a company's own investment is news, not funding", () => {
    expect(sigs.some((s) => s.fine_type === 'funding')).toBe(false);
    expect(sigs.find((s) => s.title.startsWith('Investing'))?.fine_type).toBe('news');
  });
  it('signals are the same across imports', () => {
    expect(vibeSignals(fromVibeExportRow(row, NOW), NOW)).toEqual(sigs);
  });
  it('becomes arrival account fields', () => {
    expect(toCompanyFacts(c)).toMatchObject({
      name: 'Fortegra', domain: 'fortegra.com', country: 'united states', industry: 'Insurance', employees: 708, employees_range: '501-1000',
      revenue_range: '200M-500M', revenue_cents: 31622776600, technologies: ['Microsoft Copilot', 'Salesforce'], provider_ref: 'b1',
    });
  });
});

describe('helpers', () => {
  it('industry from NAICS uses our words', () => {
    expect(industryFor('62', 'Health Care and Social Assistance')).toBe('Healthcare services');
    expect(industryFor('622110')).toBe('Healthcare services: hospitals');
    expect(industryFor('493110')).toBe('Logistics: warehousing');
    expect(industryFor('999', 'Something else')).toBe('Something else');
  });
  it('name keys ignore legal suffixes', () => {
    expect(nameKey('The Fortegra Group, Inc.')).toBe('fortegra');
    expect(isParty('Sentral', ['bukit jalil sentral property sdn bhd bjsp'])).toBe(false);
    expect(isParty('Kairoi Residential', ['stockdale capital partners', 'kairoi residential'])).toBe(true);
  });
  it('topic labels drop vendor shorthand', () => {
    expect(topicLabel('machine learning & artificial intelligence: ai usage control (aiuc)')).toBe('AI usage control');
  });
  it('increase events read as a growing team', () => {
    expect(mapEvent({ type: 'increase_in_operations_department', date: '2026-09-30' })?.title).toBe('Operations team growing');
  });
});

describe('people from a Vibe prospects export', () => {
  it('maps names, title, email and its status, and the LinkedIn link', () => {
    const p = fromVibeProspectRow({ prospect_id: 'p1', business_id: 'b1', prospect_first_name: 'Priya', prospect_last_name: 'Raman', prospect_job_title: 'chief digital and information officer', contact_professional_email: 'PRaman@lakeview-health.example', contact_professional_email_status: 'valid', prospect_linkedin: 'linkedin.com/in/x' });
    expect(p).toEqual({ prospectId: 'p1', businessId: 'b1', firstName: 'Priya', lastName: 'Raman', title: 'Chief digital and information officer', email: 'praman@lakeview-health.example', emailStatus: 'valid', phone: null, linkedin: 'https://linkedin.com/in/x' });
    expect(fromVibeProspectRow({ business_id: 'b1' })).toBeNull();
    expect(seniority('Chief digital and information officer')).toBeGreaterThan(seniority('Vice president quality'));
    expect(seniority('Vice president quality')).toBeGreaterThan(seniority('Director, implementation'));
  });
  it('becomes an arrival person with the accounts email status', () => {
    const p = fromVibeProspectRow({ prospect_id: 'p1', business_id: 'b1', prospect_first_name: 'Priya', prospect_last_name: 'Raman', prospect_job_title: 'chief information officer', contact_professional_email: 'praman@x.example', contact_professional_email_status: 'valid' })!;
    expect(toPerson(p)).toEqual({ name: 'Priya Raman', first_name: 'Priya', last_name: 'Raman', title: 'Chief information officer', email: 'praman@x.example', email_status: 'verified', seniority: 'c_suite', phone: null, linkedin_url: null, provider_ref: 'p1' });
    expect(toPerson({ ...p, email: null, emailStatus: null }).email_status).toBe('unavailable');
    expect(toPerson({ ...p, emailStatus: 'catch-all' }).email_status).toBe('guessed');
  });
});

describe('names Vibe splits badly', () => {
  it('reads the name from the full name when first and last look wrong', () => {
    const p = fromVibeProspectRow({ prospect_id: 'p', business_id: 'b', prospect_first_name: 'Romito', prospect_last_name: 'Romito, Chcio, Cdh-e, Misst', prospect_full_name: 'Ed Romito, Chcio, Cdh-e, Misst' });
    expect([p!.firstName, p!.lastName]).toEqual(['Ed', 'Romito']);
    const ok = fromVibeProspectRow({ prospect_id: 'p', business_id: 'b', prospect_first_name: 'Christi', prospect_last_name: 'Barney', prospect_full_name: 'Christi Barney' });
    expect([ok!.firstName, ok!.lastName]).toEqual(['Christi', 'Barney']);
  });
});
