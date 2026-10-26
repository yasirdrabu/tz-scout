// Mock prospect source. Deterministic fictional companies shaped by the search filters, with tech
// stacks, job postings, news and people that exercise every signal type. Credits are reported as
// Apollo would charge, so the cost shown before a pull is realistic. None of these companies are real.

import { between, hashString, intBetween, pick, rng } from "@/lib/rand";
import { KNOWN_COMPANIES } from "../companyData/fixtures";
import type { CompanyDetail, JobPosting, NewsItem, ProspectAdapter, ProspectCompany, ProspectFilters, ProspectPerson } from "./types";

const NAME_A = ["Granite", "Harbor", "Summit", "Cedar", "Northfield", "Bluestone", "Ironwood", "Silverline", "Oakmont", "Riverbend", "Westlake", "Crescent", "Pinecrest", "Redrock", "Lakeshore", "Fairview", "Stonegate", "Meridian", "Clearwater", "Highland", "Copperleaf", "Brightpath", "Keystone", "Sterling", "Evergreen", "Juniper", "Tidewater", "Foxhollow", "Ridgeway", "Beacon"];
const NAME_B: Record<string, string[]> = {
  real: ["Properties", "Realty Partners", "Commercial", "Real Estate Group", "Property Management", "Residential", "Living", "Communities"],
  health: ["Health", "Medical Group", "Care Partners", "Clinics", "Health Network", "Physicians"],
  logistics: ["Freight", "Logistics", "Transport", "Carriers", "Distribution"],
  legal: ["Law Group", "Legal", "Attorneys"],
  insurance: ["Insurance", "Underwriters", "Risk Partners", "Mutual"],
  finance: ["Financial", "Bank", "Credit Union", "Capital"],
  pe: ["Capital", "Equity Partners", "Holdings"],
  manufacturing: ["Manufacturing", "Industries", "Fabrication", "Works"],
  software: ["Software", "Labs", "Systems", "Cloud"],
  services: ["Advisors", "Consulting", "Partners", "Group"],
  life: ["Therapeutics", "Bio", "Pharma"],
  food: ["Foods", "Beverage Co", "Brands"],
  construction: ["Builders", "Construction", "Contractors"],
};
const INDUSTRY_OF: Record<string, string> = {
  real: "Commercial real estate", health: "Healthcare services", logistics: "Logistics", legal: "Legal services", insurance: "Insurance", finance: "Financial services",
  pe: "Private equity", manufacturing: "Manufacturing", software: "Software", services: "Professional services", life: "Life sciences", food: "Food and beverage", construction: "Construction",
};
const familyOf = (industry: string): string => {
  const s = industry.toLowerCase();
  if (/real estate|property|proptech/.test(s)) return "real";
  if (/health|clinic|hospital|medical/.test(s)) return "health";
  if (/logistic|freight|transport|distribution/.test(s)) return "logistics";
  if (/legal|law/.test(s)) return "legal";
  if (/insur/.test(s)) return "insurance";
  if (/private equity|capital/.test(s)) return "pe";
  if (/financ|bank|credit/.test(s)) return "finance";
  if (/manufactur/.test(s)) return "manufacturing";
  if (/software|saas|it services/.test(s)) return "software";
  if (/life science|pharma|bio/.test(s)) return "life";
  if (/food|beverage/.test(s)) return "food";
  if (/construct/.test(s)) return "construction";
  return "services";
};

const TECH_COMMON = ["Microsoft 365", "Salesforce", "HubSpot", "NetSuite", "QuickBooks", "Power BI", "SharePoint", "ServiceNow", "Workday", "Snowflake", "Tableau", "Zoom", "Slack", "DocuSign"];
const TECH_BY_FAMILY: Record<string, string[]> = { real: ["Yardi", "AppFolio", "MRI Software", "RealPage", "Entrata"], health: ["Epic", "athenahealth", "eClinicalWorks", "Kareo"], logistics: ["McLeod", "MercuryGate", "Samsara"], legal: ["Clio", "iManage", "NetDocuments"], insurance: ["Guidewire", "Applied Epic", "Duck Creek"], finance: ["Jack Henry", "FIS", "nCino"] };
const TECH_LEGACY = ["Microsoft Access", "Visual Basic", "FoxPro", "Lotus Notes", "IBM AS/400", "Classic ASP", "Delphi"];
const TECH_AI = ["OpenAI", "Microsoft Copilot", "ChatGPT Enterprise", "Anthropic"];

