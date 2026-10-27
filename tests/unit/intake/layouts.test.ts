import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArrivalV1Schema } from '@/modules/intake/contracts/arrival';
import { LAYOUTS, detectLayout } from '@/modules/intake/import/layouts';
import { RESEARCH_FIELDS, detectResearch, emailFor, parseDecisionMakers, placeOf, researchEmployees, researchOf, signalTypeOf } from '@/modules/intake/import/layouts/research';
import { fromVibeExportRow, fromVibeProspectRow, isParty, mapEvent, nameKey, seniority, topicLabel, vibeSignals } from '@/modules/intake/import/layouts/vibe';
import { parseFile, type ParsedFile } from '@/modules/intake/import/parse';

const NOW = new Date('2026-10-15T12:00:00Z');
const lenient = ArrivalV1Schema({ strict: false });
const fixture = (name: string) => readFileSync(join(__dirname, '../../fixtures/imports', name));
const layout = (key: string) => LAYOUTS.find((l) => l.key === key)!;
const sheet = (headers: string[], rows: string[][]): ParsedFile => ({ headers, rows, rowNumbers: rows.map((_, i) => i + 2), sheets: [], sheet: null });

// Three of the research agents' layouts, trimmed to the columns that matter (from v1 research.test.ts).
const MARKETING = ['report_date', 'agent', 'account', 'account_key', 'official_website', 'hq', 'industry', 'employees', 'signal_date', 'signal', 'signal_source_url', 'decision_makers', 'public_business_contact_route', 'personalized_outreach_hook', 'proposed_30_day_audit_or_pilot', 'abm_score', 'intent_score_0_100', 'abm_tier', 'qualification_caveat', 'estimated_service_fee_usd'];
const TRANSFORMATION = ['report_date', 'account', 'official_website', 'hq', 'industry', 'signal_date', 'signal', 'signal_source', 'decision_makers', 'decision_maker_roles', 'public_business_contact', 'outreach_hook', 'paid_discovery_or_pilot', 'abm_score_100', 'abm_tier', 'dedupe_key'];
const PLATFORMS = ['report_date', 'account', 'official_website', 'hq', 'signal_date', 'verified_signal', 'signal_source_url', 'verified_decision_makers', 'public_business_contact_path', 'personalized_ABM_outreach_hook', 'proposed_paid_discovery_or_pilot', 'abm_score', 'abm_tier', 'known_incumbent_or_partner'];
const row = (headers: string[], v: Record<string, string>) => headers.map((h) => v[h] ?? '');

describe('layout list', () => {
  it('lists the built-in layouts, master first, and picks the first that detects', () => {
    expect(LAYOUTS.map((l) => l.key)).toEqual(['research_master', 'research', 'vibe_export']);
    expect(detectLayout(['Company', 'Website', 'Name', 'Email'])).toBeNull();
    expect(detectLayout(TRANSFORMATION)?.key).toBe('research');
  });
});

