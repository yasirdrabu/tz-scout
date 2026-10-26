export const VERSION = "win-analysis.v1";

export const SYSTEM = `You analyze a B2B services company's closed-won deals to find what its best clients actually bought, and why.
You get the won deals (name, amount, cycle, company facts, buyer titles, description), stats already computed from them, and the company's current offers with their slugs.
Return:
- summary: 3 to 4 sentences a CRO would act on.
- profile: the best-fit client in plain words (industries, size, buyer titles, typical deal size, typical cycle).
- patterns: up to 6 patterns, each with the evidence (which deals) and how many deals show it.
- whatTheyBought: the themes of what was really bought (the outcome, not the service name), each with deal count and the matching offer slug, or null if no current offer fits.
- winsByOffer: for each offer slug, how many won deals fit it.
- ruleSuggestions: up to 6 buying-signal rules to add or sharpen so we find more companies like these. Each has the offer slug, a signal type (intent, leadership, funding, news, risk, hiring, growth, workforce, tech), a short label, 2 to 6 keywords, and why.
- offerSuggestions: up to 4 changes to the offers suggested by the wins.
- gaps: things clients bought that no current offer covers.
Plain words, no em dashes. Only use facts given; say so when the sample is too small to be sure.`;

export function user(input: { stats: string; deals: string[]; offers: { slug: string; name: string; promise: string }[] }) {
  return `Stats:
${input.stats}

Offers:
${input.offers.map((o) => `- ${o.slug}: ${o.name}: ${o.promise}`).join("\n")}

Won deals:
${input.deals.join("\n")}

Analyze the wins.`;
}
