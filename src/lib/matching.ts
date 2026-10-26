// Matching an account to an offering. Pure and unit tested.
//
// Fit (0 to 100): does the company look like the offering's buyer? Industry, size, revenue, region,
//   and whether we have a buyer-title contact. Excluded industries or domains disqualify.
// Signals (0 to 100): is something happening now that suggests a buying window? Each offering has
//   signal rules (hiring, tech, growth, funding, leadership, news); matching signals earn the rule's
//   points, discounted by age (half-life 45 days; tech stack and growth don't decay).
// Total: weighted blend (default 55% fit, 45% signals). A poor fit can't be rescued by signals.

export const SIGNAL_TYPES = ["intent", "leadership", "funding", "news", "risk", "hiring", "growth", "workforce", "tech"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_LABEL: Record<SignalType, string> = {
  intent: "Researching",
  leadership: "Leadership change",
  funding: "Funding",
  news: "Company event",
  risk: "Risk event",
  hiring: "Hiring",
  growth: "Headcount growth",
  workforce: "Team makeup",
  tech: "Tech stack",
};

/**
 * The three kinds of reasons a company is buying now, strongest first. A company only becomes an
 * "act now" lead with at least one research or trigger signal; pain alone makes it worth watching.
 */
export type SignalKind = "research" | "trigger" | "pain";
export const SIGNAL_KIND: Record<SignalType, SignalKind> = {
  intent: "research",
  leadership: "trigger",
  funding: "trigger",
  news: "trigger",
  risk: "trigger",
  hiring: "pain",
  growth: "pain",
  workforce: "pain",
  tech: "pain",
};
export const KIND_LABEL: Record<SignalKind, string> = { research: "Active research", trigger: "Trigger event", pain: "Visible pain" };

/** Plain-language explanation of each signal type: what it is, and how to read it. Shown in the app. */
export const SIGNAL_EXPLAINER: Record<SignalType, { what: string; read: string }> = {
  intent: {
    what: "People at this company are reading about this topic across business sites, well above their normal level. Source: Vibe Prospecting research-intent data.",
    read: "Scores run 0 to 100. 60 or more means active research and earns half the rule's points; 80 or more is a strong spike and earns them all. It's the closest thing to a company telling us what it's trying to buy.",
  },
  leadership: {
    what: "A new executive joined, or a key leader is leaving.",
    read: "New leaders review what's working in their first 90 days and have room to start new work. A retirement or departure puts knowledge and systems at risk.",
  },
  funding: {
    what: "New investment, a funding round, or a private equity deal.",
    read: "Fresh money comes with a plan to grow or improve margins, and a board asking how. Budgets are open.",
  },
  news: {
    what: "A company event: acquisition or merger, new office, new product, new partnership, or cost cutting.",
    read: "Mergers mean systems and teams to combine. Expansion means processes that have to scale. Cost cutting means a mandate to do more with less.",
  },
  risk: {
    what: "A security breach, outage, or lawsuit was reported.",
    read: "Risk events force leadership to ask how safe their systems and AI use really are. Short windows; act within weeks.",
  },
  hiring: {
    what: "Open job posts, or a hiring push in one department.",
    read: "Hiring people for repetitive work, or to keep old systems running, shows a problem a workflow or a rebuild could solve.",
  },
  growth: {
    what: "How fast headcount grew over the last six months.",
    read: "Fast growth strains processes built for a smaller company. Ten percent or more in six months is meaningful.",
  },
  workforce: {
    what: "How the company's people are split across departments, and which departments are growing.",
    read: "A large or growing operations team usually means manual work at scale, which is where automation pays back fastest.",
  },
  tech: {
    what: "Software the company runs, detected from its websites, job posts and other public sources.",
    read: "Old systems point to modernization. AI tools already in use, without governance, point to a readiness review.",
  },
};

export type SignalRule = {
  id: string;
  type: SignalType;
  label: string;
  /** Keywords; a signal matches if any keyword appears in its title or detail. Empty = any of this type. */
  match: string[];
  /** Points this rule can add (0 to 100). */
  weight: number;
  /** For numeric signals: the minimum value that counts, e.g. 0.1 for 10% growth, 0.6 for an intent score of 60. */
  min?: number;
  /** Why this signal points to this offer, in plain words. Shown wherever the signal surfaces. */
  why?: string;
};

export type MatchAccount = {
  domain: string;
  industry: string | null;
  employees: number | null;
  revenueCents: number | null;
  country: string | null;
  technologies: string[];
  /** Why this company is ruled out for every offer, if it is. */
  excluded?: string | null;
};
export type MatchSignal = { id: string; type: string; title: string; detail?: string | null; value?: number | null; occurredAt: Date };
export type MatchContact = { title: string | null };
export type MatchOffering = {
  id: string;
  industries: string[];
  excludedCategories: string[];
  excludedDomains: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
  revenueMinCents: number | null;
  revenueMaxCents: number | null;
  regions: string[];
  targetTitles: string[];
  signalRules: SignalRule[];
};

export type FitPart = { key: "industry" | "size" | "revenue" | "region" | "buyer"; label: string; points: number; max: number; note: string };
export type RuleHit = { ruleId: string; label: string; type: SignalType; kind: SignalKind; points: number; max: number; signalIds: string[]; matched: string[]; why?: string };
export type Tier = "act_now" | "good_fit" | "watch" | "not_fit";
export type MatchResult = { fit: number; signal: number; total: number; tier: Tier; fitParts: FitPart[]; hits: RuleHit[]; disqualified: string | null };

export const TIER_LABEL: Record<Tier, string> = { act_now: "Act now", good_fit: "Good fit, no trigger yet", watch: "Watch", not_fit: "Not a fit" };

export const DEFAULT_MATCH_WEIGHTS = { fit: 0.55, signal: 0.45 };
export const HALF_LIFE_DAYS = 45;
const MAX_AGE_DAYS = 365;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 /]+/g, " ").replace(/\s+/g, " ").trim();

