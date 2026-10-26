// AI task for Module 5: a 3 to 5 line research note on an inbound lead.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/leadResearch.v1";

export const LeadResearchSchema = z.object({ note: z.string(), industry: z.string().nullable() });
export type LeadResearchInput = Parameters<typeof P.user>[0];

export function mockLeadResearch(input: LeadResearchInput): z.infer<typeof LeadResearchSchema> {
  const p = input.profile;
  const name = p.name ?? input.lead.companyName ?? "The company";
  const lines = [
    `${name}: ${p.industry ?? "industry unknown"}, about ${p.employees ?? "unknown"} employees${p.revenue ? `, roughly ${p.revenue} revenue` : ""}${p.hq ? `, based in ${p.hq}` : ""}.`,
  ];
  if (input.website && input.website.length > 40) lines.push(input.website.split(/(?<=\.)\s/).slice(0, 2).join(" "));
  lines.push(`${input.lead.name} (${input.lead.title ?? "title unknown"}) came in on ${input.offering?.name ?? "a general inquiry"}${input.lead.timeline ? `, timeline: ${input.lead.timeline}` : ""}.`);
  lines.push(`Open with: what does this cost you today, in hours or missed revenue?`);
  return { note: lines.slice(0, 5).join("\n"), industry: p.industry };
}

export const leadResearchTask: AiTask<LeadResearchInput, z.infer<typeof LeadResearchSchema>> = {
  name: "lead-research",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: LeadResearchSchema,
  buildUser: P.user,
  mock: mockLeadResearch,
  maxTokens: 2000,
};
