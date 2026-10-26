// AI task: a proposal draft for one account and offer, from the brief and the reviewed calls.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/proposal.v1";

export const ProposalSchema = z.object({
  title: z.string(),
  situation: z.string(),
  objectives: z.array(z.string()),
  phases: z.array(z.object({ name: z.string(), duration: z.string(), activities: z.array(z.string()), deliverables: z.array(z.string()) })),
  deliverables: z.array(z.string()),
  timeline: z.string(),
  investment: z.object({ price: z.string(), terms: z.string() }),
  assumptions: z.array(z.string()),
  whyUs: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
export type ProposalDraft = z.infer<typeof ProposalSchema>;
export type ProposalInput = Parameters<typeof P.user>[0];

// The usual shape of each offer, so the rules-based draft stays inside what the offer promises.
const SHAPES: [RegExp, { phases: ProposalDraft["phases"]; deliverables: string[]; timeline: string }][] = [
  [/modernization|blueprint/i, { timeline: "Two weeks from kickoff to the fixed price for Release 1.", deliverables: ["Current-state map of the system and its integrations", "Target architecture", "Release 1 scope with a fixed price"], phases: [
    { name: "Discover", duration: "Week 1", activities: ["Interviews with the people who run and use the system", "Read the code, data and integrations"], deliverables: ["Current-state map"] },
    { name: "Design and price", duration: "Week 2", activities: ["Target architecture", "Scope and estimate Release 1"], deliverables: ["Target architecture", "Fixed price for Release 1"] },
  ] }],
  [/opportunity map/i, { timeline: "Two weeks.", deliverables: ["Ranked list of AI opportunities with payback", "The first build, scoped and ready to start"], phases: [
    { name: "Find", duration: "Week 1", activities: ["Workshops with the teams doing the work", "Review of processes, data and tools"], deliverables: ["Long list of opportunities"] },
    { name: "Rank and scope", duration: "Week 2", activities: ["Payback and effort for each", "Scope the first build"], deliverables: ["Ranked map", "First build scoped"] },
  ] }],
  [/agentready|readiness|governance/i, { timeline: "About two weeks.", deliverables: ["Inventory of AI use and data exposure", "A go, fix first, or not ready answer with the fixes"], phases: [
    { name: "Inventory", duration: "Week 1", activities: ["Find the AI tools in use", "Map the data they touch"], deliverables: ["AI use inventory"] },
    { name: "Assess and advise", duration: "Week 2", activities: ["Score risk and readiness", "Write the fixes"], deliverables: ["Readiness answer with fixes"] },
  ] }],
  [/fde|sprint/i, { timeline: "A few weeks, one workflow.", deliverables: ["One workflow working in your environment", "Handover so your team runs it"], phases: [
    { name: "Pick and map", duration: "Week 1", activities: ["Choose the workflow", "Map the steps and systems"], deliverables: ["Workflow map"] },
    { name: "Build in place", duration: "Weeks 2 to 4", activities: ["An engineer builds it with your team"], deliverables: ["Working workflow"] },
    { name: "Hand over", duration: "Final week", activities: ["Train the owners", "Document"], deliverables: ["Runbook"] },
  ] }],
];

export function mockProposal(i: ProposalInput): ProposalDraft {
  const shape = SHAPES.find(([re]) => re.test(i.offer.name))?.[1] ?? {
    timeline: "To be confirmed together.",
    deliverables: ["Deliverables as described in the offer"],
    phases: [{ name: "Start", duration: "To be confirmed", activities: ["Kickoff and plan"], deliverables: ["Plan"] }],
  };
  const pains = i.calls.flatMap((c) => c.pains).slice(0, 3);
  // The buyer reads this. Use only what they told us; why-now is our internal research and stays out.
  const situation = pains.length
    ? `In our conversations, the team described it this way: ${pains.map((p) => `"${p.replace(/^"|"$/g, "")}"`).join(" ")}`
    : `To be confirmed on a call: the situation at ${i.account.name}, in the team's own words.`;
  return {
    title: `${i.offer.name} for ${i.account.name}`,
    situation,
    objectives: [i.offer.promise, "A clear decision on the next step, with a number attached", "No disruption to the team's day-to-day work"],
    phases: shape.phases,
    deliverables: shape.deliverables,
    timeline: shape.timeline,
    investment: { price: i.offer.price ?? "To be confirmed", terms: i.offer.price ? "Fixed fee. 50% to start, 50% on delivery." : "To be confirmed." },
    assumptions: ["Access to the people who do the work, about two hours each", "Access to the systems and data involved", "One named owner on your side"],
    whyUs: i.offer.proof.length ? i.offer.proof.slice(0, 3) : ["Proof to be added: link a case study to this offer."],
    nextSteps: ["Confirm scope and dates on a 30-minute call", "Sign and schedule the kickoff", "We send the interview list and data request"],
  };
}

export const proposalTask: AiTask<ProposalInput, ProposalDraft> = {
  name: "proposal",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: ProposalSchema,
  buildUser: P.user,
  mock: mockProposal,
  maxTokens: 5000,
};

/** The proposal as plain text, for copying into a document or an email. */
export function proposalText(p: ProposalDraft): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    p.title,
    "",
    "Where you are",
    p.situation,
    "",
    "What you want",
    list(p.objectives),
    "",
    "How we'll do it",
    p.phases.map((ph) => `${ph.name} (${ph.duration})\n${list(ph.activities)}\nYou get: ${ph.deliverables.join(", ")}`).join("\n\n"),
    "",
    "What you get",
    list(p.deliverables),
    "",
    `Timeline: ${p.timeline}`,
    `Investment: ${p.investment.price}. ${p.investment.terms}`,
    "",
    "Assumptions",
    list(p.assumptions),
    "",
    "Why us",
    list(p.whyUs),
    "",
    "Next steps",
    list(p.nextSteps),
  ].join("\n");
}
