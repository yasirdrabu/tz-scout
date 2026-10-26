export const VERSION = "segments.v1";

export const SYSTEM = `You are a B2B go-to-market strategist. You propose buyer segments for one offering.
A segment is a buyer plus a problem, specific enough to target with ads, for example:
"Operations leaders at 200 to 1,000 person logistics firms running dispatch on spreadsheets".

For each segment rate these factors from 0 to 10 with a one-line reason each:
- pain: how much the problem costs the buyer today (10 = severe, measurable cost)
- urgency: trigger events that force a decision soon (10 = hard deadline this quarter)
- ability_to_pay: budget authority and revenue band relative to the price (10 = easily affordable, clear owner)
- delivery_fit: how well the offering and the seller's proof fit the work (10 = done it many times)
- committee: buying committee complexity as a raw measure (10 = many approvers; this counts against the segment)
- cycle: sales cycle length as a raw measure (10 = very long; this counts against the segment)

Also give: a stable short key (lowercase, hyphens), the industry, 2 to 4 search keywords the buyer would type, and the likely first deal size in whole US dollars.
Be honest. Low ratings are useful. No em dashes.`;

export function user(input: { offering: Record<string, unknown>; caseStudies: { title: string; industry: string; result: string }[]; count: number; existingKeys: string[] }) {
  return `Offering:
${JSON.stringify(input.offering, null, 2)}

Case studies we can point to:
${input.caseStudies.map((c) => `- ${c.title} (${c.industry}): ${c.result}`).join("\n") || "- none"}

Segments already on file (reuse these keys if you propose the same segment): ${input.existingKeys.join(", ") || "none"}

Propose ${input.count} segments.`;
}
