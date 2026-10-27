// ABM research sheets: one company per row with a dated, sourced buying signal, the decision-makers, a proposed
// pilot, an outreach hook, and the researcher's own score and tier. Ported from v1 `research.ts`. Several column
// layouts exist (one per research agent); each field below lists every header it has appeared under, and a row
// takes the first non-empty one, so "master" files that stack two layouts read cleanly.

import type { ArrivalV1 } from '../../contracts/arrival';
import { defined } from '../../domain/normalise-arrival';
import { domainFromEmail, normaliseDomain } from '../../domain/normalise';
import type { ParsedFile } from '../parse';
import type { ArrivalDraft, ImportLayout } from './index';

export const RESEARCH_FIELDS = {
  reportDate: ['report_date'],
  agent: ['agent'],
  company: ['account', 'account_name', 'company'],
  website: ['official_website', 'website', 'company_website'],
  key: ['dedupe_key', 'account_key'],
  hq: ['hq', 'headquarters'],
  industry: ['industry'],
  scale: ['revenue_or_scale', 'annual_revenue_usd', 'reported_revenue_usd', 'reported_revenue_or_other_scale', 'reported_scale_nonrevenue', 'other_scale_evidence'],
  employees: ['employees', 'reported_employees'],
  signalDate: ['signal_date'],
  signal: ['signal', 'verified_signal'],
  signalUrl: ['signal_source_url', 'signal_source'],
  decisionMakers: ['decision_makers', 'verified_decision_makers'],
  roles: ['decision_maker_roles'],
  contactRoute: ['public_business_contact', 'public_business_contact_path', 'public_business_contact_route'],
  tech: ['observed_marketing_tech_stack', 'verified_tech_stack', 'observed_technology_stack'],
  problem: ['gtm_problem_hypothesis', 'data_problem_hypothesis', 'legacy_evidence_or_hypothesis'],
  useCase: ['proposed_use_case', 'proposed_marketing_services', 'proposed_ai_personalized_operating_platform', 'architecture_opportunity'],
  hook: ['personalized_outreach_hook', 'outreach_hook', 'personalized_abm_outreach_hook'],
  pilot: ['paid_discovery_or_pilot', 'proposed_30_day_audit_or_pilot', 'proposed_paid_discovery_or_pilot', 'paid_assessment_offer'],
  price: ['estimated_service_fee_usd'],
  roi: ['roi_hypothesis', 'roi_hypothesis_not_guarantee'],
  approach: ['phased_migration_approach'],
  nextAction: ['immediate_next_action', 'recommended_next_action', 'next_action'],
  incumbent: ['incumbent_or_vendor', 'known_incumbent_or_partner'],
  caveats: ['qualification_caveat', 'qualification_notes', 'confidence_notes', 'qualifications_and_incumbents'],
  score: ['abm_score', 'abm_score_100', 'score_total'],
  intent: ['intent_score_0_100', 'intent_score_100', 'normalized_intent_100'],
  tier: ['abm_tier'],
} as const;
export type ResearchField = keyof typeof RESEARCH_FIELDS;
/** Each field to every column it appears under, in column order. */
export type ResearchMap = Partial<Record<ResearchField, number[]>>;

type Place = { city: string | null; state: string | null };
type FileSignal = NonNullable<ArrivalV1['signals']>[number];
type Person = ArrivalV1['people'][number];

export type ResearchEntry = {
  reportDate: string | null;
  score: number | null;
  intent: number | null;
  tier: 'A' | 'B' | 'C' | null;
  signal: { title: string; date: string | null; url: string | null; fineType: string } | null;
  hook: string | null;
  problem: string | null;
  useCase: string | null;
  pilot: string | null;
  price: string | null;
  roi: string | null;
  approach: string | null;
  nextAction: string | null;
  incumbent: string | null;
  caveats: string | null;
  tech: string | null;
  scale: string | null;
  hq: string | null;
  contactRoute: string | null;
};

