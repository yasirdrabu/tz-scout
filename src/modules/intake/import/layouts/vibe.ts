// A Vibe Prospecting (Explorium) dataset export to arrivals. Ported from v1 `vibe.ts` and `vibeExport.ts`.
// Vibe stores lists and events as JSON strings; ranges come wrapped in brackets ("[201-500]").
// Whether a company is a vendor or a unit of a parent is decided by Accounts' exclusion rules. This file only
// hands over the facts they read: the industry text and the `parent_name` fact.

import { MAX_SIGNALS, type ArrivalV1 } from '../../contracts/arrival';
import { defined } from '../../domain/normalise-arrival';
import { industryKey } from '../../domain/industry';
import type { ParsedFile } from '../parse';
import type { ArrivalDraft, ImportLayout } from './index';

type Row = Record<string, string | undefined>;
type Signal = NonNullable<ArrivalV1['signals']>[number];
type Person = ArrivalV1['people'][number];

type RawEvent = Record<string, unknown> & { event_name: string; event_time: string };
type VibeEvent = { type: string; date: string; title?: string | null; detail?: string | null; url?: string | null };

type VibeCompany = {
  businessId: string;
  name: string;
  domain: string;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  naics: string | null;
  naicsDescription: string | null;
  linkedinCategory: string | null;
  employeesRange: string | null;
  revenueRange: string | null;
  description: string | null;
  techStack: string[];
  intent: { topic: string; score: number }[];
  /** Share of staff by department (0..1) and change in roles last quarter. */
  workforce?: { share: Record<string, number>; change: Record<string, number> };
  events: VibeEvent[];
};

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
const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const clip = (s: string, n = 140) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n))}...`);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** "machine learning & artificial intelligence: ai risk management" is "AI risk management". */
export function topicLabel(topic: string): string {
  const t = topic.includes(':') ? topic.split(':').slice(1).join(':').trim() : topic.trim();
  return t
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bit\b/g, 'IT')
    .replace(/\bgenai\b/gi, 'generative AI')
    .replace(/\s*\([a-z]{2,6}\)$/, '')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** "The Fortegra Group, Inc." is "fortegra": for checking a news item is about this company. */
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

const EXEC = /\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|president|founder|vp|vice president|head of|general counsel)\b/i;

/** One Vibe event to a signal type and title, or null if it isn't a buying signal. */
export function mapEvent(e: VibeEvent): { type: string; title: string } | null {
  const t = e.type.toLowerCase();
  const detail = [e.title, e.detail].filter(Boolean).join(' ');
  const dept = (s: string) => s.replace(/_department$/, '').replace(/^(hiring_in|increase_in|decrease_in)_/, '').replace(/_/g, ' ');
  if (t.startsWith('hiring_in_')) return { type: 'hiring', title: `Hiring in ${dept(t)}${e.title ? `: ${e.title}` : ''}` };
  if (t === 'increase_in_operations_department') return { type: 'workforce', title: 'Operations team growing' };
  if (t === 'increase_in_all_departments') return { type: 'workforce', title: 'Hiring across every department' };
  if (t.startsWith('increase_in_')) return { type: 'workforce', title: `${titleCase(dept(t))} team growing` };
  if (t.startsWith('decrease_in_')) return { type: 'news', title: `Cost cutting: ${dept(t)} team shrinking` };
  if (t === 'employee_joined_company') {
    return EXEC.test(detail) ? { type: 'leadership', title: `New leader joined${e.title ? `: ${e.title}` : ''}` } : null;
  }
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

/** A row from a Vibe dataset export (get-dataset, load_into "context") to a company. */
export function fromVibeExportRow(r: Row, now: Date): VibeCompany {
  const cutoff = now.getTime() - EVENT_WINDOW_DAYS * 86400_000;
  const events: VibeEvent[] = [];
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
      const d = describe(e, company);
      events.push({ type: e.event_name, date: day(new Date(e.event_time)), title: d.title, detail: d.detail, url: d.url });
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
    workforce: Object.keys(share).length || Object.keys(change).length ? { share, change } : undefined,
    events,
  };
}

/**
 * Every buying signal Vibe gives us for a company. Events are dated by Vibe. Intent is research and may be undated
 * (the pipeline dates it with the import). Team makeup and growth are a snapshot, so they take today's date.
 */
export function vibeSignals(c: VibeCompany, now: Date): Signal[] {
  const out: Signal[] = [];
  for (const i of c.intent) {
    if (i.score < 50) continue;
    out.push({
      fine_type: 'intent',
      title: `Researching: ${topicLabel(i.topic)}`,
      detail: `Research score ${i.score} of 100 this week. 60 or more is active research; 80 or more is a strong spike.`,
    });
  }
  const today = day(now);
  const ops = c.workforce?.share.operations;
  if (ops != null && ops >= 0.1) {
    out.push({ fine_type: 'workforce', title: `Operations is ${Math.round(ops * 100)}% of staff`, detail: 'Share of employees in operations roles, from public profiles.', occurred_at: today });
  }
  for (const [dept, n] of Object.entries(c.workforce?.change ?? {})) {
    if (n >= 3) out.push({ fine_type: 'workforce', title: `${titleCase(dept)} team growing: ${n} more people last quarter`, occurred_at: today });
  }
  const events: Signal[] = [];
  for (const e of c.events) {
    const m = mapEvent(e);
    if (!m || Number.isNaN(new Date(e.date).getTime())) continue;
    events.push(defined({ fine_type: m.type, title: m.title, occurred_at: e.date, detail: e.detail ?? undefined, url: e.url ?? undefined }) as Signal);
  }
  // An arrival holds 50 signals: the snapshot ones above, then the newest events.
  events.sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));
  return [...out, ...events].slice(0, MAX_SIGNALS);
}

// ---------- People ----------

type VibePerson = { prospectId: string; businessId: string; firstName: string; lastName: string | null; title: string | null; email: string | null; phone: string | null; linkedin: string | null };

/** A row from a Vibe prospects export (with contact enrichment) to one person. */
export function fromVibeProspectRow(r: Row): VibePerson | null {
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
    phone: r.contact_mobile_phone?.trim() || null,
    linkedin: li ? (li.startsWith('http') ? li : `https://${li}`) : null,
  };
}