const JOBS = {
  ai: ["Director of AI", "Head of Data and AI", "Machine Learning Engineer", "AI Product Manager", "Automation Engineer", "Digital Transformation Lead"],
  security: ["Information Security Manager", "AI Governance Lead", "Compliance Analyst, AI and Data", "Privacy Officer", "Risk and Controls Manager"],
  ops: { real: ["Leasing Coordinator", "Lease Administrator", "Asset Management Analyst"], health: ["Prior Authorization Specialist", "Patient Intake Coordinator", "Medical Records Clerk"], logistics: ["Dispatcher", "Freight Pricing Analyst", "Load Planner"], legal: ["Intake Paralegal", "Legal Assistant", "Records Clerk"], insurance: ["Claims Processor", "Underwriting Assistant", "First Notice of Loss Specialist"], default: ["Operations Analyst", "Data Entry Specialist", "Accounts Payable Clerk"] } as Record<string, string[]>,
  legacy: ["Microsoft Access Developer", "VB6 Developer", "Legacy Systems Analyst", "AS/400 Programmer"],
  analyst: ["Investment Analyst", "Research Associate", "Due Diligence Analyst", "Knowledge Manager"],
  generic: ["Account Executive", "Software Engineer", "HR Generalist", "Marketing Manager", "Customer Success Manager"],
};

const NEWS = [
  { cat: ["hires"], t: (n: string) => `${n} names new Chief Operating Officer` },
  { cat: ["hires"], t: (n: string) => `${n} appoints first Chief Information Officer` },
  { cat: ["hires"], t: (n: string) => `Longtime ${n} technology chief to retire next year` },
  { cat: ["acquisition"], t: (n: string) => `${n} acquires regional competitor` },
  { cat: ["expansion"], t: (n: string) => `${n} opens second headquarters, plans to add 200 jobs` },
  { cat: ["product"], t: (n: string) => `${n} announces company-wide AI initiative` },
  { cat: ["investment"], t: (n: string) => `${n} secures growth investment to modernize operations` },
  { cat: ["regulation"], t: (n: string) => `State regulators open review of ${n} data practices` },
];

const FIRST = ["Avery", "Blake", "Casey", "Dana", "Elliot", "Harper", "Jordan", "Kai", "Logan", "Morgan", "Parker", "Quinn", "Reese", "Rowan", "Sage", "Taylor", "Jules", "Drew", "Hayden", "Marlo", "Priya", "Andre", "Mei", "Luis", "Grace", "Omar", "Elena", "Victor"];
const LAST = ["Abbott", "Banks", "Carver", "Delgado", "Ellis", "Foster", "Garza", "Hughes", "Jensen", "Kim", "Lowe", "Mendez", "Nash", "Ortiz", "Pryor", "Rhodes", "Soto", "Tran", "Vance", "Walsh", "Young", "Okafor", "Patel", "Haddad", "Nguyen", "Brennan"];
const CITIES = ["Charlotte, NC", "Raleigh, NC", "Atlanta, GA", "Nashville, TN", "Dallas, TX", "Austin, TX", "Chicago, IL", "Columbus, OH", "Denver, CO", "Tampa, FL", "Richmond, VA", "Indianapolis, IN"];

const DAY = 86400_000;
const iso = (d: Date) => d.toISOString();

