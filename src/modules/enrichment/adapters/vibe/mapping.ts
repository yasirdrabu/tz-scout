// Vibe Prospecting (Explorium) data to arrival-shaped values. Pure mapping carried from v1 `vibe.ts` and
// `vibeExport.ts` (Ruling 2), with v1's tests. A Vibe dataset export stores lists and events as JSON strings and wraps
// ranges in brackets ("[201-500]"). Exclusions (vendors, units of a parent) are Accounts' rules, so they are not here.

import type { CompanyFacts, EmailStatus, Person, Signal } from '../../contracts/adapter';

/** Our signal fine types that Vibe data produces. */
export type SignalType = 'intent' | 'hiring' | 'workforce' | 'leadership' | 'funding' | 'news' | 'risk';

export type VibeCompany = {
  businessId: string;
  name: string;
  domain: string;
  website?: string | null;
  linkedin?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  naics?: string | null;
  naicsDescription?: string | null;
  linkedinCategory?: string | null;
  employeesRange?: string | null; // "501-1000"
  revenueRange?: string | null; // "75M-200M"
  description?: string | null;
  techStack?: string[];
  intent?: { topic: string; score: number }[];
  /** Share of staff by department (0..1) and change in roles last quarter. */
  workforce?: { share?: Record<string, number>; change?: Record<string, number>; quarter?: string | null };
  events?: { type: string; date: string; title?: string | null; detail?: string | null; url?: string | null; id?: string | null }[];
};

export type SignalDraft = { type: SignalType; title: string; detail?: string | null; url?: string | null; value?: number | null; occurredAt: Date; externalId: string };

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** "501-1000" -> 708 (geometric middle), "10001+" -> 10001. */
export function rangeMid(range: string | null | undefined, unit = 1): number | null {
  if (!range) return null;
  const m = range.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)([KMBT])?(?:-(\d+(?:\.\d+)?)([KMBT])?)?\+?$/i);
  if (!m) return null;
  const mult = (s?: string) => ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 })[(s ?? '').toUpperCase() as 'K'] ?? 1;
  const lo = Number(m[1]) * mult(m[2] ?? m[4]);
  const hi = m[3] ? Number(m[3]) * mult(m[4]) : lo;
  return Math.round(Math.sqrt(Math.max(lo, 1) * Math.max(hi, 1)) * unit);
}

/** "machine learning & artificial intelligence: ai risk management" -> "AI risk management" */
export function topicLabel(topic: string): string {
  const t = topic.includes(':') ? topic.split(':').slice(1).join(':').trim() : topic.trim();
  return t
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bit\b/g, 'IT')
    .replace(/\bgenai\b/gi, 'generative AI')
    .replace(/\s*\([a-z]{2,6}\)$/, '')
    .replace(/^\w/, (c) => c.toUpperCase());
}

// NAICS prefix to the industry words our offers use. Longest prefix wins.
const NAICS_INDUSTRY: [string, string][] = [
  ['5311', 'Commercial real estate'], ['5312', 'Real estate brokerage'], ['5313', 'Property management'], ['531', 'Real estate'],
  ['524', 'Insurance'], ['52', 'Financial services'],
  ['621', 'Healthcare services: clinics and outpatient'], ['622', 'Healthcare services: hospitals'], ['623', 'Healthcare services: nursing and residential care'], ['62', 'Healthcare services'],
  ['493', 'Logistics: warehousing'], ['484', 'Logistics: trucking'], ['488', 'Logistics: freight'], ['48', 'Logistics and transportation'], ['49', 'Logistics and transportation'],
  ['31', 'Manufacturing'], ['32', 'Manufacturing'], ['33', 'Manufacturing'], ['42', 'Wholesale distribution'],
  ['5411', 'Legal services'], ['54', 'Professional services'], ['23', 'Construction'], ['92', 'Government services'],
];

/** Our industry label from a NAICS code, falling back to Vibe's description. */
export function industryFor(naics: string | null | undefined, description?: string | null): string | null {
  const code = (naics ?? '').trim();
  const hit = NAICS_INDUSTRY.filter(([p]) => code.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : (description ?? null);
}

const EXEC = /\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|president|founder|vp|vice president|head of|general counsel)\b/i;