/** Loose industry match: containment either way, or a shared meaningful word. */
export function industryMatches(target: string, actual: string | null | undefined): boolean {
  if (!actual) return false;
  const a = norm(target);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const stop = new Set(["services", "and", "the", "of", "group", "industry"]);
  const words = (s: string) => s.split(" ").filter((w) => w.length > 3 && !stop.has(w));
  const bw = new Set(words(b));
  return words(a).some((w) => bw.has(w));
}

const keywordHit = (text: string, kw: string) => {
  const k = norm(kw);
  if (!k) return false;
  // Short keywords (AI, VB6) must match as whole words.
  return k.length <= 3 ? new RegExp(`(^| )${k.replace(/[/]/g, "\\/")}( |$)`).test(text) : text.includes(k);
};

const titleFn = (s: string) => norm(s).replace(/\b(chief|officer|vice|president|vp|head|of|director|senior|svp|evp|the|and)\b/g, " ").replace(/\s+/g, " ").trim();
const ABBR: Record<string, string> = { ceo: "executive", coo: "operating operations", cio: "information technology", cto: "technology", cfo: "financial finance", ciso: "security", cdo: "data" };
const expandTitle = (s: string) => norm(s).split(" ").map((w) => ABBR[w] ?? w).join(" ");

/** Does a contact's title match any target title (by function words)? */
export function titleMatches(title: string | null, targets: string[]): boolean {
  if (!title) return false;
  const t = new Set(titleFn(expandTitle(title)).split(" ").filter((w) => w.length > 2));
  return targets.some((target) => titleFn(expandTitle(target)).split(" ").filter((w) => w.length > 2).some((w) => t.has(w)));
}