describe('research layouts (SRC-E4-S2-AC1)', () => {
  it('recognises the research layouts and not plain lead lists', () => {
    expect(detectResearch(MARKETING)).not.toBeNull();
    expect(detectResearch(TRANSFORMATION)).not.toBeNull();
    expect(detectResearch(PLATFORMS)!.signal).toEqual([5]);
    expect(detectResearch(['Company', 'Website', 'Name', 'Email'])).toBeNull();
    expect(Object.keys(RESEARCH_FIELDS)).toContain('decisionMakers');
  });

  it('splits decision-makers in every format, ignoring source notes', () => {
    expect(parseDecisionMakers('Sam Lowe — Co-founder & CEO; Amy Martin — CMO')).toEqual([
      { firstName: 'Sam', lastName: 'Lowe', title: 'Co-founder & CEO' },
      { firstName: 'Amy', lastName: 'Martin', title: 'CMO' },
    ]);
    expect(parseDecisionMakers('Mel Hudson-Kerr (CTO); Tyson Hale (COO, oversees enterprise operations and technology)')).toEqual([
      { firstName: 'Mel', lastName: 'Hudson-Kerr', title: 'CTO' },
      { firstName: 'Tyson', lastName: 'Hale', title: 'COO' },
    ]);
    expect(parseDecisionMakers('Laurie Grant — SVP Marketing (reported 2024; reverify current)')).toEqual([{ firstName: 'Laurie', lastName: 'Grant', title: 'SVP Marketing' }]);
    expect(parseDecisionMakers('Jae Moreno; Darrell Price', 'Chief Digital & Information Officer; CFO').map((p) => p.title)).toEqual(['Chief Digital & Information Officer', 'CFO']);
    expect(parseDecisionMakers('Not publicly verified')).toEqual([]);
  });

  it('gives a published email only to the person it belongs to', () => {
    const route = 'amartin@summit-services.com (published CMO business contact); info@summit-services.com';
    expect(emailFor({ firstName: 'Amy', lastName: 'Martin' }, route)).toBe('amartin@summit-services.com');
    expect(emailFor({ firstName: 'Sean', lastName: 'Kennedy' }, route)).toBeNull();
  });

  it('reads headcount without picking up years, and places from HQ', () => {
    expect(researchEmployees('~3,900 parent employees reported Jun 2025')).toBe(3900);
    expect(researchEmployees('300+ (reported Sep 2026)')).toBe(300);
    expect(researchEmployees('Not publicly verified')).toBeNull();
    expect(placeOf('Mountain View, CA')).toEqual({ city: 'Mountain View', state: 'CA' });
    expect(placeOf('Michigan (HQ unverified)')).toEqual({ city: null, state: 'Michigan' });
  });

  it('classifies the signal', () => {
    expect(signalTypeOf('Named Stephanie Cho CMO and launched Move Care Forward')).toBe('leadership');
    expect(signalTypeOf('Acquired Newport Systems to unify maintenance')).toBe('news');
    expect(signalTypeOf('Closed $320M growth financing for enterprise GTM')).toBe('funding');
    expect(signalTypeOf('Selected Duck Creek Clarity ahead of go-live')).toBe('news');
  });

  it('turns rows into one arrival per company with research, people and dated signals; keeps rows without a website', () => {
    const rows = [
      row(TRANSFORMATION, { report_date: '2026-10-22', account: 'Lakeshore General', official_website: 'https://www.lakeshoregeneral.com/', hq: 'Middleburg Heights, OH', signal_date: '2026-10-21', signal: 'Expanded Oracle platform', signal_source: 'https://oracle.com/x', decision_makers: 'Jae Moreno; Darrell Price', decision_maker_roles: 'CIO; CFO', outreach_hook: 'What exceptions remain?', paid_discovery_or_pilot: '4-week pilot', abm_score_100: '94', abm_tier: 'A', dedupe_key: 'lakeshoregeneral.com' }),
      row(TRANSFORMATION, { report_date: '2026-10-23', account: 'Lakeshore General', official_website: 'lakeshoregeneral.com', signal_date: '2026-10-23', signal: 'Named new CFO', abm_score_100: '95', abm_tier: 'A' }),
      row(TRANSFORMATION, { account: 'Harbor Health', signal: 'Ensemble partnership', signal_date: '2026-03-11', abm_tier: 'A', dedupe_key: 'stamford health' }),
      row(TRANSFORMATION, { account: 'Brightline', signal: 'x', abm_tier: 'B', public_business_contact: 'Contact via https://www.brightline.com/contact' }),
    ];
    const drafts = layout('research').toArrivals(sheet(TRANSFORMATION, rows), { now: NOW, fileName: 'Taazaa_AI_Transformation_ABM_2026-10-22.csv' });
    expect(drafts.map((d) => d.body.account?.name)).toEqual(['Lakeshore General', 'Harbor Health', 'Brightline']);
    drafts.forEach((d) => expect(lenient.safeParse(d.body).success).toBe(true));

    const [lake, harbor, bright] = drafts.map((d) => d.body);
    expect(lake!.signals.map((s) => s.title)).toEqual(['Expanded Oracle platform', 'Named new CFO']);
    expect(lake!.signals[0]).toMatchObject({ fine_type: 'news', occurred_at: '2026-10-21', url: 'https://oracle.com/x' });
    expect(lake!.signals[1]).toMatchObject({ fine_type: 'leadership', occurred_at: '2026-10-23' });
    expect(lake!.research).toMatchObject({ researcher_score: 95, researcher_tier: 'A' }); // the newest research wins
    expect(lake!.people.map((p) => `${p.first_name} ${p.last_name}, ${p.title}`)).toEqual(['Jae Moreno, CIO', 'Darrell Price, CFO']);
    expect(lake!.account).toMatchObject({ domain: 'lakeshoregeneral.com', website: 'https://www.lakeshoregeneral.com/', city: 'Middleburg Heights', region: 'OH' });
    expect(drafts[0]!.raw.rows).toHaveLength(2);
    expect(drafts[0]!.raw.headers).toEqual(TRANSFORMATION);

    expect(harbor!.account?.domain).toBeUndefined();
    expect(harbor!.account?.website).toBeUndefined();
    expect(bright!.account?.domain).toBe('brightline.com');
  });

  it('formats the price from the fee column or the pilot text', () => {
    const r = researchOf(row(MARKETING, { account: 'TRG', signal: 'x', abm_tier: 'A', estimated_service_fee_usd: '15000-35000 (Taazaa proposal, not customer budget)' }), detectResearch(MARKETING)!);
    expect(r.price).toBe('$15K to $35K');
    const p = researchOf(row(PLATFORMS, { account: 'Keller', verified_signal: 'x', abm_tier: 'A', proposed_paid_discovery_or_pilot: '4-week $40k discovery; optional $90k 8-week pilot.' }), detectResearch(PLATFORMS)!);
    expect(p.price).toBe('$40K + $90K');
    const d = layout('research').toArrivals(sheet(MARKETING, [row(MARKETING, { account: 'TRG', official_website: 'trg.com', signal: 'x', abm_tier: 'A', estimated_service_fee_usd: '15000-35000' })]), { now: NOW, fileName: 'x.csv' });
    expect(d[0]!.body.research?.price_cents).toBe(1_500_000);
  });

  it('files a sheet to a practice from the agent column, else the file name', () => {
    const withAgent = layout('research').toArrivals(sheet(MARKETING, [row(MARKETING, { agent: 'Data & Engineering for AI Readiness', account: 'A', official_website: 'a.com', signal: 's', abm_tier: 'A' })]), { now: NOW, fileName: 'export.csv' });
    expect(withAgent[0]!.body.account?.practice_hint).toBe('Data & Engineering for AI Readiness');
    const byName = layout('research').toArrivals(sheet(TRANSFORMATION, [row(TRANSFORMATION, { account: 'A', official_website: 'a.com', signal: 's', abm_tier: 'A' })]), { now: NOW, fileName: 'Taazaa_AI_Transformation_ABM_2026-10-22.csv' });
    expect(byName[0]!.body.account?.practice_hint).toBe('Taazaa_AI_Transformation_ABM_2026-10-22');
  });

  it('keeps a signal with no date as a research signal, so it passes the file contract', () => {
    const d = layout('research').toArrivals(sheet(TRANSFORMATION, [row(TRANSFORMATION, { account: 'A', official_website: 'a.com', signal: 'Looking at AI', abm_tier: 'B' })]), { now: NOW, fileName: 'x.csv' });
    expect(d[0]!.body.signals).toEqual([{ type: 'research', title: 'Looking at AI' }]);
    expect(lenient.safeParse(d[0]!.body).success).toBe(true);
  });

  it('reads a stacked master file (two layouts in one sheet) with no mapping', async () => {
    const parsed = await parseFile({ fileName: 'Taazaa_Master_ABM.csv', bytes: fixture('research-master.csv') });
    expect(detectLayout(parsed.headers)?.key).toBe('research_master');
    const drafts = layout('research_master').toArrivals(parsed, { now: NOW, fileName: 'Taazaa_Master_ABM.csv' });
    expect(drafts).toHaveLength(2);
    drafts.forEach((d) => expect(lenient.safeParse(d.body).success).toBe(true));
    const [trg, keller] = drafts.map((d) => d.body);
    expect(trg!.signals.map((s) => s.title)).toEqual(['Four acquisitions in 3 months']);
    expect(trg!.people.map((p) => p.first_name)).toEqual(['Sam', 'Amy']);
    expect(trg!.account).toMatchObject({ practice_hint: 'AI Marketing Studio', employees: 300, city: 'Austin', region: 'TX' });
    expect(keller!.signals.map((s) => s.title)).toEqual(['Selected a new data platform']);
    expect(keller!.account).toMatchObject({ employees: 3900, practice_hint: 'Data & Engineering for AI Readiness' });
    expect(keller!.people.map((p) => p.title)).toEqual(['CIO']);
    expect(keller!.research?.researcher_tier).toBe('B');
  });
});

