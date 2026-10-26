import type { Tone } from "@/components/ui";
import { verdict, type ResultCounts, type Verdict, type VerdictStatus, type VerdictTargets } from "@/lib/verdict";
import { money, num, pct } from "@/lib/format";

export const BATCH_STATUSES = ["DRAFT", "APPROVED", "RUNNING", "COMPLETE"] as const;
export type BatchStatusKey = (typeof BATCH_STATUSES)[number];
export const BATCH_STATUS_LABEL: Record<BatchStatusKey, string> = { DRAFT: "Draft", APPROVED: "Approved", RUNNING: "Running", COMPLETE: "Complete" };
export const BATCH_STATUS_TONE: Record<BatchStatusKey, Tone> = { DRAFT: "near", APPROVED: "accent", RUNNING: "accent", COMPLETE: "neutral" };

export const CHANNEL_LABEL: Record<string, string> = { meta: "Meta", linkedin: "LinkedIn" };
export const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

export const KIND_LABEL = { PROBLEM: "Problem", OUTCOME: "Outcome" } as const;
export type KindKey = keyof typeof KIND_LABEL;
export const isKind = (k: unknown): k is KindKey => k === "PROBLEM" || k === "OUTCOME";

export const DECISIONS = ["KEEP", "DROP", "REWRITE", "RETEST"] as const;
export type DecisionKey = (typeof DECISIONS)[number];
export const DECISION_LABEL: Record<DecisionKey | "PENDING", string> = { PENDING: "Undecided", KEEP: "Kept", DROP: "Dropped", REWRITE: "Rewritten", RETEST: "Retest" };
export const DECISION_BUTTON: Record<DecisionKey, string> = { KEEP: "Keep", DROP: "Drop", REWRITE: "Rewrite", RETEST: "Retest" };
export const DECISION_TONE: Record<DecisionKey | "PENDING", Tone> = { PENDING: "muted", KEEP: "accent", DROP: "muted", REWRITE: "neutral", RETEST: "neutral" };

export const VERDICT_LABEL: Record<VerdictStatus, string> = { pass: "Pass", fail: "Fail", not_enough_data: "Not enough data" };
export const VERDICT_TONE: Record<VerdictStatus, Tone> = { pass: "good", fail: "bad", not_enough_data: "muted" };

export const MAX_WORDS = 25;
export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Statements whose results pass the batch targets. */
export function passCount(batch: VerdictTargets & { statements: { result: ResultCounts | null }[] }) {
  return batch.statements.filter((s) => verdict(s.result, batch).status === "pass").length;
}

export function ruleText(t: { targetCtr: number; targetCpcCents: number; minImpressions: number }, currency: string) {
  return `Pass needs a clickthrough rate at or above ${pct(t.targetCtr)} and a cost per click at or below ${money(t.targetCpcCents, currency, { precise: true })}, after at least ${num(t.minImpressions)} impressions.`;
}

/** Plain explanation of a verdict: which target was met or missed. */
export function verdictReason(v: Verdict, t: { targetCtr: number; targetCpcCents: number; minImpressions: number }, impressions: number | null, currency: string) {
  if (v.status === "not_enough_data") {
    if (impressions == null) return "No results yet.";
    return `${num(impressions)} impressions so far. A verdict needs at least ${num(t.minImpressions)}.`;
  }
  const ctrText = `Clickthrough rate ${pct(v.ctr, 2)} ${v.ctrPass ? "meets" : "is below"} the ${pct(t.targetCtr)} target.`;
  const cpcText = v.cpcCents == null ? "No clicks yet, so there is no cost per click." : `Cost per click ${money(v.cpcCents, currency, { precise: true })} ${v.cpcPass ? "is within" : "is above"} the ${money(t.targetCpcCents, currency, { precise: true })} target.`;
  return `${ctrText} ${cpcText}`;
}

/** Short label for the target that missed, shown under a Fail chip. */
export function missLabel(v: Verdict) {
  if (v.status !== "fail") return null;
  if (!v.ctrPass && !v.cpcPass) return "Both targets missed";
  if (!v.ctrPass) return "Clickthrough too low";
  return "Clicks cost too much";
}
