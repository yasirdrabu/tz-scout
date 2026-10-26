// AI assist for Module 1: draft offering fields from a URL or uploaded file.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/offeringDraft.v1";

export const OfferingDraftSchema = z.object({
  name: z.string(),
  promise: z.string(),
  targetTitles: z.array(z.string()),
  industries: z.array(z.string()),
  companySizeMin: z.number().nullable(),
  companySizeMax: z.number().nullable(),
  priceMinDollars: z.number().nullable(),
  priceMaxDollars: z.number().nullable(),
  salesCycleDays: z.number().nullable(),
  proofPoints: z.array(z.string()),
  exclusions: z.array(z.string()),
});
export type OfferingDraft = z.infer<typeof OfferingDraftSchema>;

export type OfferingDraftInput = { sourceText: string; sourceLabel: string; offeringName?: string };

const TITLE_WORDS = ["CEO", "COO", "CFO", "CIO", "CTO", "CISO", "Chief Operating Officer", "VP Operations", "VP of Operations", "Head of Data", "IT Director", "Controller", "President", "Managing Partner", "Director of Operations", "Compliance"];
const INDUSTRY_WORDS = ["real estate", "proptech", "property management", "healthcare", "logistics", "insurance", "legal", "manufacturing", "financial services", "professional services", "private equity"];

/** Heuristic stand-in for Claude when running on mocks. Reads the text, not a template. */
export function mockOfferingDraft(input: OfferingDraftInput): OfferingDraft {
  const text = input.sourceText.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20 && s.length < 220);
  const lower = text.toLowerCase();
  const prices = [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\s?[kK])?/g)].map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n >= 1000);
  const sizes = [...text.matchAll(/(\d{2,5})\s*(?:to|-)\s*(\d{2,5})\s*(?:person|employee|people)/gi)][0];
  const weeks = text.match(/(\d+)\s*(?:to\s*\d+\s*)?weeks?/i);
  return {
    name: input.offeringName ?? sentences[0]?.split(/[.:]/)[0]?.slice(0, 60) ?? "Untitled offering",
    promise: sentences.find((s) => /\b(you|your|get|in \d+ weeks|fixed)\b/i.test(s))?.slice(0, 140) ?? sentences[0] ?? "",
    targetTitles: TITLE_WORDS.filter((t) => text.includes(t)).slice(0, 5),
    industries: INDUSTRY_WORDS.filter((w) => lower.includes(w)).map((w) => w.replace(/\b\w/g, (c) => c.toUpperCase())),
    companySizeMin: sizes ? Number(sizes[1]) : null,
    companySizeMax: sizes ? Number(sizes[2]) : null,
    priceMinDollars: prices.length ? Math.min(...prices) : null,
    priceMaxDollars: prices.length ? Math.max(...prices) : null,
    salesCycleDays: weeks ? Math.max(14, Number(weeks[1]) * 7 + 21) : null,
    proofPoints: sentences.filter((s) => /\d+\s?%|\d+x|from \d|\d+ (hours?|minutes?|days?)/i.test(s)).slice(0, 5),
    exclusions: [],
  };
}

export const offeringDraftTask: AiTask<OfferingDraftInput, OfferingDraft> = {
  name: "offering-draft",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: OfferingDraftSchema,
  buildUser: P.user,
  mock: mockOfferingDraft,
  maxTokens: 4000,
};
