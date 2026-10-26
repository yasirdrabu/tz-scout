// AI task: review a sales call from a transcript or recap, against the qualification checklist.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/callReview.v1";
import { QUALIFICATION, type QualificationStatus } from "@/lib/qualification";

export const CallReviewSchema = z.object({
  summary: z.string(),
  qualification: z.array(z.object({ key: z.string(), status: z.enum(["met", "partial", "missing"]), evidence: z.string() })),
  pains: z.array(z.string()),
  objections: z.array(z.object({ objection: z.string(), answered: z.boolean() })),
  nextSteps: z.array(z.object({ owner: z.enum(["us", "them"]), action: z.string(), due: z.string() })),
  recommendedStatus: z.enum(["QUALIFIED", "WORKING", "DISQUALIFIED"]),
  risks: z.array(z.string()),
  coaching: z.array(z.string()),
  followUpEmail: z.string(),
});
export type CallReviewOutput = z.infer<typeof CallReviewSchema>;
export type CallReviewInput = Parameters<typeof P.user>[0];

// Rules until Claude is connected: find sentences that touch each checklist item.
const CUES: Record<string, RegExp> = {
  problem: /\b(problem|issue|struggl|pain|frustrat|broken|manual|slow|takes (us )?(\w+ )?(hours|days|weeks)|hard to|can't|cannot|workaround)/i,
  impact: /\b(cost|costs|\$\s?\d|\d+\s?(k|m|hours|people|percent|%)|revenue|losing|lose|risk|fine|penalt|churn|overtime)/i,
  trigger: /\b(this (year|quarter)|next (quarter|year|month)|deadline|by (january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|the end)|new (cio|cto|coo|ceo|leader|vp)|board|audit|acquisition|merger|renewal|contract (ends|expires))/i,
  decision: /\b(decide|decision|sign off|signs off|approve|approval|board|cfo|ceo|coo|cio|committee|procurement|my boss|leadership team)/i,
  budget: /\b(budget|spend|allocated|price|pricing|cost us|afford|\$\s?\d)/i,
  fit: /\b(exactly|that's what we need|makes sense|that would help|sounds like|we need|interested)/i,
  nextStep: /\b(next (week|step|call|meeting)|follow[- ]up|schedule|calendar|send (over|me)|let's (meet|talk|set)|on (monday|tuesday|wednesday|thursday|friday))/i,
};

export function mockCallReview(i: CallReviewInput): CallReviewOutput {
  const sentences = i.transcript.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 12);
  const find = (re: RegExp) => sentences.filter((s) => re.test(s));
  const qualification = QUALIFICATION.map((q) => {
    const hits = find(CUES[q.key]!);
    const status: QualificationStatus = hits.length >= 2 ? "met" : hits.length === 1 ? "partial" : "missing";
    return { key: q.key, status, evidence: hits[0] ? `"${hits[0].slice(0, 160)}"` : "Not heard on the call." };
  });
  const st = Object.fromEntries(qualification.map((q) => [q.key, q.status]));
  const no = /\b(not interested|no budget|not a priority|we're all set|not a fit)\b/i.test(i.transcript);
  const recommendedStatus = no || (st.fit === "missing" && st.problem === "missing") ? "DISQUALIFIED" : st.problem === "met" && st.impact !== "missing" && st.decision !== "missing" && st.nextStep !== "missing" ? "QUALIFIED" : "WORKING";
  const pains = find(CUES.problem!).slice(0, 4).map((s) => s.slice(0, 180));
  const nextHits = find(CUES.nextStep!).slice(0, 3);
  const first = i.buyer?.split(" ")[0] ?? "there";
  return {
    summary: `${sentences.slice(0, 3).join(" ").slice(0, 420) || "No transcript content."} (Summarized by rules; connect Claude for a real summary.)`,
    qualification,
    pains,
    objections: find(/\b(but|concern|worried|not sure|too expensive|already have|timing)\b/i).slice(0, 3).map((s) => ({ objection: s.slice(0, 160), answered: false })),
    nextSteps: nextHits.length ? nextHits.map((s) => ({ owner: "us" as const, action: s.slice(0, 160), due: "" })) : [{ owner: "us" as const, action: "Agree a dated next step; none was heard on the call.", due: "" }],
    recommendedStatus,
    risks: qualification.filter((q) => q.status === "missing").map((q) => `${QUALIFICATION.find((x) => x.key === q.key)!.label}: not covered yet.`),
    coaching: qualification.filter((q) => q.status !== "met").slice(0, 3).map((q) => `Next call, cover ${QUALIFICATION.find((x) => x.key === q.key)!.label.toLowerCase()}: ${QUALIFICATION.find((x) => x.key === q.key)!.listenFor}`),
    followUpEmail: `Hi ${first}, thanks for the time today.${pains[0] ? ` What stuck with me: ${pains[0].replace(/^"|"$/g, "")}` : ""} As next steps, I'll follow up with what we discussed and a time for the working session. Does that still work on your side?`,
  };
}

export const callReviewTask: AiTask<CallReviewInput, CallReviewOutput> = {
  name: "call-review",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: CallReviewSchema,
  buildUser: P.user,
  mock: mockCallReview,
  maxTokens: 5000,
};