// ---------- Vibe ----------

const vibeRow = JSON.parse(readFileSync(join(__dirname, '../../fixtures/imports/vibe-fortegra.json'), 'utf8')) as Record<string, string>;

describe('Vibe events', () => {
  it('maps Vibe events to signal types', () => {
    expect(mapEvent({ type: 'hiring_in_operations_department', date: '2026-10-01' })).toEqual({ type: 'hiring', title: 'Hiring in operations' });
    expect(mapEvent({ type: 'increase_in_operations_department', date: '2026-10-01' })?.type).toBe('workforce');
    expect(mapEvent({ type: 'merger_and_acquisitions', date: '2026-10-01', title: 'Acquires Acme' })).toEqual({ type: 'news', title: 'Acquisition or merger: Acquires Acme' });
    expect(mapEvent({ type: 'outages_and_security_breaches', date: '2026-10-01' })?.type).toBe('risk');
    expect(mapEvent({ type: 'lawsuits_and_legal_issues', date: '2026-10-01' })?.type).toBe('risk');
    expect(mapEvent({ type: 'new_funding_round', date: '2026-10-01', title: 'Raised $40M Series C' })).toEqual({ type: 'funding', title: 'Raised $40M Series C' });
    expect(mapEvent({ type: 'decrease_in_sales_department', date: '2026-10-01' })?.title).toMatch(/^Cost cutting/);
    expect(mapEvent({ type: 'increase_in_operations_department', date: '2026-09-30' })?.title).toBe('Operations team growing');
  });

  it('only counts a new hire as a leadership change when it is an executive', () => {
    expect(mapEvent({ type: 'employee_joined_company', date: '2026-10-01', title: 'Jane Doe, Chief Operating Officer' })?.type).toBe('leadership');
    expect(mapEvent({ type: 'employee_joined_company', date: '2026-10-01', title: 'Sam Lee, Staff Accountant' })).toBeNull();
  });

  it('drops the category from a topic and fixes capitals', () => {
    expect(topicLabel('machine learning & artificial intelligence: ai risk management')).toBe('AI risk management');
    expect(topicLabel('it management: legacy system modernization')).toBe('Legacy system modernization');
    expect(topicLabel('machine learning & artificial intelligence: ai usage control (aiuc)')).toBe('AI usage control');
  });
});

