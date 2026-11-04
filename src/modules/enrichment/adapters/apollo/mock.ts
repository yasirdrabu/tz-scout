import type { CompanyFacts, EnrichmentAdapter, Person, Signal } from '../../contracts/adapter';
import { cantDo } from '../errors';
import { failIfAsked } from '../mock-failure';
import { between, daysAgo, hashString, intBetween, nameFromDomain, pick, rng } from '../sample';

// Sample Apollo, ported from v1 `mock.ts`: a deterministic made-up company per domain, with a tech stack, job
// postings, news and people that exercise every signal type. Credits are reported as Apollo would charge them, so
// estimates and limits behave as they would live. Tests can make it fail (`setMockFailure`).

const PROVIDER = 'Apollo';

const INDUSTRY_OF: Record<string, string> = {
  real: 'Commercial real estate', health: 'Healthcare services', logistics: 'Logistics', legal: 'Legal services', insurance: 'Insurance', finance: 'Financial services',
  pe: 'Private equity', manufacturing: 'Manufacturing', software: 'Software', services: 'Professional services', life: 'Life sciences', food: 'Food and beverage', construction: 'Construction',
};
const FAMILIES = Object.keys(INDUSTRY_OF);

/** The family a domain's words suggest, else null. */
const familyOf = (s: string): string | null => {
  if (/real|property|realty|propert/.test(s)) return 'real';
  if (/health|clinic|hospital|medical|care/.test(s)) return 'health';
  if (/logistic|freight|transport|distribution|carrier/.test(s)) return 'logistics';
  if (/legal|law/.test(s)) return 'legal';
  if (/insur/.test(s)) return 'insurance';
  if (/capital|equity/.test(s)) return 'pe';
  if (/financ|bank|credit/.test(s)) return 'finance';
  if (/manufactur|industries|fabrication/.test(s)) return 'manufacturing';
  if (/software|labs|cloud|systems/.test(s)) return 'software';
  if (/pharma|bio|therapeutic/.test(s)) return 'life';
  if (/food|beverage/.test(s)) return 'food';
  if (/build|construct/.test(s)) return 'construction';
  return null;
};

const TECH_COMMON = ['Microsoft 365', 'Salesforce', 'HubSpot', 'NetSuite', 'QuickBooks', 'Power BI', 'SharePoint', 'ServiceNow', 'Workday', 'Snowflake', 'Tableau', 'Zoom', 'Slack', 'DocuSign'];
const TECH_BY_FAMILY: Record<string, string[]> = { real: ['Yardi', 'AppFolio', 'MRI Software', 'RealPage', 'Entrata'], health: ['Epic', 'athenahealth', 'eClinicalWorks', 'Kareo'], logistics: ['McLeod', 'MercuryGate', 'Samsara'], legal: ['Clio', 'iManage', 'NetDocuments'], insurance: ['Guidewire', 'Applied Epic', 'Duck Creek'], finance: ['Jack Henry', 'FIS', 'nCino'] };
const TECH_LEGACY = ['Microsoft Access', 'Visual Basic', 'FoxPro', 'Lotus Notes', 'IBM AS/400', 'Classic ASP', 'Delphi'];
const TECH_AI = ['OpenAI', 'Microsoft Copilot', 'ChatGPT Enterprise', 'Anthropic'];

const JOBS = {
  ai: ['Director of AI', 'Head of Data and AI', 'Machine Learning Engineer', 'AI Product Manager', 'Automation Engineer', 'Digital Transformation Lead'],
  security: ['Information Security Manager', 'AI Governance Lead', 'Compliance Analyst, AI and Data', 'Privacy Officer', 'Risk and Controls Manager'],
  ops: { real: ['Leasing Coordinator', 'Lease Administrator', 'Asset Management Analyst'], health: ['Prior Authorization Specialist', 'Patient Intake Coordinator', 'Medical Records Clerk'], logistics: ['Dispatcher', 'Freight Pricing Analyst', 'Load Planner'], legal: ['Intake Paralegal', 'Legal Assistant', 'Records Clerk'], insurance: ['Claims Processor', 'Underwriting Assistant', 'First Notice of Loss Specialist'], default: ['Operations Analyst', 'Data Entry Specialist', 'Accounts Payable Clerk'] } as Record<string, string[]>,
  legacy: ['Microsoft Access Developer', 'VB6 Developer', 'Legacy Systems Analyst', 'AS/400 Programmer'],
  analyst: ['Investment Analyst', 'Research Associate', 'Due Diligence Analyst', 'Knowledge Manager'],
  generic: ['Account Executive', 'Software Engineer', 'HR Generalist', 'Marketing Manager', 'Customer Success Manager'],
};

