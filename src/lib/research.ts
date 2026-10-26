// ABM research sheets: one company per row with a dated, sourced buying signal, the decision-makers,
// a proposed pilot, an outreach hook, and the researcher's own score and tier. Several column layouts
// exist (one per research agent); each field below lists every header it has appeared under, and a row
// takes the first non-empty one, so "master" files that stack two layouts read cleanly. Pure and tested.

import { createHash } from "node:crypto";
import { domainOf, employeesOf, type SheetCompany, type SheetPerson, type SkippedRow } from "./leadSheet";
import type { SignalType, Tier } from "./matching";

export const RESEARCH_FIELDS = {
  reportDate: ["report_date"],
  agent: ["agent"],
  company: ["account", "account_name", "company"],
  website: ["official_website", "website", "company_website"],
  key: ["dedupe_key", "account_key"],
  hq: ["hq", "headquarters"],
  industry: ["industry"],
  scale: ["revenue_or_scale", "annual_revenue_usd", "reported_revenue_usd", "reported_revenue_or_other_scale", "reported_scale_nonrevenue", "other_scale_evidence"],
  employees: ["employees", "reported_employees"],
  signalDate: ["signal_date"],
  signal: ["signal", "verified_signal"],
  signalUrl: ["signal_source_url", "signal_source"],
  decisionMakers: ["decision_makers", "verified_decision_makers"],
  roles: ["decision_maker_roles"],
  contactRoute: ["public_business_contact", "public_business_contact_path", "public_business_contact_route"],
  tech: ["observed_marketing_tech_stack", "verified_tech_stack", "observed_technology_stack"],
  problem: ["gtm_problem_hypothesis", "data_problem_hypothesis", "legacy_evidence_or_hypothesis"],
  useCase: ["proposed_use_case", "proposed_marketing_services", "proposed_ai_personalized_operating_platform", "architecture_opportunity"],
  hook: ["personalized_outreach_hook", "outreach_hook", "personalized_abm_outreach_hook"],
  pilot: ["paid_discovery_or_pilot", "proposed_30_day_audit_or_pilot", "proposed_paid_discovery_or_pilot", "paid_assessment_offer"],
  price: ["estimated_service_fee_usd"],
  roi: ["roi_hypothesis", "roi_hypothesis_not_guarantee"],
  approach: ["phased_migration_approach"],
  nextAction: ["immediate_next_action", "recommended_next_action", "next_action"],
  incumbent: ["incumbent_or_vendor", "known_incumbent_or_partner"],
  caveats: ["qualification_caveat", "qualification_notes", "confidence_notes", "qualifications_and_incumbents"],
  score: ["abm_score", "abm_score_100", "score_total"],
  intent: ["intent_score_0_100", "intent_score_100", "normalized_intent_100"],
  tier: ["abm_tier"],
} as const;
export type ResearchField = keyof typeof RESEARCH_FIELDS;
/** Each field to every column it appears under, in column order. */
export type ResearchMap = Partial<Record<ResearchField, number[]>>;

export type ResearchSignal = { title: string; date: string; url: string | null; type: SignalType };
export type ResearchEntry = {
  listId?: string;
  bucket?: string | null;
  reportDate: string | null;
  score: number | null;
  intent: number | null;
  tier: "A" | "B" | "C" | null;
  signal: ResearchSignal | null;
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
  phone: string | null;
};
export type ResearchCompany = SheetCompany & { research: ResearchEntry; signals: ResearchSignal[] };

