import type { EnrichmentAdapter, Person } from '../../contracts/adapter';
import { cantDo } from '../errors';
import { failIfAsked } from '../mock-failure';
import { daysAgo, intBetween, nameFromDomain, pick, rng } from '../sample';
import { fromVibeExportRow, fromVibeProspectRow, toCompanyFacts, toPerson, toSignals, vibeSignals, type VibeExportRow } from './mapping';

// Sample Vibe Prospecting (Ruling 2: sample data only). Each domain gets a made-up dataset export row and prospect
// rows, read through the same mapping a live Vibe connection would use. Credits as Apollo's, per Ruling 4.

const PROVIDER = 'Vibe Prospecting';

const NAICS = ['5311', '5313', '524', '622110', '621', '484', '493110', '5411', '332', '541'];
const EMPLOYEES = ['51-200', '201-500', '501-1000', '1001-5000'];
const REVENUE = ['10M-50M', '50M-200M', '200M-500M', '500M-1B'];
const TECH = ['Microsoft 365', 'Salesforce', 'HubSpot', 'NetSuite', 'Microsoft Copilot', 'Yardi', 'Epic', 'Microsoft Access', 'ServiceNow', 'Power BI'];
const TOPICS = ['machine learning & artificial intelligence: ai risk management', 'it management: legacy system modernization', 'machine learning & artificial intelligence: responsible ai', 'business software: workflow automation'];
const CITIES = [['Charlotte', 'North Carolina'], ['Dallas', 'Texas'], ['Columbus', 'Ohio'], ['Denver', 'Colorado'], ['Tampa', 'Florida']] as const;
const FIRST = ['Priya', 'Andre', 'Mei', 'Luis', 'Grace', 'Omar', 'Elena', 'Victor', 'Dana', 'Jordan', 'Morgan', 'Reese'];
const LAST = ['Raman', 'Okafor', 'Patel', 'Haddad', 'Nguyen', 'Brennan', 'Delgado', 'Foster', 'Hughes', 'Jensen'];
const EXEC_TITLES = ['Chief Operating Officer', 'Chief Information Officer', 'Vice President of Operations', 'Chief Financial Officer'];

const ev = (o: Record<string, unknown>) => JSON.stringify([o]);

/** The made-up Vibe export row for a domain. */
function rowFor(domain: string, now: Date): VibeExportRow {
  const r = rng(`vibe:${domain}`);
  const [city, region] = pick(r, CITIES);
  const at = (lo: number, hi: number) => `${daysAgo(intBetween(r, lo, hi), now)}T00:00:00+00:00`;
  return {
    business_id: `vibe-b:${domain}`,
    business_name: nameFromDomain(domain),
    business_domain: domain,
    business_website: `https://${domain}`,
    business_city_name: city,
    business_region: region,
    business_country_name: 'United States',
    business_naics: pick(r, NAICS),
    business_number_of_employees_range: `[${pick(r, EMPLOYEES)}]`,
    business_yearly_revenue_range: `[${pick(r, REVENUE)}]`,
    tech_full_tech_stack: JSON.stringify([...new Set([pick(r, TECH), pick(r, TECH), pick(r, TECH)])]),
    business_business_intent_topics: JSON.stringify([{ topic: pick(r, TOPICS), score: intBetween(r, 40, 92) }]),
    work_trend_perc_operations_roles: String(intBetween(r, 6, 28)),
    work_trend_change_in_operations_roles: String(intBetween(r, 0, 8)),
    event_hiring_in_operations_department: ev({ event_name: 'hiring_in_operations_department', job_titles: ['Operations Analyst', 'Data Entry Specialist'], job_count: intBetween(r, 2, 9), event_time: at(3, 60) }),
    event_employee_joined_company: ev({ event_name: 'employee_joined_company', job_role_title: pick(r, EXEC_TITLES), full_name: `${pick(r, FIRST)} ${pick(r, LAST)}`, event_time: at(10, 200) }),
    ...(r() < 0.5 ? { event_new_office: ev({ event_name: 'new_office', title: `${nameFromDomain(domain)} opens a new office`, office_location: pick(r, CITIES)[0], event_time: at(5, 150) }) } : {}),
  };
}

function prospectRow(domain: string, i: number, title: string): VibeExportRow {
  const r = rng(`vibe-p:${domain}:${i}`);
  const first = pick(r, FIRST);
  const last = pick(r, LAST);
  return {
    prospect_id: `vibe-p:${domain}:${i}`,
    business_id: `vibe-b:${domain}`,
    prospect_first_name: first,
    prospect_last_name: last,
    prospect_full_name: `${first} ${last}`,
    prospect_job_title: title,
    contact_professional_email: `${first}.${last}@${domain}`.toLowerCase(),
    contact_professional_email_status: r() < 0.8 ? 'valid' : 'catch-all',
  };
}

const signalsFor = (domain: string) => {
  const now = new Date();
  return toSignals(vibeSignals(fromVibeExportRow(rowFor(domain, now), now), now));
};

export function vibeMock(): EnrichmentAdapter {
  return {
    async test() {
      return { ok: true, message: 'Sample Vibe Prospecting data is working.' };
    },

    async companyEnrich({ domain }) {
      failIfAsked(PROVIDER);
      return { value: toCompanyFacts(fromVibeExportRow(rowFor(domain, new Date()), new Date())), creditsUsed: 1 };
    },

    async peopleSearch({ domain, titles, max }) {
      failIfAsked(PROVIDER);
      const pool = titles.length ? titles : EXEC_TITLES;
      const n = Math.min(Math.max(0, max), Math.min(3, pool.length + 1));
      const value: Person[] = [];
      for (let i = 0; i < n; i++) {
        const p = fromVibeProspectRow(prospectRow(domain, i, pool[i % pool.length]!));
        if (!p) continue;
        // The search names people; their email comes with `revealEmail`.
        const { email: _email, email_status: _status, ...named } = toPerson(p);
        value.push(named);
      }
      return { value, creditsUsed: 0 };
    },

    async revealEmail({ person, domain }) {
      failIfAsked(PROVIDER);
      const ref = person.provider_ref?.match(/^vibe-p:(.+):(\d+)$/);
      if (ref) {
        const p = fromVibeProspectRow(prospectRow(ref[1]!, Number(ref[2]), person.title ?? ''));
        if (p) return { value: { ...person, ...toPerson(p) }, creditsUsed: 1 };
      }
      const first = person.first_name ?? person.name?.split(' ')[0] ?? 'contact';
      const last = person.last_name ?? person.name?.split(' ').slice(1).join(' ') ?? '';
      const email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '').replace(/\.$/, '') + `@${domain ?? 'example.com'}`;
      return { value: { ...person, email, email_status: 'verified' }, creditsUsed: 1 };
    },

    async jobPostings({ domain }) {
      failIfAsked(PROVIDER);
      return { value: signalsFor(domain).filter((s) => s.fine_type === 'hiring'), creditsUsed: 1 };
    },

    async news({ domain }) {
      failIfAsked(PROVIDER);
      return { value: signalsFor(domain).filter((s) => s.fine_type !== 'hiring'), creditsUsed: 1 };
    },

    async readSite() {
      throw cantDo(PROVIDER);
    },
  };
}
