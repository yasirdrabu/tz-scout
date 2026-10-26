// Offer readiness: is this offer strong enough, and is there enough pull in the market, to put reps
// and money behind it? 100 points in two halves. Market pull is measured from our own accounts;
// offer strength is judged (by Claude, or by rules until it's connected) and can be set by hand.
// Pure and tested.

export type ReadinessGroup = "offer" | "market";
export type ReadinessSource = "data" | "ai" | "rules" | "override";
export type ReadinessFactorDef = { key: string; label: string; group: ReadinessGroup; weight: number; help: string; measured: boolean };

export const READINESS_FACTORS: ReadinessFactorDef[] = [
  { key: "outcome", label: "Clear, measurable outcome", group: "offer", weight: 10, help: "Can the buyer say in one line what they'll have and how they'll know it worked?", measured: false },
  { key: "proof", label: "Proof we can show", group: "offer", weight: 12, help: "Case studies and results that match this offer.", measured: true },
  { key: "speed", label: "Time to first result", group: "offer", weight: 8, help: "How soon the buyer sees something real.", measured: false },
  { key: "risk", label: "Risk taken off the buyer", group: "offer", weight: 8, help: "A guarantee, a fixed price, or an easy way out.", measured: false },
  { key: "firstStep", label: "Easy first step", group: "offer", weight: 8, help: "A price and size a buyer can say yes to without a committee.", measured: true },
  { key: "deliverable", label: "Something tangible to hold", group: "offer", weight: 6, help: "A map, a working build, a report: not just hours.", measured: false },
  { key: "different", label: "Different from the alternatives", group: "offer", weight: 8, help: "Why this, and why us, versus doing nothing or hiring the usual firm.", measured: false },
  { key: "demand", label: "Companies showing demand", group: "market", weight: 14, help: "Accounts in our market where this is the best-fit offer.", measured: true },
  { key: "urgency", label: "Reasons to act now", group: "market", weight: 10, help: "Of those, how many have research or a trigger event right now.", measured: true },
  { key: "reachable", label: "Buyers we can reach", group: "market", weight: 8, help: "Share of those accounts where we've found a decision-maker.", measured: true },
  { key: "wins", label: "Wins like it", group: "market", weight: 8, help: "Closed deals for this offer or something close to it.", measured: true },
];

export type ReadinessFactor = { key: string; label: string; group: ReadinessGroup; value: number; base: number; baseSource: ReadinessSource; max: number; points: number; reason: string; source: ReadinessSource; override?: { value: number; note: string | null } | null };
export type Readiness = { score: number; band: ReadinessBand; offerScore: number; marketScore: number; factors: ReadinessFactor[]; fixes: string[]; at: string };
export type ReadinessBand = "ready" | "fix_first" | "rework";

export const BAND_LABEL: Record<ReadinessBand, string> = { ready: "Ready to push", fix_first: "Fix first", rework: "Rework the offer" };
export const BAND_HELP: Record<ReadinessBand, string> = {
  ready: "Strong enough to put reps and budget behind it.",
  fix_first: "Worth selling, but fix the weakest parts before scaling.",
  rework: "Rework the offer before spending on it.",
};

export const bandFor = (score: number): ReadinessBand => (score >= 75 ? "ready" : score >= 60 ? "fix_first" : "rework");
const clamp10 = (n: number) => Math.max(0, Math.min(10, Math.round(n)));

/** Market and proof facts we can measure for one offer. */
export type ReadinessFacts = {
  caseStudies: number;
  proofPoints: number;
  priceMinCents: number | null;
  matchedAccounts: number; // accounts where this is the best offer and the tier is act now or good fit
  actNow: number;
  withBuyer: number;
  wins: number | null; // null = no win history read yet
};