const NEWS: { type: string; t: (n: string) => string }[] = [
  { type: 'leadership', t: (n) => `${n} names new Chief Operating Officer` },
  { type: 'leadership', t: (n) => `${n} appoints first Chief Information Officer` },
  { type: 'leadership', t: (n) => `Longtime ${n} technology chief to retire next year` },
  { type: 'news', t: (n) => `${n} acquires regional competitor` },
  { type: 'news', t: (n) => `${n} opens second headquarters, plans to add 200 jobs` },
  { type: 'news', t: (n) => `${n} announces company-wide AI initiative` },
  { type: 'funding', t: (n) => `${n} secures growth investment to modernize operations` },
  { type: 'risk', t: (n) => `State regulators open review of ${n} data practices` },
];

const FIRST = ['Avery', 'Blake', 'Casey', 'Dana', 'Elliot', 'Harper', 'Jordan', 'Kai', 'Logan', 'Morgan', 'Parker', 'Quinn', 'Reese', 'Rowan', 'Sage', 'Taylor', 'Jules', 'Drew', 'Hayden', 'Marlo', 'Priya', 'Andre', 'Mei', 'Luis', 'Grace', 'Omar', 'Elena', 'Victor'];
const LAST = ['Abbott', 'Banks', 'Carver', 'Delgado', 'Ellis', 'Foster', 'Garza', 'Hughes', 'Jensen', 'Kim', 'Lowe', 'Mendez', 'Nash', 'Ortiz', 'Pryor', 'Rhodes', 'Soto', 'Tran', 'Vance', 'Walsh', 'Young', 'Okafor', 'Patel', 'Haddad', 'Nguyen', 'Brennan'];
const CITIES = ['Charlotte, NC', 'Raleigh, NC', 'Atlanta, GA', 'Nashville, TN', 'Dallas, TX', 'Austin, TX', 'Chicago, IL', 'Columbus, OH', 'Denver, CO', 'Tampa, FL', 'Richmond, VA', 'Indianapolis, IN'];

/** The made-up company for a domain. Every operation derives from the domain, so they agree. */
function companyFor(domain: string) {
  const r = rng(`mockco:${domain}`);
  const name = nameFromDomain(domain);
  const fam = familyOf(domain.toLowerCase()) ?? pick(r, FAMILIES);
  const employees = intBetween(r, 120, 2200);
  return { fam, name, industry: INDUSTRY_OF[fam]!, employees, revenueCents: Math.round(employees * between(r, 150_000, 280_000)) * 100, hq: pick(r, CITIES) };
}

const orgRef = (domain: string) => `mock-org-${hashString(domain).toString(36)}`;
const personRef = (domain: string, i: number) => `mock-person:${domain}:${i}`;

const seniorityOf = (title: string) =>
  /chief|^c[eiotf]o$|president|owner|founder/i.test(title) ? 'c_suite' : /vp|vice/i.test(title) ? 'vp' : /head/i.test(title) ? 'head' : 'director';

function personName(domain: string, i: number) {
  const r = rng(`person:${domain}:${i}`);
  return { first: pick(r, FIRST), last: pick(r, LAST) };
}