/**
 * Seniority from a title, for picking who to approach first. Kept here as v1's number because Vibe people are
 * listed most senior first; Accounts has its own category for the stored person.
 */
export function seniority(title: string | null): number {
  const t = (title ?? '').toLowerCase();
  if (/\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|cmo)\b/.test(t)) return 40;
  if (/\bpresident\b/.test(t) && !/\bvice\b/.test(t)) return 35;
  if (/\b(svp|evp|vp|vice president)\b/.test(t)) return 30;
  if (/\bhead of\b|\bhead\b/.test(t)) return 25;
  if (/\bdirector\b/.test(t)) return 20;
  return 10;
}

// ---------- Industry and parent ----------

/** The text to hand `industryKey`: the NAICS code if it maps, else the LinkedIn category, else Vibe's description. */
function industryText(c: VibeCompany): string | undefined {
  const candidates = [c.naics, c.linkedinCategory, c.naicsDescription].map((t) => t?.trim()).filter((t): t is string => !!t);
  return candidates.find((t) => industryKey(t)) ?? [c.linkedinCategory, c.naicsDescription, c.naics].find((t) => t?.trim())?.trim();
}

const PARENT_TEXT = /\b(?:is part of|a subsidiary of|a division of|an? ([A-Z][\w&]*(?: [A-Z][\w&]*){0,3}) company\b)\s*([A-Z][\w&]*(?: [A-Z][\w&]*){0,3})?/;

/** "X is part of HCA Healthcare" gives "HCA Healthcare". Null when the text names the company itself. */
function parentNameOf(c: VibeCompany): string | null {
  const p = c.description?.match(PARENT_TEXT);
  if (!p) return null;
  const parent = (p[1] ?? p[2] ?? '').trim();
  const first = c.name.split(' ')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return parent && !new RegExp(`^${first}`, 'i').test(parent) ? parent : null;
}

// ---------- Rows to arrivals ----------

const isVibeExport = (headers: string[]) =>
  headers.includes('business_name') || headers.includes('business_domain') || (headers.includes('prospect_id') && headers.includes('business_id'));

type Group = { company: VibeCompany; people: Map<string, VibePerson>; signals: Signal[]; rows: string[][] };

function toArrivals(parsed: ParsedFile, ctx: { now: Date }): ArrivalDraft[] {
  const groups = new Map<string, Group>();
  for (const row of parsed.rows) {
    const r: Row = Object.fromEntries(parsed.headers.map((h, i) => [h, row[i]?.trim() || undefined]));
    const company = fromVibeExportRow(r, ctx.now);
    const key = company.domain || company.businessId || company.name;
    if (!key) continue;
    const g: Group = groups.get(key) ?? { company, people: new Map(), signals: [], rows: [] };
    g.rows.push(row);
    for (const s of vibeSignals(company, ctx.now)) {
      if (!g.signals.some((x) => x.title === s.title && x.occurred_at === s.occurred_at)) g.signals.push(s);
    }
    const p = fromVibeProspectRow(r);
    if (p && !g.people.has(p.email ?? p.prospectId)) g.people.set(p.email ?? p.prospectId, p);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const c = g.company;
    const people: Person[] = [...g.people.values()]
      .sort((a, b) => seniority(b.title) - seniority(a.title))
      .map((p) => defined({ first_name: p.firstName, last_name: p.lastName ?? undefined, title: p.title ?? undefined, email: p.email ?? undefined, phone: p.phone ?? undefined, linkedin_url: p.linkedin ?? undefined }) as Person);
    const parent = parentNameOf(c);
    const body: ArrivalV1 = {
      account: defined({
        name: c.name || undefined,
        domain: c.domain || undefined,
        website: c.website ?? undefined,
        linkedin_url: c.linkedin ? (c.linkedin.startsWith('http') ? c.linkedin : `https://${c.linkedin}`) : undefined,
        country: c.country ?? undefined,
        region: c.region ?? undefined,
        city: c.city ?? undefined,
        industry: industryText(c),
        employees_range: c.employeesRange ?? undefined,
        revenue_range: c.revenueRange ?? undefined,
        description: c.description ?? undefined,
        technologies: c.techStack.length ? c.techStack : undefined,
        external_ref: c.businessId || undefined,
      }),
      people,
      signals: g.signals.slice(0, MAX_SIGNALS),
      facts: parent ? { parent_name: parent } : {},
      sole_proprietor: false,
    };
    return { body, raw: { headers: parsed.headers, rows: g.rows } };
  });
}

export const vibeExportLayout: ImportLayout = { key: 'vibe_export', detect: isVibeExport, toArrivals };