describe('signals from a Vibe company (SRC-E4-S2-AC2)', () => {
  const sigs = vibeSignals(
    {
      businessId: 'b1', name: 'Sentral', domain: 'sentral.com', website: null, linkedin: null, city: null, region: null, country: null, naics: null,
      naicsDescription: null, linkedinCategory: null, employeesRange: null, revenueRange: null, description: null, techStack: [],
      intent: [{ topic: 'machine learning & artificial intelligence: ai risk management', score: 84 }, { topic: 'x: noise', score: 30 }],
      workforce: { share: { operations: 0.21 }, change: { operations: 6, sales: 1 } },
      events: [{ type: 'outages_and_security_breaches', date: '2026-09-20' }, { type: 'company_award', date: '2026-09-01', title: 'Best place to work' }],
    },
    NOW,
  );

  it('keeps intent of 50 or more as an undated research signal', () => {
    const intent = sigs.filter((s) => s.fine_type === 'intent');
    expect(intent).toHaveLength(1);
    expect(intent[0]).toMatchObject({ title: 'Researching: AI risk management' });
    expect(intent[0]!.detail).toContain('Research score 84 of 100');
    expect(intent[0]!.occurred_at).toBeUndefined();
  });

  it('adds team makeup and growth, dated today', () => {
    expect(sigs.find((s) => s.title === 'Operations is 21% of staff')).toMatchObject({ fine_type: 'workforce', occurred_at: '2026-10-15' });
    expect(sigs.some((s) => s.title.startsWith('Operations team growing: 6'))).toBe(true);
    expect(sigs.some((s) => s.title.startsWith('Sales team growing'))).toBe(false);
  });

  it('dates events', () => {
    expect(sigs.find((s) => s.fine_type === 'risk')?.occurred_at).toBe('2026-09-20');
  });

  it('gives every signal a type and a date unless it is research', () => {
    for (const s of sigs) expect(lenient.safeParse({ account: { name: 'x' }, signals: [s] }).success).toBe(true);
  });
});

