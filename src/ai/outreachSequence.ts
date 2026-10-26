// AI task for Buyers: the follow-up sequence after the opener (4 emails over two weeks), so a pushed
// account comes with the whole first touch plan, not just one line.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/outreachSequence.v1";
import { signalPhrase } from "./accountBrief";

export const SequenceStepSchema = z.object({ step: z.number(), day: z.number(), purpose: z.string(), subject: z.string(), body: z.string() });
export const OutreachSequenceSchema = z.object({ steps: z.array(SequenceStepSchema) });
export type SequenceStep = z.infer<typeof SequenceStepSchema>;
export type OutreachSequence = z.infer<typeof OutreachSequenceSchema>;
export type OutreachSequenceInput = Parameters<typeof P.user>[0];

/** The day each step goes out, and what it's for. */
export const SEQUENCE_PLAN = [
  { step: 1, day: 0, purpose: "Opener" },
  { step: 2, day: 3, purpose: "New angle" },
  { step: 3, day: 7, purpose: "Proof" },
  { step: 4, day: 14, purpose: "Close the loop" },
] as const;

// The problem each offer solves, said the way a buyer would, for the day 3 email.
const PAIN_QUESTION: [RegExp, string][] = [
  [/opportunity map/i, "is there a clear answer yet on where AI would actually pay back for you, or is it still a list of ideas?"],
  [/agentready|readiness|governance/i, "do you know today which AI tools your people are already using, and on what data?"],
  [/fde|sprint/i, "which workflow still runs on spreadsheets and manual handoffs, and who owns fixing it?"],
  [/smart space|poc/i, "how long does it take your team to find the answer that's buried in your own documents?"],
  [/brain/i, "if your most experienced person left tomorrow, how much of how the work gets done would leave with them?"],
  [/modernization|blueprint/i, "what would it take to get a fixed price on replacing the system everyone works around?"],
];

const HOOK_ORDER = ["leadership", "funding", "news", "tech", "growth"];

/** Mock: assembled from the offer, the opener and the public signals. Plain and accurate. */
export function mockOutreachSequence(i: OutreachSequenceInput): OutreachSequence {
  const first = i.buyer?.name.split(" ")[0] ?? "there";
  const me = i.sender?.split(" ")[0] ?? "";
  const sign = me ? `\n\n${me}` : "";
  const company = i.account.name;
  const industry = i.account.industry?.toLowerCase().replace(/:.*$/, "") ?? null;
  const hooks = HOOK_ORDER.flatMap((t) => i.signals.filter((s) => s.type === t && s.title.length <= 90));
  const second = hooks[1];
  const question = PAIN_QUESTION.find(([re]) => re.test(i.offer.name))?.[1] ?? "what would change if this got solved this quarter?";
  const proof = i.offer.proof[0];
  const opener = (i.opener ?? `Hi ${first}, I work with ${industry ?? ""} teams like ${company}. ${i.offer.promise}`).replace(/\s+/g, " ").trim();
  const body1 = `${opener}\n\nWorth a 20-minute conversation in the next couple of weeks?${sign}`;
  const body2 = second
    ? `Hi ${first}, one more thought. I saw ${company} ${signalPhrase(company, second)}. Moments like that usually raise a question: ${question}\n\nHappy to share what we've seen work.${sign}`
    : `Hi ${first}, a quick question for you: ${question}\n\nIf that's on your list, I can share how other ${industry ? `${industry} ` : ""}teams have handled it.${sign}`;
  const body3 = `Hi ${first}, ${proof ? `${proof.replace(/^Guarantee:\s*/i, "our guarantee: ")}.` : `here's what ${i.offer.name} is in one line.`} ${i.offer.promise}\n\nWould it help to see how that would look for ${company}?${sign}`;
  const body4 = `Hi ${first}, I'll close the loop here so I'm not crowding your inbox. If ${i.offer.name.toLowerCase()} isn't a priority right now, no problem at all. If it is, just reply with a good week and I'll make it easy.${sign}`;
  const short = i.offer.name;
  return {
    steps: [
      { step: 1, day: 0, purpose: "Opener", subject: `${company} and ${short}`, body: body1 },
      { step: 2, day: 3, purpose: "New angle", subject: "A quick question", body: body2 },
      { step: 3, day: 7, purpose: "Proof", subject: `What ${short} looks like`, body: body3 },
      { step: 4, day: 14, purpose: "Close the loop", subject: "Should I close the loop?", body: body4 },
    ],
  };
}

export const outreachSequenceTask: AiTask<OutreachSequenceInput, OutreachSequence> = {
  name: "outreach-sequence",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: OutreachSequenceSchema,
  buildUser: P.user,
  mock: mockOutreachSequence,
  maxTokens: 3000,
};