export function fitScore(a: MatchAccount, o: MatchOffering, contacts: MatchContact[]): { score: number; parts: FitPart[]; disqualified: string | null } {
  if (o.excludedDomains.map((d) => d.toLowerCase()).includes(a.domain.toLowerCase())) return { score: 0, parts: [], disqualified: `${a.domain} is on the excluded list.` };
  const excluded = o.excludedCategories.find((c) => industryMatches(c, a.industry));
  if (excluded) return { score: 0, parts: [], disqualified: `${a.industry} is an excluded category.` };

  const parts: FitPart[] = [];
  // Industry, 30
  if (o.industries.length === 0) parts.push({ key: "industry", label: "Industry", points: 30, max: 30, note: "No industry limit on this offering." });
  else if (!a.industry) parts.push({ key: "industry", label: "Industry", points: 15, max: 30, note: "Industry unknown." });
  else {
    const hit = o.industries.find((i) => industryMatches(i, a.industry));
    parts.push({ key: "industry", label: "Industry", points: hit ? 30 : 0, max: 30, note: hit ? `${a.industry} matches ${hit}.` : `${a.industry} isn't a target industry.` });
  }
  // Company size, 25
  const { companySizeMin: lo, companySizeMax: hi } = o;
  if (lo == null && hi == null) parts.push({ key: "size", label: "Company size", points: 25, max: 25, note: "No size limit." });
  else if (a.employees == null) parts.push({ key: "size", label: "Company size", points: 12, max: 25, note: "Headcount unknown." });
  else {
    const inRange = (lo == null || a.employees >= lo) && (hi == null || a.employees <= hi);
    const near = !inRange && ((lo != null && a.employees >= lo * 0.7 && a.employees < lo) || (hi != null && a.employees <= hi * 1.3 && a.employees > hi));
    parts.push({ key: "size", label: "Company size", points: inRange ? 25 : near ? 10 : 0, max: 25, note: `${a.employees.toLocaleString("en-US")} employees${inRange ? ", in range" : near ? ", just outside range" : ", out of range"}.` });
  }
  // Revenue, 20
  const rlo = o.revenueMinCents;
  const rhi = o.revenueMaxCents;
  if (rlo == null && rhi == null) parts.push({ key: "revenue", label: "Revenue", points: 20, max: 20, note: "No revenue limit." });
  else if (a.revenueCents == null) parts.push({ key: "revenue", label: "Revenue", points: 10, max: 20, note: "Revenue unknown." });
  else {
    const ok = (rlo == null || a.revenueCents >= rlo) && (rhi == null || a.revenueCents <= rhi);
    const m = Math.round(a.revenueCents / 100_000_000);
    parts.push({ key: "revenue", label: "Revenue", points: ok ? 20 : 0, max: 20, note: `About $${m}M${ok ? ", in band" : ", out of band"}.` });
  }
  // Region, 10
  if (o.regions.length === 0) parts.push({ key: "region", label: "Region", points: 10, max: 10, note: "No region limit." });
  else if (!a.country) parts.push({ key: "region", label: "Region", points: 5, max: 10, note: "Location unknown." });
  else {
    const ok = o.regions.some((r) => norm(r) === norm(a.country!) || (/united states|usa|^us$/.test(norm(r)) && /united states|usa|^us$/.test(norm(a.country!))));
    parts.push({ key: "region", label: "Region", points: ok ? 10 : 0, max: 10, note: ok ? `Based in ${a.country}.` : `${a.country} is outside the target regions.` });
  }
  // Buyer on file, 15
  const buyer = contacts.find((c) => titleMatches(c.title, o.targetTitles));
  parts.push({ key: "buyer", label: "Buyer contact", points: buyer ? 15 : 0, max: 15, note: buyer ? `${buyer.title} on file.` : contacts.length ? "No contact with a target title yet." : "No contacts pulled yet." });

  let score = Math.round(parts.reduce((s, p) => s + p.points, 0));
  // A known wrong industry or a size well outside the range caps fit: right size alone isn't a buyer.
  const hardMiss = parts.some((p) => (p.key === "industry" || p.key === "size") && p.points === 0);
  if (hardMiss) score = Math.min(score, 45);
  return { score, parts, disqualified: null };
}

export function recency(type: string, occurredAt: Date, now: Date): number {
  // Current-state signals (stack, growth, team makeup) don't fade; events and research do.
  if (type === "tech" || type === "growth" || type === "workforce") return 1;
  const age = (now.getTime() - occurredAt.getTime()) / 86400_000;
  if (age > MAX_AGE_DAYS) return 0;
  return Math.pow(0.5, Math.max(0, age) / HALF_LIFE_DAYS);
}

/** How hard they're researching: a research score of 60 counts half, 80 or more (a spike) counts fully. Other types count fully. */
export function intensity(type: string, value: number | null | undefined): number {
  if (type !== "intent" || value == null) return 1;
  return Math.max(0, Math.min(1, (value - 0.4) / 0.4));
}