const emailFor = (first: string, last: string | null | undefined, domain: string) =>
  `${`${first}.${last ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '').replace(/\.$/, '')}@${domain}`;

export function apolloMock(): EnrichmentAdapter {
  return {
    async test() {
      return { ok: true, message: 'Sample Apollo data is working.' };
    },

    async companyEnrich({ domain }) {
      failIfAsked(PROVIDER);
      const k = companyFor(domain);
      const r = rng(`enrich:${domain}`);
      const techs = new Set<string>();
      for (let i = 0; i < intBetween(r, 4, 7); i++) techs.add(pick(r, TECH_COMMON));
      for (const t of TECH_BY_FAMILY[k.fam] ?? []) if (r() < 0.35) techs.add(t);
      if (r() < 0.22) techs.add(pick(r, TECH_LEGACY));
      if (r() < 0.3) techs.add(pick(r, TECH_AI));
      const [city, region] = k.hq.split(', ');
      const value: CompanyFacts = {
        name: k.name,
        domain,
        website: `https://${domain}`,
        industry: k.industry,
        employees: k.employees,
        revenue_cents: k.revenueCents,
        city: city ?? null,
        region: region ?? null,
        country: 'United States',
        description: `${k.name} is a ${k.industry.toLowerCase()} company based in ${k.hq} with about ${k.employees} employees.`,
        technologies: [...techs],
        keywords: [k.industry.toLowerCase()],
        provider_ref: orgRef(domain),
      };
      return { value, creditsUsed: 1 };
    },

    async peopleSearch({ domain, titles, max }) {
      failIfAsked(PROVIDER);
      const r = rng(`people:${domain}:${titles.join('|')}`);
      const pool = titles.length ? titles : ['COO', 'VP Operations', 'CIO'];
      const n = Math.min(Math.max(0, max), intBetween(r, 1, Math.min(4, pool.length + 1)));
      const value: Person[] = [];
      for (let i = 0; i < n; i++) {
        const title = pool[(i + Math.floor(r() * pool.length)) % pool.length]!;
        const at = hashString(`${title}:${i}`) % 1000;
        const { first } = personName(domain, at);
        // As Apollo's free search: a first name and title, no last name or email.
        value.push({ name: first, first_name: first, title, seniority: seniorityOf(title), provider_ref: personRef(domain, at) });
      }
      return { value, creditsUsed: 0 };
    },

    async revealEmail({ person, domain }) {
      failIfAsked(PROVIDER);
      const ref = person.provider_ref?.match(/^mock-person:(.+):(\d+)$/);
      const at = ref ? { domain: ref[1]!, ...personName(ref[1]!, Number(ref[2])) } : null;
      const first = at?.first ?? person.first_name ?? person.name?.split(' ')[0] ?? 'contact';
      const last = at?.last ?? person.last_name ?? person.name?.split(' ').slice(1).join(' ') ?? null;
      const site = at?.domain ?? domain ?? 'example.com';
      const value: Person = {
        ...person,
        name: [first, last].filter(Boolean).join(' '),
        first_name: first,
        last_name: last || null,
        email: emailFor(first, last, site),
        email_status: 'verified',
      };
      return { value, creditsUsed: 1 };
    },

    async jobPostings({ domain, orgId }) {
      failIfAsked(PROVIDER);
      const k = companyFor(domain);
      const r = rng(`jobs:${domain}`);
      const titles: string[] = [];
      const n = intBetween(r, 1, 7);
      for (let i = 0; i < n; i++) {
        const x = r();
        if (x < 0.18) titles.push(pick(r, JOBS.ai));
        else if (x < 0.3 && ['health', 'finance', 'insurance', 'legal', 'software'].includes(k.fam)) titles.push(pick(r, JOBS.security));
        else if (x < 0.55) titles.push(pick(r, JOBS.ops[k.fam] ?? JOBS.ops.default!));
        else if (x < 0.62) titles.push(pick(r, JOBS.legacy));
        else if (x < 0.7 && ['pe', 'real', 'life', 'finance'].includes(k.fam)) titles.push(pick(r, JOBS.analyst));
        else titles.push(pick(r, JOBS.generic));
      }
      const value: Signal[] = [...new Set(titles)].map((t) => ({
        type: 'pain',
        fine_type: 'hiring',
        title: `Hiring: ${t}`,
        occurred_at: daysAgo(intBetween(r, 1, 95)),
        url: `https://${domain}/careers`,
        detail: k.hq,
      }));
      // Without an organization id, Apollo would be asked for the company first.
      return { value, creditsUsed: orgId ? 1 : 2 };
    },

    async news({ domain, orgId }) {
      failIfAsked(PROVIDER);
      const k = companyFor(domain);
      const r = rng(`news:${domain}`);
      const n = r() < 0.45 ? intBetween(r, 1, 2) : 0;
      const value: Signal[] = [];
      for (let i = 0; i < n; i++) {
        const t = pick(r, NEWS);
        value.push({ type: 'trigger', fine_type: t.type, title: t.t(k.name), occurred_at: daysAgo(intBetween(r, 3, 160)) });
      }
      return { value, creditsUsed: orgId ? 1 : 2 };
    },

    async readSite() {
      throw cantDo(PROVIDER);
    },
  };
}
