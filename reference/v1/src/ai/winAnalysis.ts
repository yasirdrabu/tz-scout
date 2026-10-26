// AI task: what our won clients actually bought, and what that says about who to go after next.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/winAnalysis.v1";
import { SIGNAL_TYPES } from "@/lib/matching";

export const WinFindingsSchema = z.object({
  summary: z.string(),
  profile: z.object({ industries: z.string(), size: z.string(), titles: z.string(), dealSize: z.string(), cycle: z.string() }),
  patterns: z.array(z.object({ pattern: z.string(), evidence: z.string(), deals: z.number() })),
  whatTheyBought: z.array(z.object({ theme: z.string(), deals: z.number(), offerSlug: z.string().nullable() })),
  winsByOffer: z.array(z.object({ offerSlug: z.string(), wins: z.number() })),
  ruleSuggestions: z.array(z.object({ offerSlug: z.string(), type: z.enum(SIGNAL_TYPES), label: z.string(), keywords: z.array(z.string()), why: z.string() })),
  offerSuggestions: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type WinFindings = z.infer<typeof WinFindingsSchema>;
export type WinInput = Parameters<typeof P.user>[0] & { raw: { name: string; description: string | null }[] };

// Which offer a deal looks like, from its name and description.
const OFFER_CUES: [RegExp, RegExp][] = [
  [/modernization|blueprint/i, /moderni[sz]|legacy|replace|rebuild|migrat|re-?platform|access|as\/400|cobol|rewrite/i],
  [/opportunity map/i, /ai (strategy|roadmap|opportunit)|opportunity map|where ai/i],
  [/agentready|readiness|governance/i, /readiness|governance|ai (risk|policy|security)|assessment/i],
  [/fde|sprint/i, /automat|workflow|sprint|integration|ops engineer/i],
  [/smart space|poc/i, /proof of concept|\bpoc\b|prototype|knowledge|assistant|copilot|search/i],
  [/brain/i, /knowledge (base|capture)|documentation|brain/i],
];

export function mockWinFindings(i: WinInput): WinFindings {
  const winsByOffer = i.offers.map((o) => {
    const cue = OFFER_CUES.find(([name]) => name.test(o.name))?.[1];
    return { offerSlug: o.slug, wins: cue ? i.raw.filter((d) => cue.test(`${d.name} ${d.description ?? ""}`)).length : 0 };
  });
  const matched = winsByOffer.reduce((s, w) => s + w.wins, 0);
  return {
    summary: `${i.raw.length} won deals read. The stats above are exact; the patterns need Claude to read the deals properly. ${matched ? `${matched} deals look like one of our current offers by name.` : "None of the deal names clearly match a current offer."} (Assembled by rules; connect Claude for the full analysis.)`,
    profile: { industries: "See the industry counts.", size: "See the size bands.", titles: "See the buyer functions.", dealSize: "See the median deal.", cycle: "See the median cycle." },
    patterns: [],
    whatTheyBought: winsByOffer.filter((w) => w.wins > 0).map((w) => ({ theme: i.offers.find((o) => o.slug === w.offerSlug)!.name, deals: w.wins, offerSlug: w.offerSlug })),
    winsByOffer,
    ruleSuggestions: [],
    offerSuggestions: [],
    gaps: i.raw.length - matched > 0 ? [`${i.raw.length - matched} won deals don't match any current offer by name. Worth reading them for a missing offer.`] : [],
  };
}

export const winAnalysisTask: AiTask<WinInput, WinFindings> = {
  name: "win-analysis",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: WinFindingsSchema,
  buildUser: (i) => P.user(i),
  mock: mockWinFindings,
  maxTokens: 6000,
};