const normHeader = (h: string) => h.replace(/^\uFEFF/, '').replace(/ \(\d+\)$/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The research columns in a header row, or null if this isn't a research sheet. */
export function detectResearch(headers: string[]): ResearchMap | null {
  const H = headers.map(normHeader);
  const map: ResearchMap = {};
  for (const [field, aliases] of Object.entries(RESEARCH_FIELDS) as [ResearchField, readonly string[]][]) {
    const cols = H.map((h, i) => (aliases.includes(h) ? i : -1)).filter((i) => i >= 0);
    if (cols.length) map[field] = cols;
  }
  return map.company && map.signal && (map.tier || map.score) ? map : null;
}

// Placeholder text researchers use for "we don't know"; treated as empty.
const UNKNOWN = /^(not (publicly |independently )?verified|unverified|n\/a|none|unknown|not established|no reliable .*|not disclosed)\b/i;
const val = (row: string[], cols: number[] | undefined) => {
  for (const c of cols ?? []) {
    const v = (row[c] ?? '').trim();
    if (v && !UNKNOWN.test(v)) return v;
  }
  return null;
};

/** "1,001-5,000" is a geometric middle; "250" is 250; "51-200 employees" is 101. */
function employeesOf(value: string | null): number | null {
  const nums = value?.replace(/,/g, '').match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return null;
  return nums.length === 1 ? nums[0]! : Math.round(Math.sqrt(nums[0]! * nums[1]!));
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
/** "300+ (reported Sep 2026)" is 300; "~3,900 parent employees reported Jun 2025" is 3900; "<200" is 200. */
export function researchEmployees(text: string | null): number | null {
  if (!text) return null;
  const t = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+20\\d\\d\\b`, 'gi'), ' ')
    .replace(/\b(19|20)\d\d\b/g, ' ');
  return employeesOf(t.replace(/[–—]/g, '-'));
}

/** Splits on a separator outside parentheses: "A (x; y); B" is ["A (x; y)", "B"]. */
function splitTop(s: string, sep = ';'): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NOISE = /\b(verify|verified|filing|profile|listing|report|reported|source|trade|third[- ]party|since|reverify|ncua)\b/i;
function cleanTitle(t: string): string | null {
  let s = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // "COO, oversees enterprise operations" is "COO"; "President and CEO, Kaleris" stays.
  s = s
    .split(/,\s+/)
    .filter((part, i) => i === 0 || (/^[A-Z]/.test(part) && !NOISE.test(part)))
    .join(', ');
  return s || null;
}

/** "Sam Liang — Co-founder & CEO; Amy Martin — CMO", "Mel Hudson-Nowak (CTO)", or names with a parallel roles list. */
export function parseDecisionMakers(
  text: string | null,
  roles?: string | null,
): { firstName: string; lastName: string | null; title: string | null }[] {
  if (!text) return [];
  const roleList = roles ? splitTop(roles) : [];
  const people: { firstName: string; lastName: string | null; title: string | null }[] = [];
  splitTop(text).forEach((item, i) => {
    let name = item;
    let title: string | null = null;
    const dash = item.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    const paren = item.match(/^([^()]+?)\s*\((.+)\)\s*$/);
    if (dash) [name, title] = [dash[1]!, dash[2]!];
    else if (paren) [name, title] = [paren[1]!, paren[2]!];
    title = title ? cleanTitle(title) : roleList[i] ? cleanTitle(roleList[i]!) : null;
    name = name.replace(/^["']|["']$/g, '').trim();
    // A person's name: two to five words, starts with a capital, no digits or addresses.
    const words = name.split(/\s+/);
    if (words.length < 2 || words.length > 5 || !/^\p{Lu}/u.test(name) || /[\d@/]/.test(name) || UNKNOWN.test(name)) return;
    people.push({ firstName: words[0]!, lastName: words.slice(1).join(' '), title });
  });
  return people;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s;,)]+/g;
const letters = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

/** A published email belongs to a decision-maker when its local part carries their last name. */
export function emailFor(person: { firstName: string; lastName: string | null }, route: string | null): string | null {
  if (!route || !person.lastName) return null;
  const last = letters(person.lastName.split(/\s+/).pop() ?? '');
  if (last.length < 3) return null;
  return (route.match(EMAIL) ?? []).find((e) => letters(e.split('@')[0]!).includes(last))?.toLowerCase() ?? null;
}

/** What kind of trigger a research signal is. Anything unrecognised is a company event. */
export function signalTypeOf(text: string): 'leadership' | 'funding' | 'news' {
  const t = text.toLowerCase();
  if (
    /(appoint|\bnam(ed|es)\b|\bhire[ds]?\b|\bnew (ceo|cfo|cio|cto|coo|cmo|chief|president)|\bfirst (cmo|cio|cto|chief)|elevat|leadership transition)/.test(t) &&
    /(ceo|cfo|cio|cto|cmo|coo|chief|president|officer|leader|\bvp\b)/.test(t)
  ) {
    return 'leadership';
  }
  if (/(acqui|merger|\bcombin|roll-?up)/.test(t)) return 'news';
  if (/(rais(ed|es)|financing|\bfunding|series [a-e]\b|\bseed\b|growth investment|completed investment|capital partners|backed)/.test(t)) return 'funding';
  return 'news';
}

function signalDate(text: string | null, fallback: string | null): string | null {
  const d = text?.match(/\b(20\d\d-\d\d-\d\d)\b/)?.[1];
  if (d) return d;
  const y = text?.match(/\b(20\d\d)\b/)?.[1];
  return y ? `${y}-01-01` : fallback;
}

function priceOf(price: string | null, pilot: string | null): string | null {
  const range = price?.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
  if (range) {
    const k = (n: string) => `$${Math.round(Number(n.replace(/,/g, '')) / 1000)}K`;
    return `${k(range[1]!)} to ${k(range[2]!)}`;
  }
  const inPilot = pilot?.match(/\$\s?\d[\d,.]*\s?[kKmM]?(?:\s?[-–]\s?\$?\d[\d,.]*\s?[kKmM]?)?/g);
  return inPilot ? inPilot.map((p) => p.replace(/\s/g, '').replace(/k\b/, 'K')).join(' + ') : null;
}

/** The first amount in a price text such as "$15K to $35K", in cents. */
function firstAmountCents(price: string | null): number | null {
  const m = price?.match(/\$(\d[\d,.]*)([KM])?/);
  if (!m) return null;
  const dollars = Number(m[1]!.replace(/,/g, '')) * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/** The research in one row. */
export function researchOf(row: string[], m: ResearchMap): ResearchEntry {
  const v = (f: ResearchField) => val(row, m[f]);
  const reportDate = v('reportDate')?.match(/\d{4}-\d\d-\d\d/)?.[0] ?? null;
  const title = v('signal');
  const url = v('signalUrl')?.match(URL_RE)?.[0] ?? null;
  const tier = v('tier')?.toUpperCase().match(/^[ABC]/)?.[0] as 'A' | 'B' | 'C' | undefined;
  const num = (f: ResearchField) => {
    const n = Number(v(f)?.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && v(f) ? Math.round(n) : null;
  };
  return {
    reportDate,
    score: num('score'),
    intent: num('intent'),
    tier: tier ?? null,
    signal: title ? { title: title.slice(0, 500), date: signalDate(v('signalDate'), reportDate), url, fineType: signalTypeOf(title) } : null,
    hook: v('hook'),
    problem: v('problem'),
    useCase: v('useCase'),
    pilot: v('pilot'),
    price: priceOf(v('price'), v('pilot')),
    roi: v('roi'),
    approach: v('approach'),
    nextAction: v('nextAction'),
    incumbent: v('incumbent'),
    caveats: v('caveats'),
    tech: v('tech'),
    scale: v('scale'),
    hq: v('hq'),
    contactRoute: v('contactRoute'),
  };
}

/** "Mountain View, CA" is city and state; "Michigan (HQ unverified)" is state only. */
export function placeOf(hq: string | null): Place {
  if (!hq) return { city: null, state: null };
  const first = hq.split(/;| \/ /)[0]!.replace(/\([^)]*\)/g, '').trim();
  const parts = first.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0]!, state: parts[1]! };
  return { city: null, state: parts[0] ?? null };
}

/** The company's domain: website, then a domain-shaped dedupe key, then a work email or URL in the contact route. */
function researchDomain(row: string[], m: ResearchMap): string | null {
  const site = normaliseDomain(val(row, m.website));
  if (site) return site;
  const key = val(row, m.key);
  if (key?.includes('.')) {
    const d = normaliseDomain(key);
    if (d) return d;
  }
  const route = val(row, m.contactRoute) ?? '';
  for (const e of route.match(EMAIL) ?? []) {
    const d = normaliseDomain(domainFromEmail(e));
    if (d) return d;
  }
  for (const u of route.match(URL_RE) ?? []) {
    const d = normaliseDomain(u);
    if (d) return d;
  }
  return null;
}

const rank = (e: ResearchEntry) => `${e.reportDate ?? ''}|${String(e.score ?? 0).padStart(3, '0')}`;

type Company = {
  name: string;
  domain: string | null;
  website: string | null;
  place: Place;
  industry: string | null;
  employees: number | null;
  agent: string | null;
  research: ResearchEntry;
  signals: FileSignal[];
  people: Person[];
  rows: string[][];
};

const personKey = (p: Person) => `${p.first_name} ${p.last_name}`.toLowerCase();

function bodyOf(c: Company, fileName: string): ArrivalV1 {
  const r = c.research;
  const technologies = r.tech?.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  const custom = defined({ proposed_use_case: r.useCase ?? undefined, phased_approach: r.approach ?? undefined, scale: r.scale ?? undefined, intent_score: r.intent ?? undefined });
  return {
    account: defined({
      name: c.name,
      domain: c.domain ?? undefined,
      website: c.website ?? undefined,
      city: c.place.city ?? undefined,
      region: c.place.state ?? undefined,
      country: 'United States',
      industry: c.industry ?? undefined,
      employees: c.employees ?? undefined,
      practice_hint: c.agent ?? (fileName.replace(/\.[^.]+$/, '') || undefined),
      technologies: technologies?.length ? technologies : undefined,
      custom_fields: Object.keys(custom).length ? custom : undefined,
    }),
    people: c.people,
    signals: c.signals,
    facts: {},
    research: defined({
      hook: r.hook ?? undefined,
      problem: r.problem ?? undefined,
      pilot: r.pilot ?? undefined,
      price_cents: firstAmountCents(r.price) ?? undefined,
      value_hypothesis: r.roi ?? undefined,
      incumbent: r.incumbent ?? undefined,
      caveats: r.caveats ?? undefined,
      contact_route: r.contactRoute ?? undefined,
      next_action: r.nextAction ?? undefined,
      researcher_score: r.score ?? undefined,
      researcher_tier: r.tier ?? undefined,
    }),
    sole_proprietor: false,
  };
}

/**
 * Rows to one arrival per company. A company listed twice (a master file, or several days) keeps the newest research
 * and every signal. A company with no website is kept by name, so it waits for one.
 */
function toArrivals(parsed: ParsedFile, ctx: { fileName: string }): ArrivalDraft[] {
  const m = detectResearch(parsed.headers)!;
  const byKey = new Map<string, Company>();
  for (const row of parsed.rows) {
    const name = val(row, m.company);
    if (!name) continue;
    const domain = researchDomain(row, m);
    const research = researchOf(row, m);
    const key = domain ?? `name:${name.toLowerCase()}`;
    const c: Company =
      byKey.get(key) ??
      {
        name,
        domain,
        website: normaliseDomain(val(row, m.website)) ? val(row, m.website) : null,
        place: placeOf(research.hq),
        industry: null,
        employees: null,
        agent: null,
        research,
        signals: [],
        people: [],
        rows: [],
      };
    c.rows.push(row);
    c.industry ??= val(row, m.industry);
    c.employees ??= researchEmployees(val(row, m.employees));
    c.agent ??= val(row, m.agent);
    if (rank(research) > rank(c.research)) c.research = research;
    const s = research.signal;
    if (s && !c.signals.some((x) => x.title === s.title)) {
      c.signals.push(defined(s.date ? { fine_type: s.fineType, title: s.title, occurred_at: s.date, url: s.url ?? undefined } : { type: 'research' as const, title: s.title, url: s.url ?? undefined }) as FileSignal);
    }
    for (const p of parseDecisionMakers(val(row, m.decisionMakers), val(row, m.roles))) {
      const person = defined({ first_name: p.firstName, last_name: p.lastName ?? undefined, title: p.title ?? undefined, email: emailFor(p, research.contactRoute) ?? undefined }) as Person;
      if (!c.people.some((x) => personKey(x) === personKey(person))) c.people.push(person);
    }
    byKey.set(key, c);
  }
  return [...byKey.values()].map((c) => ({ body: bodyOf(c, ctx.fileName), raw: { headers: parsed.headers, rows: c.rows } }));
}

const isMaster = (headers: string[]) => Object.values(detectResearch(headers) ?? {}).some((cols) => cols.length > 1);

/** A stacked file: two research layouts in one sheet, so a field sits under more than one column. */
export const researchMasterLayout: ImportLayout = {
  key: 'research_master',
  detect: (headers) => isMaster(headers),
  toArrivals,
};

export const researchLayout: ImportLayout = {
  key: 'research',
  detect: (headers) => detectResearch(headers) !== null,
  toArrivals,
};