const normHeader = (h: string) => h.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");

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
    const v = (row[c] ?? "").trim();
    if (v && !UNKNOWN.test(v)) return v;
  }
  return null;
};

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
/** "300+ (reported Sep 2026)" -> 300; "~3,900 parent employees reported Jun 2025" -> 3900; "<200" -> 200. */
export function researchEmployees(text: string | null): number | null {
  if (!text) return null;
  const t = text
    .replace(/\([^)]*\)/g, " ")
    .replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+20\\d\\d\\b`, "gi"), " ")
    .replace(/\b(19|20)\d\d\b/g, " ");
  return employeesOf(t.replace(/[–—]/g, "-"));
}

/** Splits on a separator outside parentheses: "A (x; y); B" -> ["A (x; y)", "B"]. */
function splitTop(s: string, sep = ";"): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NOISE = /\b(verify|verified|filing|profile|listing|report|reported|source|trade|third[- ]party|since|reverify|ncua)\b/i;
function cleanTitle(t: string): string | null {
  let s = t.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // "COO, oversees enterprise operations" -> "COO"; "President and CEO, Kaleris" stays.
  s = s
    .split(/,\s+/)
    .filter((part, i) => i === 0 || (/^[A-Z]/.test(part) && !NOISE.test(part)))
    .join(", ");
  return s || null;
}

/** "Sam Liang — Co-founder & CEO; Amy Martin — CMO", "Mel Hudson-Nowak (CTO)", or names with a parallel roles list. */
export function parseDecisionMakers(text: string | null, roles?: string | null): { firstName: string; lastName: string | null; title: string | null }[] {
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
    name = name.replace(/^["']|["']$/g, "").trim();
    // A person's name: two to five words, starts with a capital, no digits or addresses.
    const words = name.split(/\s+/);
    if (words.length < 2 || words.length > 5 || !/^\p{Lu}/u.test(name) || /[\d@/]/.test(name) || UNKNOWN.test(name)) return;
    people.push({ firstName: words[0]!, lastName: words.slice(1).join(" "), title });
  });
  return people;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const URL_RE = /https?:\/\/[^\s;,)]+/g;
const letters = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

/** A published email belongs to a decision-maker when its local part carries their last name. */
export function emailFor(person: { firstName: string; lastName: string | null }, route: string | null): string | null {
  if (!route || !person.lastName) return null;
  const last = letters(person.lastName.split(/\s+/).pop() ?? "");
  if (last.length < 3) return null;
  return (route.match(EMAIL) ?? []).find((e) => letters(e.split("@")[0]!).includes(last))?.toLowerCase() ?? null;
}

/** What kind of trigger a research signal is. Anything unrecognised is a company event. */
export function signalTypeOf(text: string): SignalType {
  const t = text.toLowerCase();
  if (/(appoint|\bnam(ed|es)\b|\bhire[ds]?\b|\bnew (ceo|cfo|cio|cto|coo|cmo|chief|president)|\bfirst (cmo|cio|cto|chief)|elevat|leadership transition)/.test(t) && /(ceo|cfo|cio|cto|cmo|coo|chief|president|officer|leader|\bvp\b)/.test(t)) return "leadership";
  if (/(acqui|merger|\bcombin|roll-?up)/.test(t)) return "news";
  if (/(rais(ed|es)|financing|\bfunding|series [a-e]\b|\bseed\b|growth investment|completed investment|capital partners|backed)/.test(t)) return "funding";
  return "news";
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
    const k = (n: string) => `$${Math.round(Number(n.replace(/,/g, "")) / 1000)}K`;
    return `${k(range[1]!)} to ${k(range[2]!)}`;
  }
  const inPilot = pilot?.match(/\$\s?\d[\d,.]*\s?[kKmM]?(?:\s?[-–]\s?\$?\d[\d,.]*\s?[kKmM]?)?/g);
  return inPilot ? inPilot.map((p) => p.replace(/\s/g, "").replace(/k\b/, "K")).join(" + ") : null;
}

/** The research in one row. */
export function researchOf(row: string[], m: ResearchMap): ResearchEntry {
  const v = (f: ResearchField) => val(row, m[f]);
  const reportDate = v("reportDate")?.match(/\d{4}-\d\d-\d\d/)?.[0] ?? null;
  const title = v("signal");
  const url = v("signalUrl")?.match(URL_RE)?.[0] ?? null;
  const tier = v("tier")?.toUpperCase().match(/^[ABC]/)?.[0] as "A" | "B" | "C" | undefined;
  const num = (f: ResearchField) => {
    const n = Number(v(f)?.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && v(f) ? Math.round(n) : null;
  };
  const date = signalDate(v("signalDate"), reportDate);
  const route = v("contactRoute");
  return {
    reportDate,
    score: num("score"),
    intent: num("intent"),
    tier: tier ?? null,
    signal: title && date ? { title: title.slice(0, 500), date, url, type: signalTypeOf(title) } : null,
    hook: v("hook"),
    problem: v("problem"),
    useCase: v("useCase"),
    pilot: v("pilot"),
    price: priceOf(v("price"), v("pilot")),
    roi: v("roi"),
    approach: v("approach"),
    nextAction: v("nextAction"),
    incumbent: v("incumbent"),
    caveats: v("caveats"),
    tech: v("tech"),
    scale: v("scale"),
    hq: v("hq"),
    contactRoute: route,
    phone: route?.match(PHONE)?.[0] ?? null,
  };
}

/** "Mountain View, CA" -> city and state; "Michigan (HQ unverified)" -> state only. */
export function placeOf(hq: string | null): { city: string | null; state: string | null } {
  if (!hq) return { city: null, state: null };
  const first = hq.split(/;| \/ /)[0]!.replace(/\([^)]*\)/g, "").trim();
  const parts = first.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0]!, state: parts[1]! };
  return { city: null, state: parts[0] ?? null };
}

/** The company's domain: website, then a domain-shaped dedupe key, then a work email or URL in the contact route. */
export function researchDomain(row: string[], m: ResearchMap): string | null {
  const site = domainOf(val(row, m.website));
  if (site) return site;
  const key = val(row, m.key);
  if (key && key.includes(".")) {
    const d = domainOf(key);
    if (d) return d;
  }
  const route = val(row, m.contactRoute) ?? "";
  for (const e of route.match(EMAIL) ?? []) {
    const d = domainOf(e);
    if (d) return d;
  }
  for (const u of route.match(URL_RE) ?? []) {
    const d = domainOf(u);
    if (d) return d;
  }
  return null;
}

const rank = (e: ResearchEntry) => `${e.reportDate ?? ""}|${String(e.score ?? 0).padStart(3, "0")}`;

/** Rows to companies. A company listed twice (a master file, or several days) keeps the newest research and every signal. */
export function groupResearchRows(rows: string[][], m: ResearchMap): { companies: ResearchCompany[]; skipped: SkippedRow[] } {
  const byDomain = new Map<string, ResearchCompany>();
  const skipped: SkippedRow[] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const name = val(r, m.company);
    if (!name) return;
    const domain = researchDomain(r, m);
    if (!domain) {
      skipped.push({ row: rowNo, reason: "No website in the sheet. Add it to bring this company in.", preview: name, company: name, needsWebsite: true });
      return;
    }
    const research = researchOf(r, m);
    const route = research.contactRoute;
    const people: SheetPerson[] = parseDecisionMakers(val(r, m.decisionMakers), val(r, m.roles)).map((p) => ({ ...p, email: emailFor(p, route), phone: null, linkedin: null, row: rowNo }));
    const place = placeOf(research.hq);
    const c: ResearchCompany = byDomain.get(domain) ?? { domain, name, industry: null, employees: null, city: place.city, state: place.state, country: "United States", notes: [], people: [], rows: [], research, signals: [] };
    c.rows.push(rowNo);
    c.industry ??= val(r, m.industry);
    c.employees ??= researchEmployees(val(r, m.employees));
    if (rank(research) > rank(c.research)) c.research = research;
    if (research.signal && !c.signals.some((s) => s.title === research.signal!.title)) c.signals.push(research.signal);
    for (const p of people) if (!c.people.some((x) => `${x.firstName} ${x.lastName}`.toLowerCase() === `${p.firstName} ${p.lastName}`.toLowerCase())) c.people.push(p);
    byDomain.set(domain, c);
  });
  return { companies: [...byDomain.values()], skipped };
}

export const signalKey = (domain: string, s: ResearchSignal) => createHash("sha1").update(`${domain}|${s.date}|${s.title.toLowerCase()}`).digest("hex").slice(0, 20);

// ---------- Buckets ----------

export type BucketRef = { id: string; slug: string; name: string; keywords: string[] };

/** Which bucket a sheet belongs to, from its "agent" column or file name. The longest keyword wins. */
export function bucketFor(fileName: string, agent: string | null, buckets: BucketRef[]): BucketRef | null {
  const text = ` ${`${agent ?? ""} ${fileName}`.toLowerCase().replace(/[_\-.]+/g, " ").replace(/&/g, " and ").replace(/\s+/g, " ")} `;
  let best: { b: BucketRef; len: number } | null = null;
  for (const b of buckets)
    for (const k of [b.name, ...b.keywords]) {
      const kw = k.toLowerCase().replace(/&/g, " and ").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
      if (kw && text.includes(kw) && (!best || kw.length > best.len)) best = { b, len: kw.length };
    }
  return best?.b ?? null;
}

// ---------- Tier from research ----------

const TIER_RANK: Record<Tier, number> = { act_now: 3, good_fit: 2, watch: 1, not_fit: 0 };
export const higherTier = (a: Tier, b: Tier | null): Tier => (b && TIER_RANK[b] > TIER_RANK[a] ? b : a);

/**
 * The researcher's tier, read as ours: A with a signal in the last 180 days is act now, A older or B is
 * a good fit, C is watch. The app never ranks researched accounts below what the research says.
 */
export function researchTier(e: ResearchEntry, now = new Date()): Tier | null {
  if (!e.tier) return null;
  const age = e.signal ? (now.getTime() - new Date(e.signal.date).getTime()) / 86400_000 : Infinity;
  if (e.tier === "A") return age <= 180 ? "act_now" : "good_fit";
  if (e.tier === "B") return "good_fit";
  return "watch";
}

/** The strongest research across an account's buckets. */
export function bestResearch(research: unknown, now = new Date()): { entry: ResearchEntry; tier: Tier | null } | null {
  if (!research || typeof research !== "object") return null;
  const entries = Object.values(research as Record<string, ResearchEntry>).filter((e) => e && typeof e === "object");
  let best: { entry: ResearchEntry; tier: Tier | null } | null = null;
  for (const entry of entries) {
    const tier = researchTier(entry, now);
    if (!best || TIER_RANK[tier ?? "not_fit"] > TIER_RANK[best.tier ?? "not_fit"] || (tier === best.tier && (entry.score ?? 0) > (best.entry.score ?? 0))) best = { entry, tier };
  }
  return best;
}
