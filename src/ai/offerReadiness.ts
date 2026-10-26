// AI task: judge the offer-strength half of offer readiness (the market half is measured).

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/offerReadiness.v1";

const Judged = z.object({ value: z.number(), reason: z.string() });
export const OfferJudgementSchema = z.object({ outcome: Judged, speed: Judged, risk: Judged, deliverable: Judged, different: Judged, fixes: z.array(z.string()) });
export type OfferJudgement = z.infer<typeof OfferJudgementSchema>;
export type OfferJudgementInput = Parameters<typeof P.user>[0];

/** Rules until Claude is connected: read the promise and proof for the obvious signs. */
export function mockOfferJudgement(i: OfferJudgementInput): OfferJudgement {
  const text = `${i.promise} ${i.proofPoints.join(" ")}`.toLowerCase();
  const has = (re: RegExp) => re.test(text);
  const outcome = has(/\d|fixed price|ranked|live|working|cut|save|reduce|increase/) ? { value: 7, reason: "The promise names a concrete result." } : { value: 4, reason: "The promise describes activity more than a result." };
  const speed = has(/\b(\d+\s*(day|days)|one week|two weeks|2 weeks|\d+\s*weeks?)\b/) ? { value: 8, reason: "A first result is promised within weeks." } : has(/month/) ? { value: 5, reason: "First results take months." } : { value: 4, reason: "No timeline in the promise." };
  const risk = has(/guarantee|free|money back|refund|fixed price/) ? { value: 8, reason: "There's a guarantee or a fixed price." } : { value: 3, reason: "Nothing takes risk off the buyer." };
  const deliverable = has(/map|blueprint|architecture|prototype|build|report|plan|workspace|list|diagnostic/) ? { value: 8, reason: "The buyer gets something tangible." } : { value: 4, reason: "Unclear what the buyer holds at the end." };
  const different = { value: 5, reason: "Not judged without Claude. Set it by hand or connect Claude." };
  const fixes = [
    ...(risk.value < 6 ? ["Add a guarantee or a fixed price for the first step."] : []),
    ...(speed.value < 6 ? ["Promise a first result inside two weeks."] : []),
    ...(outcome.value < 6 ? ["Rewrite the promise as the result the buyer gets, with a number or a date."] : []),
  ];
  return { outcome, speed, risk, deliverable, different, fixes };
}

export const offerJudgementTask: AiTask<OfferJudgementInput, OfferJudgement> = {
  name: "offer-readiness",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: OfferJudgementSchema,
  buildUser: P.user,
  mock: mockOfferJudgement,
  maxTokens: 2000,
};
