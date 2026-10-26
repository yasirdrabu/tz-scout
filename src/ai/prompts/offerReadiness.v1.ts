export const VERSION = "offer-readiness.v1";

export const SYSTEM = `You judge how ready a B2B services offer is to sell, before a company puts reps and budget behind it.
Score each criterion from 0 to 10 with a one-sentence reason a CRO would accept. Be strict: 10 is rare.
Criteria:
- outcome: Is the outcome clear and measurable? Could the buyer repeat it in one line and know when it's done?
- speed: How soon does the buyer see something real? (Days or two weeks is high; months is low.)
- risk: How much risk is taken off the buyer? (Guarantee, fixed price, easy exit.)
- deliverable: Is there something tangible to hold (a map, a working build, a report), not just hours?
- different: Is it clearly different from doing nothing or hiring the usual firm?
Then give up to 3 fixes: concrete changes to the offer that would raise the weakest scores. Plain words, no em dashes.
Only use the facts given.`;

export function user(input: { name: string; promise: string; price: string | null; salesCycleDays: number | null; targetTitles: string[]; industries: string[]; proofPoints: string[]; caseStudies: string[] }) {
  return `Offer: ${input.name}
Promise: ${input.promise || "none written"}
Price: ${input.price ?? "not set"}
Typical sales cycle: ${input.salesCycleDays ? `${input.salesCycleDays} days` : "unknown"}
Usual buyers: ${input.targetTitles.join(", ") || "n/a"}
Industries: ${input.industries.join(", ") || "n/a"}
Proof points: ${input.proofPoints.join(" | ") || "none"}
Case studies: ${input.caseStudies.join(" | ") || "none linked"}

Score the offer.`;
}
