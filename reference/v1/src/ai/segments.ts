// AI task for Module 2: propose segments with AI-rated factors and reasons.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/segments.v1";
import { SEGMENT_LIBRARY, type MockSegment } from "./mock/segmentLibrary";
import { pick, rng } from "@/lib/rand";

const Rated = z.object({ value: z.number(), reason: z.string() });

export const SegmentProposalSchema = z.object({
  segments: z.array(
    z.object({
      key: z.string(),
      buyer: z.string(),
      problem: z.string(),
      industry: z.string(),
      keywords: z.array(z.string()),
      expectedDealDollars: z.number(),
      factors: z.object({
        pain: Rated,
        urgency: Rated,
        ability_to_pay: Rated,
        delivery_fit: Rated,
        committee: Rated,
        cycle: Rated,
      }),
    }),
  ),
});
export type SegmentProposal = z.infer<typeof SegmentProposalSchema>;

export type SegmentsInput = {
  offeringSlug: string;
  offering: { name: string; promise: string; targetTitles: string[]; industries: string[]; dealSizeDollars: number | null; companySize: string; revenueBand: string; salesCycleDays: number | null };
  caseStudies: { title: string; industry: string; result: string }[];
  count: number;
  existingKeys: string[];
};

const level = (v: number) => (v >= 8 ? "high" : v >= 5 ? "moderate" : "low");

function fromLibrary(m: MockSegment, offeringName: string) {
  const [pain, urg, pay, del, com, cyc] = m.v;
  return {
    key: m.key,
    buyer: m.buyer,
    problem: m.problem,
    industry: m.industry,
    keywords: m.keywords,
    expectedDealDollars: m.expectedDealDollars,
    factors: {
      pain: { value: pain, reason: m.painWhy },
      urgency: { value: urg, reason: m.urgencyWhy },
      ability_to_pay: { value: pay, reason: `${level(pay)[0]!.toUpperCase() + level(pay).slice(1)} ability to pay: ${m.industry.toLowerCase()} budgets ${pay >= 7 ? "cover" : "stretch to"} a fixed-fee start.` },
      delivery_fit: { value: del, reason: del >= 8 ? `We have delivered this kind of work; ${offeringName} fits directly.` : `Adjacent to work we have done; expect some ramp-up.` },
      committee: { value: com, reason: com >= 7 ? "Several approvers, often including legal or compliance." : com >= 4 ? "Buyer plus one or two approvers." : "One decision maker can sign." },
      cycle: { value: cyc, reason: cyc >= 7 ? "Expect a long cycle, 4 months or more." : cyc >= 4 ? "Typical cycle, 6 to 12 weeks." : "Short cycle, under 6 weeks." },
    },
  };
}

/** Mock: curated proposals for known offerings, otherwise built from the offering's own titles and industries. */
export function mockSegments(input: SegmentsInput): SegmentProposal {
  const lib = SEGMENT_LIBRARY[input.offeringSlug];
  if (lib) return { segments: lib.slice(0, Math.max(8, input.count)).map((m) => fromLibrary(m, input.offering.name)) };
  const r = rng(`segments:${input.offeringSlug}`);
  const titles = input.offering.targetTitles.length ? input.offering.targetTitles : ["Operations leaders"];
  const industries = input.offering.industries.length ? input.offering.industries : ["Professional services", "Logistics", "Healthcare services"];
  const problems = ["running core workflows on spreadsheets", "facing pressure to show results from AI", "losing hours to manual handoffs", "stuck on a system nobody can change"];
  const out: SegmentProposal["segments"] = [];
  for (let i = 0; i < input.count; i++) {
    const industry = industries[i % industries.length]!;
    const title = titles[i % titles.length]!;
    const problem = problems[i % problems.length]!;
    const v = () => Math.round(3 + r() * 6);
    const m: MockSegment = {
      key: `${industry}-${title}-${i}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48),
      name: "",
      buyer: `${title} at mid-market ${industry.toLowerCase()} companies`,
      problem,
      industry,
      keywords: [`${industry.toLowerCase()} automation`, `${problem.split(" ").slice(0, 3).join(" ")}`],
      expectedDealDollars: input.offering.dealSizeDollars ?? 10000,
      v: [v(), v(), v(), v(), v(), v()],
      painWhy: pick(r, ["Manual work shows up in overtime and errors.", "The cost is real but rarely measured.", "Leaders feel it weekly."]),
      urgencyWhy: pick(r, ["No hard deadline yet.", "Budget planning creates a window.", "Competitors are moving first."]),
    };
    out.push(fromLibrary(m, input.offering.name));
  }
  return { segments: out };
}

export const segmentsTask: AiTask<SegmentsInput, SegmentProposal> = {
  name: "segments",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: SegmentProposalSchema,
  buildUser: (i) => P.user({ offering: i.offering, caseStudies: i.caseStudies, count: i.count, existingKeys: i.existingKeys }),
  mock: mockSegments,
  maxTokens: 16000,
};
