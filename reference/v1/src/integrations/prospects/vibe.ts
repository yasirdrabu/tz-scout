// Vibe Prospecting (Explorium) data to our accounts and signals. Pure mapping, unit tested.
// Today Vibe pulls run through the Vibe connector in Claude and are imported with
// scripts/import-vibe.mts; the same mapping will serve an in-app Vibe connection later.

import type { SignalType } from "@/lib/matching";

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
  contacts?: { id: string; firstName: string; lastName?: string | null; title?: string | null; level?: string | null; email?: string | null; linkedin?: string | null }[];
};

export type SignalDraft = { type: SignalType; title: string; detail?: string | null; url?: string | null; value?: number | null; occurredAt: Date; externalId: string };

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** "501-1000" -> 708 (geometric middle), "10001+" -> 10001. */
export function rangeMid(range: string | null | undefined, unit = 1): number | null {
  if (!range) return null;
  const m = range.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)([KMBT])?(?:-(\d+(?:\.\d+)?)([KMBT])?)?\+?$/i);
  if (!m) return null;
  const mult = (s?: string) => ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 })[(s ?? "").toUpperCase() as "K"] ?? 1;
  const lo = Number(m[1]) * mult(m[2] ?? m[4]);
  const hi = m[3] ? Number(m[3]) * mult(m[4]) : lo;
  return Math.round(Math.sqrt(Math.max(lo, 1) * Math.max(hi, 1)) * unit);
}

/** "machine learning & artificial intelligence: ai risk management" -> "AI risk management" */
export function topicLabel(topic: string): string {
  const t = topic.includes(":") ? topic.split(":").slice(1).join(":").trim() : topic.trim();
  return t.replace(/\bai\b/gi, "AI").replace(/\bit\b/g, "IT").replace(/\bgenai\b/gi, "generative AI").replace(/\s*\([a-z]{2,6}\)$/, "").replace(/^\w/, (c) => c.toUpperCase());
}

// NAICS prefix to the industry words our offers use. Longest prefix wins.
const NAICS_INDUSTRY: [string, string][] = [
  ["5311", "Commercial real estate"], ["5312", "Real estate brokerage"], ["5313", "Property management"], ["531", "Real estate"],
  ["524", "Insurance"], ["52", "Financial services"],
  ["621", "Healthcare services: clinics and outpatient"], ["622", "Healthcare services: hospitals"], ["623", "Healthcare services: nursing and residential care"], ["62", "Healthcare services"],
  ["493", "Logistics: warehousing"], ["484", "Logistics: trucking"], ["488", "Logistics: freight"], ["48", "Logistics and transportation"], ["49", "Logistics and transportation"],
  ["31", "Manufacturing"], ["32", "Manufacturing"], ["33", "Manufacturing"], ["42", "Wholesale distribution"],
  ["5411", "Legal services"], ["54", "Professional services"], ["23", "Construction"], ["92", "Government services"],
];

/** Our industry label from a NAICS code, falling back to Vibe's description. */
export function industryFor(naics: string | null | undefined, description?: string | null): string | null {
  const code = (naics ?? "").trim();
  const hit = NAICS_INDUSTRY.filter(([p]) => code.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : description ?? null;
}

const EXEC =/\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|president|founder|vp|vice president|head of|general counsel)\b/i;

/** One Vibe event to one of our signals, or null if it isn't a buying signal. */
export function mapEvent(e: NonNullable<VibeCompany["events"]>[number]): { type: SignalType; title: string } | null {
  const t = e.type.toLowerCase();
  const detail = [e.title, e.detail].filter(Boolean).join(" ");
  const dept = (s: string) => s.replace(/_department$/, "").replace(/^(hiring_in|increase_in|decrease_in)_/, "").replace(/_/g, " ");
  if (t.startsWith("hiring_in_")) return { type: "hiring", title: `Hiring in ${dept(t)}${e.title ? `: ${e.title}` : ""}` };
  if (t === "increase_in_operations_department") return { type: "workforce", title: "Operations team growing" };
  if (t === "increase_in_all_departments") return { type: "workforce", title: "Hiring across every department" };
  if (t.startsWith("increase_in_")) return { type: "workforce", title: `${titleCase(dept(t))} team growing` };
  if (t.startsWith("decrease_in_")) return { type: "news", title: `Cost cutting: ${dept(t)} team shrinking` };
  if (t === "employee_joined_company") return EXEC.test(detail) ? { type: "leadership", title: `New leader joined${e.title ? `: ${e.title}` : ""}` } : null;
  // new_investment is the company spending (a new building, a project), not raising money.
  if (t === "new_investment") return { type: "news", title: e.title ? `Investing: ${e.title}` : "Announced a new investment" };
  if (t === "new_funding_round" || t === "ipo_announcement") return { type: "funding", title: e.title || titleCase(t.replace(/_/g, " ")) };
  if (t === "merger_and_acquisitions") return { type: "news", title: e.title ? `Acquisition or merger: ${e.title}` : "Acquisition or merger" };
  if (t === "new_office") return { type: "news", title: e.title ? `Expansion, new office: ${e.title}` : "Expansion, opened a new office" };
  if (t === "closing_office") return { type: "news", title: "Cost cutting, closing an office" };
  if (t === "cost_cutting") return { type: "news", title: e.title ? `Cost cutting: ${e.title}` : "Cost cutting" };
  if (t === "outages_and_security_breaches") return { type: "risk", title: e.title ? `Security breach or outage: ${e.title}` : "Security breach or outage reported" };
  if (t === "lawsuits_and_legal_issues") return { type: "risk", title: e.title ? `Lawsuit: ${e.title}` : "Lawsuit or legal issue reported" };
  if (t === "new_product" || t === "new_partnership" || t === "company_award") return { type: "news", title: e.title || titleCase(t.replace(/_/g, " ")) };
  return null;
}