export function signalScore(a: MatchAccount, signals: MatchSignal[], rules: SignalRule[], now = new Date()): { score: number; hits: RuleHit[] } {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const strengths: { r: number; id: string | null; matched: string }[] = [];
    if (rule.type === "tech") {
      for (const t of a.technologies) {
        const text = norm(t);
        if (rule.match.length === 0 || rule.match.some((k) => keywordHit(text, k))) strengths.push({ r: 1, id: null, matched: t });
      }
    }
    for (const s of signals) {
      if (s.type !== rule.type) continue;
      if (rule.min != null && (s.value == null || s.value < rule.min)) continue;
      const text = norm(`${s.title} ${s.detail ?? ""}`);
      if (rule.match.length && !rule.match.some((k) => keywordHit(text, k))) continue;
      const r = recency(s.type, s.occurredAt, now) * intensity(s.type, s.value);
      if (r > 0) strengths.push({ r, id: s.id, matched: s.title });
    }
    if (strengths.length === 0) continue;
    strengths.sort((x, y) => y.r - x.r);
    // The strongest signal counts fully; more of the same add a little (30%, then 15%).
    // Not for research: related topics ("AI strategy", "AI readiness") are one surge under several labels.
    const factor = rule.type === "intent" ? strengths[0]!.r : Math.min(1, strengths[0]!.r + 0.3 * (strengths[1]?.r ?? 0) + 0.15 * (strengths[2]?.r ?? 0));
    hits.push({ ruleId: rule.id, label: rule.label, type: rule.type, kind: SIGNAL_KIND[rule.type], why: rule.why, points: Math.round(rule.weight * factor * 10) / 10, max: rule.weight, signalIds: strengths.map((x) => x.id).filter((x): x is string => !!x), matched: strengths.slice(0, 3).map((x) => x.matched) });
  }
  hits.sort((x, y) => y.points - x.points);
  return { score: Math.round(Math.min(100, hits.reduce((s, h) => s + h.points, 0))), hits };
}

/** Act now needs a real reason: at least one research or trigger signal, not just visible pain. */
export function tierFor(fit: number, signal: number, total: number, disqualified: string | null, hasWhyNow = true): Tier {
  if (disqualified || fit < 40) return "not_fit";
  if (fit >= 60 && signal >= 35 && total >= 60 && hasWhyNow) return "act_now";
  if (fit >= 60) return "good_fit";
  return "watch";
}

export function matchAccount(a: MatchAccount, signals: MatchSignal[], contacts: MatchContact[], o: MatchOffering, weights = DEFAULT_MATCH_WEIGHTS, now = new Date()): MatchResult {
  // Company-level exclusions (software vendors, units of large public companies) apply to every offer.
  if (a.excluded) return { fit: 0, signal: 0, total: 0, tier: "not_fit", fitParts: [], hits: [], disqualified: a.excluded };
  const f = fitScore(a, o, contacts);
  if (f.disqualified) return { fit: 0, signal: 0, total: 0, tier: "not_fit", fitParts: f.parts, hits: [], disqualified: f.disqualified };
  const s = signalScore(a, signals, o.signalRules, now);
  const wsum = weights.fit + weights.signal || 1;
  let total = Math.round((f.score * weights.fit + s.score * weights.signal) / wsum);
  // Signals can't lift a poor fit above its fit score.
  if (f.score < 50) total = Math.min(total, f.score);
  const hasWhyNow = s.hits.some((h) => h.kind !== "pain");
  return { fit: f.score, signal: s.score, total, tier: tierFor(f.score, s.score, total, null, hasWhyNow), fitParts: f.parts, hits: s.hits, disqualified: null };
}

const TIER_RANK: Record<Tier, number> = { act_now: 3, good_fit: 2, watch: 1, not_fit: 0 };

/** The best offer for an account: highest total, then better tier, then better fit. */
export function bestMatch<T extends { total: number; fit: number; tier: Tier }>(matches: T[]): T | null {
  return [...matches].sort((x, y) => y.total - x.total || TIER_RANK[y.tier] - TIER_RANK[x.tier] || y.fit - x.fit)[0] ?? null;
}