/** One Vibe event to one of our signals, or null if it isn't a buying signal. */
export function mapEvent(e: NonNullable<VibeCompany['events']>[number]): { type: SignalType; title: string } | null {
  const t = e.type.toLowerCase();
  const detail = [e.title, e.detail].filter(Boolean).join(' ');
  const dept = (s: string) => s.replace(/_department$/, '').replace(/^(hiring_in|increase_in|decrease_in)_/, '').replace(/_/g, ' ');
  if (t.startsWith('hiring_in_')) return { type: 'hiring', title: `Hiring in ${dept(t)}${e.title ? `: ${e.title}` : ''}` };
  if (t === 'increase_in_operations_department') return { type: 'workforce', title: 'Operations team growing' };
  if (t === 'increase_in_all_departments') return { type: 'workforce', title: 'Hiring across every department' };
  if (t.startsWith('increase_in_')) return { type: 'workforce', title: `${titleCase(dept(t))} team growing` };
  if (t.startsWith('decrease_in_')) return { type: 'news', title: `Cost cutting: ${dept(t)} team shrinking` };
  if (t === 'employee_joined_company') return EXEC.test(detail) ? { type: 'leadership', title: `New leader joined${e.title ? `: ${e.title}` : ''}` } : null;
  // new_investment is the company spending (a new building, a project), not raising money.
  if (t === 'new_investment') return { type: 'news', title: e.title ? `Investing: ${e.title}` : 'Announced a new investment' };
  if (t === 'new_funding_round' || t === 'ipo_announcement') return { type: 'funding', title: e.title || titleCase(t.replace(/_/g, ' ')) };
  if (t === 'merger_and_acquisitions') return { type: 'news', title: e.title ? `Acquisition or merger: ${e.title}` : 'Acquisition or merger' };
  if (t === 'new_office') return { type: 'news', title: e.title ? `Expansion, new office: ${e.title}` : 'Expansion, opened a new office' };
  if (t === 'closing_office') return { type: 'news', title: 'Cost cutting, closing an office' };
  if (t === 'cost_cutting') return { type: 'news', title: e.title ? `Cost cutting: ${e.title}` : 'Cost cutting' };
  if (t === 'outages_and_security_breaches') return { type: 'risk', title: e.title ? `Security breach or outage: ${e.title}` : 'Security breach or outage reported' };
  if (t === 'lawsuits_and_legal_issues') return { type: 'risk', title: e.title ? `Lawsuit: ${e.title}` : 'Lawsuit or legal issue reported' };
  if (t === 'new_product' || t === 'new_partnership' || t === 'company_award') return { type: 'news', title: e.title || titleCase(t.replace(/_/g, ' ')) };
  return null;
}

/** Every buying signal Vibe gives us for a company. */
export function vibeSignals(c: VibeCompany, now: Date): SignalDraft[] {
  const out: SignalDraft[] = [];
  for (const i of c.intent ?? []) {
    if (i.score < 50) continue;
    out.push({ type: 'intent', title: `Researching: ${topicLabel(i.topic)}`, detail: `Research score ${i.score} of 100 this week. 60 or more is active research; 80 or more is a strong spike.`, value: i.score / 100, occurredAt: now, externalId: `intent:${i.topic}` });
  }
  const ops = c.workforce?.share?.operations;
  if (ops != null && ops >= 0.1) out.push({ type: 'workforce', title: `Operations is ${Math.round(ops * 100)}% of staff`, detail: 'Share of employees in operations roles, from public profiles.', value: ops, occurredAt: now, externalId: 'workforce:ops-share' });
  for (const [dept, n] of Object.entries(c.workforce?.change ?? {})) {
    if (n >= 3) out.push({ type: 'workforce', title: `${titleCase(dept)} team growing: ${n} more people last quarter`, value: n, occurredAt: now, externalId: `workforce:change:${dept}` });
  }
  for (const [i, e] of (c.events ?? []).entries()) {
    const m = mapEvent(e);
    const at = new Date(e.date);
    if (!m || Number.isNaN(at.getTime())) continue;
    out.push({ type: m.type, title: m.title, detail: e.detail ?? null, url: e.url ?? null, occurredAt: at, externalId: `event:${e.id ?? `${e.type}:${e.date}:${i}`}` });
  }
  return out;
}