/** Stable fictional company for an id. All other calls derive from the id, so they agree. */
function companyFor(id: string) {
  const r = rng(`mockco:${id}`);
  const fam = id.split(":")[1] ?? "services";
  const known = id.startsWith("known:") ? id.slice(6) : null;
  if (known && KNOWN_COMPANIES[known]) {
    const k = KNOWN_COMPANIES[known]!;
    return { r, fam: familyOf(k.industry ?? "services"), name: k.name!, domain: known, industry: k.industry, employees: k.employees, revenueCents: k.revenueCents, hq: k.hq ?? pick(r, CITIES), description: k.description };
  }
  const name = `${pick(r, NAME_A)} ${pick(r, NAME_B[fam] ?? NAME_B.services!)}`;
  const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.com`;
  const lo = Number(id.split(":")[2] ?? 120);
  const hi = Number(id.split(":")[3] ?? 2200);
  const employees = intBetween(r, lo, hi);
  return { r, fam, name, domain, industry: INDUSTRY_OF[fam] ?? "Professional services", employees, revenueCents: Math.round(employees * between(r, 150_000, 280_000)) * 100, hq: pick(r, CITIES), description: null as string | null };
}

export function createMockProspects(): ProspectAdapter {
  return {
    provider: "mock",
    mode: "mock",
    estimateCredits(n) {
      return Math.ceil(n / 100) + n + n + Math.ceil(n / 25);
    },

    async searchCompanies(f: ProspectFilters, max) {
      const fams = f.industries.length ? [...new Set(f.industries.map(familyOf))] : ["services", "real", "health", "logistics"];
      const lo = f.employeeMin ?? 100;
      const hi = Math.max(lo + 50, Math.min(f.employeeMax ?? 2500, 5000));
      const seed = hashString(JSON.stringify(f));
      const out: ProspectCompany[] = [];
      // Known demo companies first when they match, so the story lines up with the sample leads.
      for (const [domain, k] of Object.entries(KNOWN_COMPANIES)) {
        if (!k.industry || !fams.includes(familyOf(k.industry)) || f.excludeDomains.includes(domain)) continue;
        if (/harborpoint|lumenvale|orbit|tinyshop|quietwater/.test(domain)) continue;
        out.push({ externalId: `known:${domain}`, name: k.name!, domain, websiteUrl: `https://${domain}`, linkedinUrl: null });
      }
      // Real searches return some misfits (keyword matches in the wrong industry, stale headcounts),
      // so about a quarter of mock results are off-industry or outside the size range.
      const allFams = Object.keys(INDUSTRY_OF);
      for (let i = 0; out.length < max && i < max * 3; i++) {
        const n = (seed + i * 7919) % 100000;
        const off = n % 4 === 0;
        const fam = off && n % 8 === 0 ? allFams[n % allFams.length]! : fams[i % fams.length]!;
        const [clo, chi] = off && n % 8 !== 0 ? (n % 3 === 0 ? [Math.max(10, Math.round(lo * 0.25)), Math.round(lo * 0.8)] : [Math.round(hi * 1.2), Math.round(hi * 2.5)]) : [lo, hi];
        const id = `gen:${fam}:${clo}:${chi}:${n}`;
        const c = companyFor(id);
        if (out.some((x) => x.domain === c.domain) || f.excludeDomains.includes(c.domain)) continue;
        out.push({ externalId: id, name: c.name, domain: c.domain, websiteUrl: `https://${c.domain}`, linkedinUrl: null });
      }
      await new Promise((res) => setTimeout(res, 200));
      return { companies: out.slice(0, max), total: 340 + (seed % 900), credits: Math.ceil(max / 100) };
    },

    async enrichCompany(c) {
      const k = companyFor(c.externalId);
      const r = rng(`enrich:${c.externalId}`);
      const techs = new Set<string>();
      for (let i = 0; i < intBetween(r, 4, 7); i++) techs.add(pick(r, TECH_COMMON));
      for (const t of TECH_BY_FAMILY[k.fam] ?? []) if (r() < 0.35) techs.add(t);
      if (r() < 0.22 || c.domain === "northgate-freight.com") techs.add(c.domain === "northgate-freight.com" ? "Microsoft Access" : pick(r, TECH_LEGACY));
      if (r() < 0.3) techs.add(pick(r, TECH_AI));
      const growth = Math.round(between(r, -0.06, 0.32) * 100) / 100;
      const funding = r() < 0.22 ? [{ id: `f-${c.externalId}`, date: iso(new Date(Date.now() - intBetween(r, 20, 400) * DAY)), type: pick(r, ["Series B", "Growth equity", "Private equity", "Series C"]), amountCents: intBetween(r, 8, 90) * 1_000_000 * 100, url: null }] : [];
      const [city, state] = k.hq.split(", ");
      const detail: CompanyDetail = {
        externalId: c.externalId,
        name: k.name,
        domain: c.domain,
        websiteUrl: `https://${c.domain}`,
        linkedinUrl: null,
        foundedYear: intBetween(r, 1962, 2016),
        industry: k.industry ?? null,
        employees: k.employees ?? null,
        revenueCents: k.revenueCents ?? null,
        city: city ?? null,
        state: state ?? null,
        country: "United States",
        description: k.description ?? `${k.name} is a ${(k.industry ?? "mid-market").toLowerCase()} company based in ${k.hq} with about ${k.employees} employees.`,
        technologies: [...techs],
        keywords: [(k.industry ?? "").toLowerCase()].filter(Boolean),
        headcountGrowth6m: growth,
        funding,
      };
      return { detail, credits: 1 };
    },

    async jobPostings(externalId, domain) {
      const k = companyFor(externalId);
      const r = rng(`jobs:${externalId}`);
      const titles: string[] = [];
      const n = intBetween(r, 1, 7);
      for (let i = 0; i < n; i++) {
        const x = r();
        if (x < 0.18) titles.push(pick(r, JOBS.ai));
        else if (x < 0.3 && ["health", "finance", "insurance", "legal", "software"].includes(k.fam)) titles.push(pick(r, JOBS.security));
        else if (x < 0.55) titles.push(pick(r, JOBS.ops[k.fam] ?? JOBS.ops.default!));
        else if (x < 0.62) titles.push(pick(r, JOBS.legacy));
        else if (x < 0.7 && ["pe", "real", "life", "finance"].includes(k.fam)) titles.push(pick(r, JOBS.analyst));
        else titles.push(pick(r, JOBS.generic));
      }
      if (domain === "northgate-freight.com") titles.push("Microsoft Access Developer");
      if (domain === "cedarline-health.com") titles.push("AI Governance Lead");
      const jobs: JobPosting[] = [...new Set(titles)].map((t, i) => ({ id: `${externalId}:job:${i}`, title: t, url: `https://${domain}/careers`, postedAt: iso(new Date(Date.now() - intBetween(r, 1, 95) * DAY)), location: k.hq }));
      return { jobs, credits: 1 };
    },

    async news(orgs) {
      const items: NewsItem[] = [];
      for (const o of orgs) {
        const k = companyFor(o.externalId);
        const r = rng(`news:${o.externalId}`);
        const n = r() < 0.45 ? intBetween(r, 1, 2) : 0;
        for (let i = 0; i < n; i++) {
          const t = pick(r, NEWS);
          items.push({ id: `${o.externalId}:news:${i}`, title: t.t(k.name), url: null, snippet: null, publishedAt: iso(new Date(Date.now() - intBetween(r, 3, 160) * DAY)), categories: t.cat, orgIds: [o.externalId] });
        }
      }
      return { items, credits: Math.ceil(orgs.length / 25) };
    },

    async searchPeople(org, titles) {
      const r = rng(`people:${org.externalId}`);
      const pool = titles.length ? titles : ["COO", "VP Operations", "CIO"];
      const people: ProspectPerson[] = [];
      const n = intBetween(r, 1, Math.min(4, pool.length + 1));
      for (let i = 0; i < n; i++) {
        const title = pool[(i + Math.floor(r() * pool.length)) % pool.length]!;
        people.push({ externalId: `${org.externalId}:p:${i}`, firstName: pick(r, FIRST), lastName: pick(r, LAST), title, seniority: /chief|^c[eiotf]o$|president|owner|founder/i.test(title) ? "c_suite" : /vp|vice/i.test(title) ? "vp" : /head/i.test(title) ? "head" : "director", linkedinUrl: null, hasEmail: r() < 0.85 });
      }
      return { people, credits: 0 };
    },

    async revealEmail(p) {
      const local = `${p.firstName}.${p.lastName ?? ""}`.toLowerCase().replace(/[^a-z.]/g, "").replace(/\.$/, "");
      return { email: `${local}@${p.domain}`, status: "verified", credits: 1 };
    },
  };
}