/** Measured factors, 0 to 10 each, with the reason in plain words. */
export function measuredFactors(f: ReadinessFacts): Record<string, { value: number; reason: string }> {
  // A starting price of $0 means nobody set one, not that it's free.
  const price = f.priceMinCents ? f.priceMinCents / 100 : null;
  const proofValue = clamp10(f.caseStudies * 3 + f.proofPoints * 2);
  return {
    proof: { value: proofValue, reason: `${f.caseStudies} linked case ${f.caseStudies === 1 ? "study" : "studies"} and ${f.proofPoints} proof ${f.proofPoints === 1 ? "point" : "points"}.${f.caseStudies === 0 ? " Link case studies to this offer to raise it." : ""}` },
    firstStep: {
      value: price == null ? 5 : clamp10(price <= 10_000 ? 10 : price <= 25_000 ? 8 : price <= 50_000 ? 6 : price <= 100_000 ? 4 : 2),
      reason: price == null ? "No starting price set. Set one on the offer." : `Starts at $${Math.round(price).toLocaleString("en-US")}.${price > 50_000 ? " A smaller first step would get more yeses." : ""}`,
    },
    demand: { value: clamp10(f.matchedAccounts / 2), reason: `${f.matchedAccounts} ${f.matchedAccounts === 1 ? "account has" : "accounts have"} this as the best-fit offer.${f.matchedAccounts < 10 ? " Pull more accounts for this offer to know the market." : ""}` },
    urgency: {
      value: f.matchedAccounts ? clamp10((f.actNow / f.matchedAccounts) * 12) : 0,
      reason: f.matchedAccounts ? `${f.actNow} of ${f.matchedAccounts} are in a buying window right now.` : "No matched accounts yet.",
    },
    reachable: {
      value: f.matchedAccounts ? clamp10((f.withBuyer / f.matchedAccounts) * 10) : 0,
      reason: f.matchedAccounts ? `Decision-maker found at ${f.withBuyer} of ${f.matchedAccounts}.` : "No matched accounts yet.",
    },
    wins: f.wins == null ? { value: 5, reason: "Win history not read yet (half credit). Run a win analysis." } : { value: clamp10(f.wins * 2.5), reason: `${f.wins} closed ${f.wins === 1 ? "deal" : "deals"} for this offer or close to it.` },
  };
}

/** Combine judged and measured values (each 0 to 10) into the score. Overrides win. */
export function combineReadiness(
  judged: Record<string, { value: number; reason: string; source: ReadinessSource }>,
  measured: Record<string, { value: number; reason: string }>,
  overrides: Record<string, { value: number; note: string | null }> = {},
  fixes: string[] = [],
  at = new Date(),
): Readiness {
  const factors: ReadinessFactor[] = READINESS_FACTORS.map((d) => {
    const base = d.measured ? { ...(measured[d.key] ?? { value: 0, reason: "Not measured." }), source: "data" as ReadinessSource } : (judged[d.key] ?? { value: 5, reason: "Not judged yet.", source: "rules" as ReadinessSource });
    const o = overrides[d.key];
    const value = clamp10(o ? o.value : base.value);
    return { key: d.key, label: d.label, group: d.group, value, base: clamp10(base.value), baseSource: base.source, max: d.weight, points: Math.round((value / 10) * d.weight * 10) / 10, reason: base.reason, source: o ? "override" : base.source, override: o ?? null };
  });
  const sum = (g?: ReadinessGroup) => Math.round(factors.filter((f) => !g || f.group === g).reduce((s, f) => s + f.points, 0));
  const score = sum();
  // Fixes: the judge's suggestions first, then the biggest measured gaps.
  const gaps = factors.filter((f) => f.source === "data" && f.value <= 5).sort((x, y) => y.max * (10 - y.value) - x.max * (10 - x.value)).map((f) => `${f.label}: ${f.reason}`);
  return { score, band: bandFor(score), offerScore: sum("offer"), marketScore: sum("market"), factors, fixes: [...fixes, ...gaps].slice(0, 5), at: at.toISOString() };
}