// ---------- Dataset export rows ----------

export type VibeExportRow = Record<string, string | null | undefined>;

type RawEvent = Record<string, unknown> & { event_name: string; event_time: string };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const unwrap = (s: string | null | undefined) => (s ? s.replace(/^\[|\]$/g, '').trim() || null : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());
const clip = (s: string, n = 140) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n))}...`);

/** "The Fortegra Group, Inc." -> "fortegra": for checking a news item is about this company. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[®™.,()&]/g, ' ')
    .replace(/\b(the|inc|llc|ltd|co|corp|corporation|company|companies|group|holdings|sdn bhd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vibe attaches M&A coverage by name match, so plenty of it is about someone else. Keep it only when this company is a party. */
export function isParty(company: string, involved: unknown): boolean {
  if (!Array.isArray(involved)) return false;
  const key = nameKey(company);
  return !!key && involved.some((c) => typeof c === 'string' && nameKey(c).startsWith(key));
}

/** Title and detail for one raw Vibe event, in our words. mapEvent then decides the signal type. */
function describe(e: RawEvent, company: string): { title: string | null; detail: string | null; url: string | null } {
  const url = str(e.link);
  switch (e.event_name) {
    case 'employee_joined_company': {
      const who = [str(e.full_name), str(e.job_department)].filter(Boolean).join(', ');
      return { title: str(e.job_role_title), detail: who || null, url: str(e.linkedin_url) ? `https://${String(e.linkedin_url).replace(/^https?:\/\//, '')}` : null };
    }
    case 'merger_and_acquisitions': {
      const headline = str(e.title);
      const first = company.split(' ')[0]!.toLowerCase();
      const title = headline && headline.toLowerCase().includes(first) ? headline : str(e.description) ? clip(String(e.description)) : headline;
      return { title, detail: str(e.description) ?? str(e.snippet), url };
    }
    case 'new_office':
      return { title: str(e.title), detail: [str(e.purpose_of_new_office), str(e.office_location)].filter(Boolean).join('. ') || str(e.snippet), url };
    case 'lawsuits_and_legal_issues':
      return { title: str(e.title), detail: [str(e.case_type), str(e.court)].filter(Boolean).join(', ') || null, url };
    case 'new_funding_round': {
      const t = [str(e.investment_amount_string) && `Raised ${e.investment_amount_string}`, str(e.funding_stage)].filter(Boolean).join(', ');
      return { title: t || str(e.title), detail: str(e.lead_investor) ? `Led by ${e.lead_investor}.` : str(e.snippet), url };
    }
    case 'outages_and_security_breaches': {
      const n = typeof e.number_of_affected_customers === 'number' ? e.number_of_affected_customers : null;
      const t = [str(e.incident_type) && cap(String(e.incident_type)), n ? `${n.toLocaleString('en-US')} people affected` : null].filter(Boolean).join(', ');
      return { title: t || str(e.title), detail: str(e.snippet), url };
    }
    default:
      if (e.event_name.startsWith('hiring_in_')) {
        const titles = Array.isArray(e.job_titles) ? (e.job_titles as string[]).slice(0, 3).join(', ') : null;
        const n = typeof e.job_count === 'number' ? e.job_count : null;
        return { title: titles, detail: [n ? `${n} open role${n === 1 ? '' : 's'}` : null, str(e.location)].filter(Boolean).join(', ') || null, url };
      }
      if (e.event_name.startsWith('increase_in_') || e.event_name.startsWith('decrease_in_')) {
        const n = typeof e.department_change === 'number' ? e.department_change : null;
        return { title: null, detail: n != null ? `Department headcount changed ${n > 0 ? '+' : ''}${n}% this period.` : null, url };
      }
      return { title: str(e.title), detail: str(e.snippet) ?? str(e.description), url };
  }
}

