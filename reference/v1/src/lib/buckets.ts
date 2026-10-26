// Taazaa's practice buckets: the four lines the ABM research runs under, the offers that sell in each,
// and a draft offer for the two lines that don't have one yet (taken from what the research proposes;
// a person approves the wording and price before it's matched). Used by scripts/setup-buckets.mts.

export type BucketDef = { slug: string; name: string; description: string; keywords: string[]; offers: string[] };

export const DEFAULT_BUCKETS: BucketDef[] = [
  {
    slug: "ai-transformation",
    name: "AI Transformation",
    description: "Bounded AI pilots on real workflows: exceptions, document work, operations around systems the client already bought.",
    keywords: ["ai transformation", "transformation"],
    offers: ["agentready-diagnostic", "ai-opportunity-map", "fde-sprint"],
  },
  {
    slug: "ai-operating-platforms",
    name: "AI Operating Platforms",
    description: "Modernizing and unifying the systems a company runs on, with AI built into the workflows.",
    keywords: ["operating platforms", "operating platform"],
    offers: ["modernization-blueprint", "smart-space-poc", "company-brain"],
  },
  {
    slug: "data-engineering",
    name: "Data & Engineering for AI Readiness",
    description: "Data quality, integration and governance so AI runs on data people trust.",
    keywords: ["data and engineering", "data engineering", "data & engineering"],
    offers: ["ai-data-readiness-assessment"],
  },
  {
    slug: "ai-marketing-studio",
    name: "AI Marketing Studio",
    description: "Go-to-market work for companies with a growth mandate: ABM, positioning, AI content and attribution.",
    keywords: ["marketing studio", "ai marketing"],
    offers: ["gtm-audit-pilot"],
  },
];

/** Draft offers for buckets that don't have one, built from what the research sheets propose. */
export const DRAFT_OFFERS = [
  {
    slug: "ai-data-readiness-assessment",
    name: "AI Data Readiness Assessment",
    promise: "In two to four weeks, a measured baseline of the data your AI plans depend on: quality, lineage and integration gaps across your critical entities, with a prioritized fix backlog.",
    priceMinCents: 2_000_000,
    priceMaxCents: 4_500_000,
    targetTitles: ["CIO", "CTO", "Chief Data Officer", "VP Data", "Director of IT", "COO"],
  },
  {
    slug: "gtm-audit-pilot",
    name: "30-Day GTM Audit and Pilot",
    promise: "A 30-day go-to-market audit and one live pilot (account-based campaigns, AI content or attribution) aimed at the growth mandate you already have.",
    priceMinCents: 1_500_000,
    priceMaxCents: 3_500_000,
    targetTitles: ["CMO", "VP Marketing", "VP Growth", "Head of Demand Generation", "CEO"],
  },
];
