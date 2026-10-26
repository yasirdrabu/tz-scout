import type { AccountStatus } from "@prisma/client";
import type { Tone } from "@/components/ui";
import { SIGNAL_LABEL, TIER_LABEL, type SignalType, type Tier } from "@/lib/matching";
import type { MatchReasons } from "@/server/buyers";

export const TIERS: Tier[] = ["act_now", "good_fit", "watch", "not_fit"];
export const TIER_TONE: Record<Tier, Tone> = { act_now: "accent", good_fit: "good", watch: "near", not_fit: "muted" };
/** Short tab labels; badges use the full TIER_LABEL. */
export const TIER_TAB_LABEL: Record<Tier, string> = { act_now: TIER_LABEL.act_now, good_fit: "Good fit", watch: TIER_LABEL.watch, not_fit: TIER_LABEL.not_fit };

export const isTier = (t: unknown): t is Tier => typeof t === "string" && (TIERS as string[]).includes(t);
export const tierOf = (t: string | null | undefined): Tier => (isTier(t) ? t : "not_fit");

export const ACCOUNT_STATUSES: AccountStatus[] = ["NEW", "WORKING", "QUALIFIED", "DISQUALIFIED", "CUSTOMER"];
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { NEW: "New", WORKING: "Working", QUALIFIED: "Qualified", DISQUALIFIED: "Disqualified", CUSTOMER: "Customer" };
export const ACCOUNT_STATUS_TONE: Record<AccountStatus, Tone> = { NEW: "neutral", WORKING: "accent", QUALIFIED: "good", DISQUALIFIED: "muted", CUSTOMER: "good" };
/** Button labels for moving an account to a status. */
export const STATUS_ACTION_LABEL: Record<AccountStatus, string> = { NEW: "Back to new", WORKING: "Working", QUALIFIED: "Qualified", DISQUALIFIED: "Disqualify", CUSTOMER: "Mark as customer" };
export const isAccountStatus = (s: unknown): s is AccountStatus => typeof s === "string" && (ACCOUNT_STATUSES as string[]).includes(s);

export const signalLabel = (type: string) => SIGNAL_LABEL[type as SignalType] ?? type;

/** Tech stack and headcount growth are standing facts, so they show no age. */
export const hasAge = (type: string) => type !== "tech" && type !== "growth" && type !== "workforce";

/** Compact age: 3d, 6w, 4mo, 2y. */
export function ageShort(d: Date | string, now = new Date()): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(d).getTime()) / 86400_000));
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/** A signal title without a repeated type prefix or the company's own name ("Hiring: Data engineer" becomes "Data engineer"), cut to fit a chip. */
export function shortTitle(title: string, max = 34, companyName?: string): string {
  let t = title.replace(/^(hiring|uses|news|funding)\s*:\s*/i, "").replace(/^headcount\s+/i, "").trim();
  if (companyName && t.toLowerCase().startsWith(companyName.toLowerCase())) t = t.slice(companyName.length).trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const contactName = (c: { firstName: string; lastName: string | null }) => `${c.firstName} ${c.lastName ?? ""}`.trim();

const SENIORITY: Record<string, string> = { c_suite: "Executive", owner: "Owner", founder: "Founder", partner: "Partner", vp: "Vice president", head: "Head", director: "Director", manager: "Manager", senior: "Senior", entry: "Entry level" };
export const seniorityLabel = (s: string) => SENIORITY[s.toLowerCase()] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const location = (a: { city: string | null; state: string | null; country?: string | null }) => [a.city, a.state].filter(Boolean).join(", ") || (a.country ?? "");

export const sourceLabel = (s: string) => (s === "research" ? "ABM research sheet" : s === "vibe" ? "Vibe Prospecting" : s === "apollo" ? "Apollo" : s === "mock" ? "Sample data" : s === "hubspot" ? "HubSpot" : s === "manual" ? "Added by hand" : s === "import" ? "Imported list" : s);

/** Matches store reasons as JSON; read them defensively. */
export function reasonsOf(json: unknown): MatchReasons {
  const r = (json && typeof json === "object" ? json : {}) as Partial<MatchReasons>;
  return { fit: Array.isArray(r.fit) ? r.fit : [], signals: Array.isArray(r.signals) ? r.signals : [], disqualified: typeof r.disqualified === "string" ? r.disqualified : null };
}

export const score = (n: number | null | undefined) => (n == null ? "" : String(Math.round(n)));
export const points = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