describe('Vibe export rows', () => {
  const c = fromVibeExportRow(vibeRow, NOW);
  const sigs = vibeSignals(c, NOW);

  it('reads firmographics, unwrapping ranges', () => {
    expect(c).toMatchObject({ businessId: 'b1', domain: 'fortegra.com', employeesRange: '501-1000', revenueRange: '200M-500M', techStack: ['Microsoft Copilot', 'Salesforce'] });
    expect(c.intent).toEqual([{ topic: 'machine learning & artificial intelligence: ai usage control (aiuc)', score: 73 }]);
    expect(c.workforce?.share).toEqual({ operations: 0.21 });
  });

  it('drops events older than a year', () => {
    expect(c.events.filter((e) => e.type === 'increase_in_operations_department')).toHaveLength(1);
  });

  it('keeps M&A only when the company is a party, titled by the headline that names it', () => {
    expect(sigs.filter((s) => s.title.startsWith('Acquisition')).map((s) => s.title)).toEqual(['Acquisition or merger: Fortegra Joins DB Insurance']);
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

  it('gives the same signals on every import, so the duplicate rules can drop repeats', () => {
    expect(vibeSignals(fromVibeExportRow(vibeRow, NOW), NOW)).toEqual(sigs);
  });

  it('keeps at most 50 signals, newest events first', () => {
    const hires = Array.from({ length: 60 }, (_, i) => ({ event_name: 'hiring_in_sales_department', job_titles: [`Rep ${i}`], event_time: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+00:00` }));
    const big = vibeSignals(fromVibeExportRow({ business_name: 'Big', event_hiring_in_sales_department: JSON.stringify(hires) }, NOW), NOW);
    expect(big).toHaveLength(50);
  });

  it('name keys ignore legal suffixes', () => {
    expect(nameKey('The Fortegra Group, Inc.')).toBe('fortegra');
    expect(isParty('Sentral', ['bukit jalil sentral property sdn bhd bjsp'])).toBe(false);
    expect(isParty('Kairoi Residential', ['stockdale capital partners', 'kairoi residential'])).toBe(true);
  });
});

describe('people from a Vibe prospects export', () => {
  it('maps names, title, email, phone and the LinkedIn link', () => {
    const p = fromVibeProspectRow({ prospect_id: 'p1', business_id: 'b1', prospect_first_name: 'Priya', prospect_last_name: 'Raman', prospect_job_title: 'chief digital and information officer', contact_professional_email: 'PRaman@lakeview-health.com', contact_professional_email_status: 'valid', prospect_linkedin: 'linkedin.com/in/x' });
    expect(p).toEqual({ prospectId: 'p1', businessId: 'b1', firstName: 'Priya', lastName: 'Raman', title: 'Chief digital and information officer', email: 'praman@lakeview-health.com', phone: null, linkedin: 'https://linkedin.com/in/x' });
    expect(fromVibeProspectRow({ business_id: 'b1' })).toBeNull();
  });

  it('ranks seniority', () => {
    expect(seniority('Chief digital and information officer')).toBeGreaterThan(seniority('Vice president quality'));
    expect(seniority('Vice president quality')).toBeGreaterThan(seniority('Director, implementation'));
  });

  it('reads the name from the full name when first and last look wrong', () => {
    const p = fromVibeProspectRow({ prospect_id: 'p', business_id: 'b', prospect_first_name: 'Romito', prospect_last_name: 'Romito, Chcio, Cdh-e, Misst', prospect_full_name: 'Ed Romito, Chcio, Cdh-e, Misst' });
    expect([p!.firstName, p!.lastName]).toEqual(['Ed', 'Romito']);
    const ok = fromVibeProspectRow({ prospect_id: 'p', business_id: 'b', prospect_first_name: 'Christi', prospect_last_name: 'Barney', prospect_full_name: 'Christi Barney' });
    expect([ok!.firstName, ok!.lastName]).toEqual(['Christi', 'Barney']);
  });
});

describe('Vibe layout', () => {
  const toCsv = (rows: Record<string, string>[]) => {
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    return [headers.map(q).join(','), ...rows.map((r) => headers.map((h) => q(r[h] ?? '')).join(','))].join('\n');
  };
  const ctx = { now: NOW, fileName: 'vibe.csv' };

  it('detects Vibe exports only', () => {
    expect(layout('vibe_export').detect(Object.keys(vibeRow))).toBe(true);
    expect(layout('vibe_export').detect(['Company', 'Website'])).toBe(false);
    expect(layout('vibe_export').detect(TRANSFORMATION)).toBe(false);
  });

  it('turns a company row into one arrival that passes the file contract', async () => {
    const parsed = await parseFile({ fileName: 'vibe.csv', bytes: new TextEncoder().encode(toCsv([vibeRow])) });
    expect(detectLayout(parsed.headers)?.key).toBe('vibe_export');
    const [d] = layout('vibe_export').toArrivals(parsed, ctx);
    expect(d!.raw.rows).toHaveLength(1);
    expect(lenient.safeParse(d!.body).success).toBe(true);
    expect(d!.body.account).toMatchObject({
      name: 'Fortegra', domain: 'fortegra.com', website: 'https://www.fortegra.com', linkedin_url: 'https://linkedin.com/company/fortegra',
      country: 'united states', employees_range: '501-1000', revenue_range: '200M-500M', technologies: ['Microsoft Copilot', 'Salesforce'], external_ref: 'b1',
    });
    expect(d!.body.signals.length).toBeGreaterThan(5);
    expect(d!.body.signals.every((s) => s.fine_type && (s.occurred_at || s.fine_type === 'intent'))).toBe(true);
  });

  it('hands NAICS, LinkedIn category and description-free industries to industryKey as text', () => {
    const industry = (extra: Record<string, string>) => layout('vibe_export').toArrivals(sheet(Object.keys({ business_name: 1, ...extra }), [['X', ...Object.values(extra)]]), ctx)[0]!.body.account?.industry;
    expect(industry({ business_naics: '541511' })).toBe('541511');
    expect(industry({ business_naics: '999', business_linkedin_industry_category: 'Software Development' })).toBe('Software Development');
    expect(industry({ business_naics: '999', business_naics_description: 'Something else' })).toBe('Something else');
  });

  it('records the parent a description names as a parent_name fact, and nothing for the company itself', () => {
    const facts = (name: string, description: string) =>
      layout('vibe_export').toArrivals(sheet(['business_name', 'business_business_description'], [[name, description]]), ctx)[0]!.body.facts;
    expect(facts('Sunrise Hospital', 'Sunrise Hospital and Medical Center is part of HCA Healthcare. HCA has been named...')).toEqual({ parent_name: 'HCA Healthcare' });
    expect(facts('Allied Air', 'Allied Air is a Lennox International company that brings together six brands')).toEqual({ parent_name: 'Lennox International' });
    expect(facts('Kairoi Residential', 'Kairoi Residential is a partner-led company with a unified approach to investing in multifamily communities.')).toEqual({});
    expect(facts('Emerson Health', 'Emerson Hospital has proudly served our community for more than a century.')).toEqual({});
  });

  it('adds people from a prospects export, most senior first, one per person', () => {
    const base = { business_id: 'b1', business_name: 'Lakeview', business_domain: 'lakeview-health.com' };
    const rows = [
      { ...base, prospect_id: 'p1', prospect_first_name: 'Dee', prospect_last_name: 'Park', prospect_job_title: 'director of nursing', contact_professional_email: 'dee@lakeview-health.com' },
      { ...base, prospect_id: 'p2', prospect_first_name: 'Priya', prospect_last_name: 'Raman', prospect_job_title: 'chief digital officer', contact_professional_email: 'priya@lakeview-health.com' },
      { ...base, prospect_id: 'p1', prospect_first_name: 'Dee', prospect_last_name: 'Park', prospect_job_title: 'director of nursing', contact_professional_email: 'dee@lakeview-health.com' },
    ];
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const drafts = layout('vibe_export').toArrivals(sheet(headers, rows.map((r) => headers.map((h) => (r as Record<string, string>)[h] ?? ''))), ctx);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.body.people.map((p) => p.first_name)).toEqual(['Priya', 'Dee']);
    expect(drafts[0]!.raw.rows).toHaveLength(3);
    expect(lenient.safeParse(drafts[0]!.body).success).toBe(true);
  });

  it('ignores an event feed that is not JSON', () => {
    const d = layout('vibe_export').toArrivals(sheet(['business_name', 'event_new_office'], [['X', 'not json']]), ctx);
    expect(d[0]!.body.signals).toEqual([]);
  });
});
