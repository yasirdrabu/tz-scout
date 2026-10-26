// Message test verdicts. Pass = clickthrough at or above target AND cost per click at or below target.
// No verdict below the minimum impressions.

export type VerdictStatus = "pass" | "fail" | "not_enough_data";

export type Verdict = {
  status: VerdictStatus;
  ctr: number | null;
  cpcCents: number | null;
  ctrPass: boolean | null;
  cpcPass: boolean | null;
};

export type ResultCounts = { impressions: number; clicks: number; spendCents: number };
export type VerdictTargets = { targetCtr: number; targetCpcCents: number; minImpressions?: number };

export function verdict(r: ResultCounts | null | undefined, t: VerdictTargets): Verdict {
  const min = t.minImpressions ?? 1000;
  if (!r) return { status: "not_enough_data", ctr: null, cpcCents: null, ctrPass: null, cpcPass: null };
  const ctr = r.impressions > 0 ? r.clicks / r.impressions : null;
  const cpcCents = r.clicks > 0 ? r.spendCents / r.clicks : null;
  if (r.impressions < min) return { status: "not_enough_data", ctr, cpcCents, ctrPass: null, cpcPass: null };
  const ctrPass = ctr != null && ctr >= t.targetCtr;
  const cpcPass = cpcCents != null && cpcCents <= t.targetCpcCents;
  return { status: ctrPass && cpcPass ? "pass" : "fail", ctr, cpcCents, ctrPass, cpcPass };
}