/** Every buying signal Vibe gives us for a company. */
export function vibeSignals(c: VibeCompany, now: Date): SignalDraft[] {
  const out: SignalDraft[] = [];
  for (const i of c.intent ?? []) {
    if (i.score < 50) continue;
    out.push({ type: "intent", title: `Researching: ${topicLabel(i.topic)}`, detail: `Research score ${i.score} of 100 this week. 60 or more is active research; 80 or more is a strong spike.`, value: i.score / 100, occurredAt: now, externalId: `intent:${i.topic}` });
  }
  const ops = c.workforce?.share?.operations;
  if (ops != null && ops >= 0.1) out.push({ type: "workforce", title: `Operations is ${Math.round(ops * 100)}% of staff`, detail: "Share of employees in operations roles, from public profiles.", value: ops, occurredAt: now, externalId: "workforce:ops-share" });
  for (const [dept, n] of Object.entries(c.workforce?.change ?? {})) {
    if (n >= 3) out.push({ type: "workforce", title: `${titleCase(dept)} team growing: ${n} more people last quarter`, value: n, occurredAt: now, externalId: `workforce:change:${dept}` });
  }
  for (const [i, e] of (c.events ?? []).entries()) {
    const m = mapEvent(e);
    const at = new Date(e.date);
    if (!m || Number.isNaN(at.getTime())) continue;
    out.push({ type: m.type, title: m.title, detail: e.detail ?? null, url: e.url ?? null, occurredAt: at, externalId: `event:${e.id ?? `${e.type}:${e.date}:${i}`}` });
  }
  return out;
}

const VENDOR_NAICS = ["5112", "5132", "5182", "54151"];
const VENDOR_CATEGORIES = ["software development", "it services and it consulting", "technology, information and internet", "computer software", "information technology & services"];
const VENDOR_TEXT = /\b(uses? ai to|ai[- ]powered|ai infrastructure|ai teammate|ai-driven (workforce|platform|solutions)|software platform|saas|our platform|centralized platform|healthcare intelligence platform|execution software|helps (hospitals|health systems|providers|payers|landlords|carriers|insurers)|helping (hospitals|health systems|providers)|ai care)\b/i;
const PARENT_TEXT = /\b(?:is part of|a subsidiary of|a division of|an? ([A-Z][\w&]*(?: [A-Z][\w&]*){0,3}) company\b)\s*([A-Z][\w&]*(?: [A-Z][\w&]*){0,3})?/;

/** Why a company should be ruled out for every offer, or null. */
export function exclusionFor(c: Pick<VibeCompany, "naics" | "linkedinCategory" | "description" | "name">): string | null {
  const naics = (c.naics ?? "").trim();
  const cat = (c.linkedinCategory ?? "").toLowerCase();
  const desc = c.description ?? "";
  if (VENDOR_NAICS.some((p) => naics.startsWith(p)) || VENDOR_CATEGORIES.includes(cat) || VENDOR_TEXT.test(desc)) {
    return "Sells software or AI to this market. A competitor or partner, not a buyer.";
  }
  const p = desc.match(PARENT_TEXT);
  if (p) {
    const parent = (p[1] ?? p[2] ?? "").trim();
    if (parent && !new RegExp(`^${c.name.split(" ")[0]}`, "i").test(parent)) return `Part of ${parent}. Buying decisions likely sit with the parent company.`;
  }
  return null;
}
