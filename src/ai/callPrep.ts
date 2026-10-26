// AI task: a discovery call plan for one account and offer.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/callPrep.v1";
import { QUALIFICATION } from "@/lib/qualification";

export const CallPrepSchema = z.object({
  objective: z.string(),
  opening: z.string(),
  questions: z.array(z.object({ question: z.string(), why: z.string() })),
  listenFor: z.array(z.object({ key: z.string(), lookFor: z.string() })),
  objections: z.array(z.object({ objection: z.string(), answer: z.string() })),
  proof: z.array(z.string()),
  nextStepAsk: z.string(),
  redFlags: z.array(z.string()),
});
export type CallPrep = z.infer<typeof CallPrepSchema>;
export type CallPrepInput = Parameters<typeof P.user>[0];

// The question that opens the problem, per offer, said the way a buyer would hear it.
const PROBLEM_Q: [RegExp, string][] = [
  [/opportunity map/i, "Where has AI come up in your planning this year, and what's been hard about picking where to start?"],
  [/agentready|readiness|governance/i, "How are people using AI tools today, and how much of that do you have visibility into?"],
  [/fde|sprint/i, "Which process takes the most manual effort right now, and what happens when it slips?"],
  [/smart space|poc/i, "When someone needs an answer from your own documents, how do they find it today?"],
  [/brain/i, "If one of your most experienced people left, what would you lose that isn't written down?"],
  [/modernization|blueprint/i, "Which system does everyone work around, and what has stopped you from replacing it so far?"],
];

export function mockCallPrep(i: CallPrepInput): CallPrep {
  const problemQ = PROBLEM_Q.find(([re]) => re.test(i.offer.name))?.[1] ?? "What's the problem you'd most like solved this quarter?";
  const leader = i.signals.find((s) => s.type === "leadership");
  const legacy = i.signals.find((s) => s.type === "tech");
  const growth = i.signals.find((s) => s.type === "news" || s.type === "growth");
  const first = i.buyer?.name.split(" ")[0] ?? "there";
  const questions = [
    { question: problemQ, why: "Gets the problem in their words, which is what the follow-up and proposal will quote back." },
    { question: "What does that cost you today, in time, money or risk?", why: "Sizes the impact so the price has something to be compared against." },
    { question: leader ? "With the new leadership in place, what's changed about priorities this year?" : growth ? "With everything that's changing at the company, what has moved up the list this year?" : "Why is this coming up now, rather than last year?", why: "Finds the trigger without telling them what we already know." },
    { question: legacy ? "Which systems does this touch, and how old are they?" : "What have you already tried, and what got in the way?", why: "Shows the fit with the offer and what a first step would have to work around." },
    { question: "If you decided to fix this, who else would be involved, and how do decisions like this usually get made?", why: "Maps the decision without asking 'are you the decision-maker'." },
    { question: "Is there a budget set aside for this, or would it need to be found?", why: "Learns how money moves before talking price." },
    { question: `If we could ${i.offer.promise.replace(/\.$/, "").toLowerCase()}, what would that change for you?`, why: "Lets them sell the outcome to themselves." },
  ];
  return {
    objective: `Confirm the problem and its cost, learn who decides, and agree a dated next step toward ${i.offer.name}.`,
    opening: `Hi ${first}, thanks for making the time. I'd love to start with what's on your plate this year and then share what we're seeing at similar ${i.account.industry?.toLowerCase().replace(/:.*$/, "") ?? ""} companies, if that's useful.`.replace(/\s+/g, " "),
    questions,
    listenFor: QUALIFICATION.map((q) => ({ key: q.key, lookFor: q.listenFor })),
    objections: [
      { objection: "We're not ready for this yet.", answer: `That's common. ${i.offer.name} is built to be the first step, small and fixed, so you can see the result before committing to anything larger.` },
      { objection: "We have an internal team for this.", answer: "Good, we work alongside internal teams. The question is whether they have the time this quarter, and we can take the part that's stuck." },
      { objection: "Send me some information.", answer: "Happy to. So I send the right thing, which part matters most to you: the outcome, the price or how it works?" },
    ],
    proof: i.offer.proof.slice(0, 3),
    nextStepAsk: `A 30-minute working session to scope ${i.offer.name} for ${i.account.name}, with whoever else would be involved in the decision.`,
    redFlags: ["No one can name the problem in their own words.", "No budget and no path to one.", "The decision sits entirely with a parent company or a team not on the call."],
  };
}

export const callPrepTask: AiTask<CallPrepInput, CallPrep> = {
  name: "call-prep",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: CallPrepSchema,
  buildUser: P.user,
  mock: mockCallPrep,
  maxTokens: 4000,
};
