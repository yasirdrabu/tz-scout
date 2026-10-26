// AI task for Module 7: name the biggest bottleneck, its likely cause, and 1 to 3 fixes with owners.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/weeklyDiagnosis.v1";

export const DiagnosisSchema = z.object({
  bottleneck: z.string(),
  cause: z.string(),
  summary: z.string(),
  fixes: z.array(z.object({ text: z.string(), ownerRole: z.enum(["Owner", "Operator", "Sales"]) })),
});
export type DiagnosisOutput = z.infer<typeof DiagnosisSchema>;
export type DiagnosisInput = Parameters<typeof P.user>[0] & {
  /** Structured view for the mock: funnel-ordered stage rates with their shortfall vs target. */
  stages: { key: string; label: string; rolling: number | null; target: number | null; direction: "higher" | "lower" | "band" }[];
};

const PLAYBOOK: Record<string, { cause: string; fixes: DiagnosisOutput["fixes"] }> = {
  ctr: {
    cause: "Ads are reaching the audience but the message is not landing. Clickthrough has trailed target for most of the month.",
    fixes: [
      { text: "Run a new message test batch on the top active segment and replace the two weakest ads with winners.", ownerRole: "Operator" },
      { text: "Narrow the audience to the titles that clicked most in the last test.", ownerRole: "Operator" },
    ],
  },
  cpc: {
    cause: "Clicks are getting expensive, which usually means a crowded audience or tired creative.",
    fixes: [
      { text: "Rotate in fresh winning statements and pause ad sets above target cost per click.", ownerRole: "Operator" },
      { text: "Approve a shift of 20% of budget to the cheaper of the two active segments for two weeks.", ownerRole: "Owner" },
    ],
  },
  formRate: {
    cause: "People click but don't fill the form. The landing page likely asks for too much or doesn't match the ad.",
    fixes: [
      { text: "Cut the form to name, work email, title and timeline.", ownerRole: "Operator" },
      { text: "Match the landing page headline to the winning ad statement word for word.", ownerRole: "Operator" },
    ],
  },
  validationRate: {
    cause: "Too many form fills fail validation, mostly on company size and free email addresses. Targeting is pulling in the wrong companies.",
    fixes: [
      { text: "Tighten the ad audience to the company size range on the offering.", ownerRole: "Operator" },
      { text: "Add company size as a required question on the form.", ownerRole: "Operator" },
    ],
  },
  discoveryShowRate: {
    cause: "Booked discovery calls are not being held. Reminders alone are not enough; the time between booking and the call is likely too long.",
    fixes: [
      { text: "Offer slots within 48 hours on the booking page and drop anything later than 5 business days.", ownerRole: "Sales" },
      { text: "Have the rep send a personal note with the matched case study the day before.", ownerRole: "Sales" },
      { text: "Turn on text message reminders for every lead who consented.", ownerRole: "Operator" },
    ],
  },
  qualificationRate: {
    cause: "Discovery calls are happening but few qualify. Either validation is too loose or discovery questions miss budget and timeline.",
    fixes: [
      { text: "Add budget owner and timeline to the first three discovery questions.", ownerRole: "Sales" },
      { text: "Review the last ten unqualified calls and tighten the matching validation check.", ownerRole: "Owner" },
    ],
  },
  salesShowRate: {
    cause: "Sales calls are slipping after qualification. Momentum is lost between discovery and the follow-up.",
    fixes: [
      { text: "Book the sales call before ending the discovery call.", ownerRole: "Sales" },
      { text: "Send a one page recap within two hours of discovery.", ownerRole: "Sales" },
    ],
  },
  closeRate: {
    cause: "Qualified buyers are not signing. The fixed-fee offer may need a sharper reason to start now.",
    fixes: [
      { text: "Add a start-by date to proposals with the fee credit toward the next phase.", ownerRole: "Owner" },
      { text: "Bring the delivery lead to every second sales call.", ownerRole: "Sales" },
    ],
  },
};

export function mockDiagnosis(input: DiagnosisInput): DiagnosisOutput {
  let worst: { key: string; label: string; gap: number; rolling: number; target: number } | null = null;
  for (const s of input.stages) {
    if (s.rolling == null || s.target == null || s.target === 0) continue;
    const gap = s.direction === "lower" ? (s.rolling - s.target) / s.target : (s.target - s.rolling) / s.target;
    if (gap > 0 && (!worst || gap > worst.gap)) worst = { key: s.key, label: s.label, gap, rolling: s.rolling, target: s.target };
  }
  if (!worst) {
    return {
      bottleneck: "No stage is below target",
      cause: "Every stage is at or above target on the 4 week average.",
      summary: "The funnel is healthy. The fastest way to more won clients is more spend at the same cost per won client.",
      fixes: [{ text: "Raise next month's ad budget 20% and watch cost per won client for two weeks.", ownerRole: "Owner" }],
    };
  }
  const play = PLAYBOOK[worst.key] ?? { cause: `${worst.label} is below target.`, fixes: [{ text: `Review ${worst.label.toLowerCase()} with the team this week.`, ownerRole: "Owner" as const }] };
  const fmt = (n: number) => (n < 1 ? `${(n * 100).toFixed(1)}%` : `$${(n / 100).toFixed(2)}`);
  return {
    bottleneck: worst.label,
    cause: play.cause,
    summary: `${worst.label} is ${fmt(worst.rolling)} on the 4 week average against a target of ${fmt(worst.target)}, ${Math.round(worst.gap * 100)}% off. It is the largest gap in the funnel this month.`,
    fixes: play.fixes.slice(0, 3),
  };
}

export const weeklyDiagnosisTask: AiTask<DiagnosisInput, DiagnosisOutput> = {
  name: "weekly-diagnosis",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: DiagnosisSchema,
  buildUser: (i) => P.user({ company: i.company, weeks: i.weeks, rows: i.rows, openFixes: i.openFixes }),
  mock: mockDiagnosis,
  maxTokens: 3000,
};
