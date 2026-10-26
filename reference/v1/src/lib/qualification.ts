// The discovery call checklist: what a rep needs to learn before an account is qualified.
// Call prep plans for it; call review scores a call against it.

export const QUALIFICATION = [
  { key: "problem", label: "The problem, in their words", listenFor: "What's broken, said the way they'd say it to their boss." },
  { key: "impact", label: "What it costs them", listenFor: "Hours, money, risk, or a goal they'll miss if nothing changes." },
  { key: "trigger", label: "Why now", listenFor: "A date, an event, a new leader, a failed attempt: what makes this quarter different." },
  { key: "decision", label: "Who decides, and how", listenFor: "Who signs, who else weighs in, and the steps to a yes." },
  { key: "budget", label: "Budget range", listenFor: "A number, a range, or where the money would come from." },
  { key: "fit", label: "Fit with our offer", listenFor: "Their situation matches what the offer does, at the size and scope it does it." },
  { key: "nextStep", label: "Next step agreed", listenFor: "A dated next meeting or action both sides said yes to." },
] as const;

export type QualificationKey = (typeof QUALIFICATION)[number]["key"];
export type QualificationStatus = "met" | "partial" | "missing";

export const QUAL_STATUS_LABEL: Record<QualificationStatus, string> = { met: "Covered", partial: "Partly", missing: "Not covered" };

/** Share of the checklist covered: met counts 1, partial counts half. */
export function qualificationScore(items: { key: string; status: QualificationStatus }[]): number {
  const total = QUALIFICATION.length;
  const got = items.reduce((s, i) => s + (i.status === "met" ? 1 : i.status === "partial" ? 0.5 : 0), 0);
  return Math.round((got / total) * 100);
}