/** Events older than this are history, not a reason to call now. */
export const EVENT_WINDOW_DAYS = 365;
/** News-type events kept per type, most recent first. Hires and new leaders are kept in full. */
const NEWS_PER_TYPE = 3;
const CRIME = /\b(murder|homicide|assault|robbery|shooting|stabbing|manslaughter|theft|burglary|criminal)\b/i;

export function fromVibeExportRow(r: VibeExportRow, now: Date): VibeCompany {
  const cutoff = now.getTime() - EVENT_WINDOW_DAYS * 86400_000;
  const events: NonNullable<VibeCompany['events']> = [];
  const company = r.business_name ?? '';
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith('event_')) continue;
    const list = json<RawEvent[]>(v, [])
      .filter((e) => {
        const t = new Date(e.event_time).getTime();
        if (Number.isNaN(t) || t < cutoff) return false;
        if (e.event_name === 'merger_and_acquisitions') return isParty(company, e.companies_involved);
        // Crime stories land on the hospital the victim went to. Not the company's legal exposure.
        if (e.event_name === 'lawsuits_and_legal_issues') return !CRIME.test(String(e.case_type ?? ''));
        return true;
      })
      .sort((a, b) => b.event_time.localeCompare(a.event_time));
    const keepAll = /^(employee_joined_company|hiring_in_)/.test(k.replace(/^event_/, ''));
    for (const e of keepAll ? list : list.slice(0, NEWS_PER_TYPE)) {
      const at = new Date(e.event_time);
      const d = describe(e, company);
      const date = at.toISOString().slice(0, 10);
      events.push({ type: e.event_name, date, title: d.title, detail: d.detail, url: d.url, id: `${e.event_name}:${date}:${slug(d.title ?? d.detail ?? '')}` });
    }
  }

  const share: Record<string, number> = {};
  const change: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    const n = v == null || v === '' ? NaN : Number(v);
    if (Number.isNaN(n)) continue;
    const p = k.match(/^work_trend_perc_(.+)_roles$/);
    if (p) share[p[1]!.replace(/_/g, ' ')] = n / 100;
    const c = k.match(/^work_trend_change_in_(.+)_roles$/);
    if (c) change[c[1]!.replace(/_/g, ' ')] = n;
  }

  return {
    businessId: r.business_id ?? r.business_domain ?? '',
    name: r.business_name ?? r.business_domain ?? '',
    domain: (r.business_domain ?? '').toLowerCase(),
    website: r.business_website ?? null,
    linkedin: r.business_linkedin_profile ?? null,
    city: r.business_city_name ?? null,
    region: r.business_region ?? null,
    country: r.business_country_name ?? null,
    naics: r.business_naics ?? null,
    naicsDescription: r.business_naics_description ?? null,
    linkedinCategory: r.business_linkedin_industry_category ?? null,
    employeesRange: unwrap(r.business_number_of_employees_range),
    revenueRange: unwrap(r.business_yearly_revenue_range),
    description: r.business_business_description ?? null,
    techStack: json<string[]>(r.tech_full_tech_stack, []),
    intent: json<{ topic: string; score: number }[]>(r.business_business_intent_topics, []),
    workforce: Object.keys(share).length || Object.keys(change).length ? { share, change, quarter: r.work_trend_quarters ?? null } : undefined,
    events,
  };
}

// ---------- People ----------

export type VibePerson = { prospectId: string; businessId: string; firstName: string; lastName: string | null; title: string | null; email: string | null; emailStatus: string | null; phone: string | null; linkedin: string | null };

/** A row from a Vibe prospects export (with contact enrichment) to one person. */
export function fromVibeProspectRow(r: VibeExportRow): VibePerson | null {
  if (!r.prospect_id || !r.business_id) return null;
  // Vibe sometimes splits "Ed Romito, Chcio, Cdh-e" into first "Romito", last "Romito, Chcio, ...".
  // When the parts look wrong, read the name from the full name, dropping credentials after the comma.
  let first = (r.prospect_first_name ?? '').trim();
  let last = (r.prospect_last_name ?? '').trim();
  const full = (r.prospect_full_name ?? '').split(',')[0]!.trim();
  if (full && (!first || last.includes(',') || !full.toLowerCase().startsWith(first.toLowerCase()))) {
    const parts = full.split(/\s+/);
    first = parts[0] ?? first;
    last = parts.slice(1).join(' ');
  }
  if (!first) return null;
  const li = r.prospect_linkedin?.trim();
  return {
    prospectId: r.prospect_id,
    businessId: r.business_id,
    firstName: first,
    lastName: last || null,
    title: r.prospect_job_title ? r.prospect_job_title.replace(/^\w/, (c) => c.toUpperCase()) : null,
    email: r.contact_professional_email?.trim().toLowerCase() || null,
    emailStatus: r.contact_professional_email_status?.trim() || null,
    phone: r.contact_mobile_phone?.trim() || null,
    linkedin: li ? (li.startsWith('http') ? li : `https://${li}`) : null,
  };
}

/** Seniority from a title, for picking who to approach first. */
export function seniority(title: string | null): number {
  const t = (title ?? '').toLowerCase();
  if (/\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|cmo)\b/.test(t)) return 40;
  if (/\bpresident\b/.test(t) && !/\bvice\b/.test(t)) return 35;
  if (/\b(svp|evp|vp|vice president)\b/.test(t)) return 30;
  if (/\bhead of\b|\bhead\b/.test(t)) return 25;
  if (/\bdirector\b/.test(t)) return 20;
  return 10;
}

// ---------- To arrival-shaped values ----------

/** The signal kind each fine type has in Accounts (`SIGNAL_TYPES`). */
const KIND: Record<SignalType, 'research' | 'trigger' | 'pain'> = {
  intent: 'research',
  leadership: 'trigger',
  funding: 'trigger',
  news: 'trigger',
  risk: 'trigger',
  hiring: 'pain',
  workforce: 'pain',
};

/** Seniority words as Apollo spells them, from `seniority`'s score. */
const SENIORITY_LABEL: Record<number, string> = { 40: 'c_suite', 35: 'c_suite', 30: 'vp', 25: 'head', 20: 'director' };

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

export function toCompanyFacts(c: VibeCompany): CompanyFacts {
  const revenue = rangeMid(c.revenueRange);
  return defined({
    name: c.name || null,
    domain: c.domain || null,
    website: c.website ?? null,
    linkedin_url: c.linkedin ?? null,
    city: c.city ?? null,
    region: c.region ?? null,
    country: c.country ?? null,
    industry: industryFor(c.naics, c.naicsDescription),
    employees: rangeMid(c.employeesRange),
    employees_range: c.employeesRange ?? null,
    revenue_cents: revenue === null ? null : revenue * 100,
    revenue_range: c.revenueRange ?? null,
    description: c.description ?? null,
    technologies: c.techStack?.length ? c.techStack : null,
    provider_ref: c.businessId || null,
  });
}

export function toSignals(drafts: SignalDraft[]): Signal[] {
  return drafts.map((s) =>
    defined({
      type: KIND[s.type],
      fine_type: s.type,
      title: s.title,
      occurred_at: s.occurredAt.toISOString().slice(0, 10),
      url: s.url ?? null,
      detail: s.detail ?? null,
    }),
  );
}

/** Vibe's email statuses ("valid", "catch-all", "invalid", ...) as the accounts fact values. */
function emailStatusOf(email: string | null, status: string | null): EmailStatus {
  if (!email) return 'unavailable';
  const s = (status ?? '').toLowerCase();
  if (s === 'valid' || s === 'verified') return 'verified';
  if (s === 'invalid' || s === 'bounced') return 'bounced';
  return 'guessed';
}

export function toPerson(p: VibePerson): Person {
  return {
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    first_name: p.firstName,
    last_name: p.lastName,
    title: p.title,
    email: p.email,
    email_status: emailStatusOf(p.email, p.emailStatus),
    seniority: SENIORITY_LABEL[seniority(p.title)] ?? null,
    phone: p.phone,
    linkedin_url: p.linkedin,
    provider_ref: p.prospectId,
  };
}
