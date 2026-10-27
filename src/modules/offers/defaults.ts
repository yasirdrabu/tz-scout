import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { caseStudy, offer, practice } from './db/schema';
import { createCaseStudy, linkCaseStudy } from './services/case-studies';
import { createOffer, type OfferPatch } from './services/offers';
import { createPractice } from './services/practices';
import { seedSignalRules } from './services/signal-rules';

/** Taazaa's catalogue, from the v1 seed. Practice, offer and case study wording is unchanged. */
export const TAAZAA_PRACTICES = [
  {
    slug: 'ai-transformation',
    name: 'AI Transformation',
    description:
      'Bounded AI pilots on real workflows: exceptions, document work, operations around systems the client already bought.',
    keywords: ['ai transformation', 'transformation'],
  },
  {
    slug: 'ai-operating-platforms',
    name: 'AI Operating Platforms',
    description: 'Modernizing and unifying the systems a company runs on, with AI built into the workflows.',
    keywords: ['operating platforms', 'operating platform'],
  },
  {
    slug: 'data-engineering',
    name: 'Data & Engineering for AI Readiness',
    description: 'Data quality, integration and governance so AI runs on data people trust.',
    keywords: ['data and engineering', 'data engineering', 'data & engineering'],
  },
  {
    slug: 'ai-marketing-studio',
    name: 'AI Marketing Studio',
    description: 'Go-to-market work for companies with a growth mandate: ABM, positioning, AI content and attribution.',
    keywords: ['marketing studio', 'ai marketing'],
  },
];

const M = 100_000_000; // $1M in cents
const MIDMARKET = {
  companySizeMin: 100,
  companySizeMax: 2500,
  revenueMinCents: 50 * M,
  revenueMaxCents: 500 * M,
  regions: ['United States'],
  excludedCategories: ['Gambling', 'Adult entertainment', 'Tobacco', 'Firearms'],
  excludedDomains: ['taazaa.com'],
};

type SeedOffer = OfferPatch & {
  slug: string;
  name: string;
  promise: string;
  practice: string;
  approved: boolean;
  cases: string[];
};

export const TAAZAA_OFFERS: SeedOffer[] = [
  {
    slug: 'ai-opportunity-map',
    name: 'AI Opportunity Map',
    practice: 'ai-transformation',
    promise: 'In two weeks, know exactly where AI pays back in your business, ranked, with the first build ready to start.',
    priceMinCents: 1_000_000,
    priceMaxCents: 1_000_000,
    typicalDealCents: 1_000_000,
    grossMargin: 0.6,
    salesCycleDays: 30,
    targetTitles: ['CEO', 'COO', 'VP Operations', 'President', 'Operating Partner'],
    industries: ['Commercial real estate', 'Property management', 'Healthcare services', 'Logistics', 'Professional services', 'Insurance', 'Private equity', 'Manufacturing'],
    proofPoints: ['Scored opportunity register and a number one build brief in two weeks', 'Tobi: 32% more revenue and 100% on-time trips after AI-assisted dispatch', 'Snapform: intake from 3 hours to 45 minutes'],
    ...MIDMARKET,
    approved: true,
    cases: ['Tobi', 'Snapform', 'Safeguard AI', 'Taurex'],
  },
  {
    slug: 'agentready-diagnostic',
    name: 'AgentReady Diagnostic',
    practice: 'ai-transformation',
    promise: 'A clear go, fix first, or not ready answer on AI, scored across six domains, in two to three weeks.',
    priceMinCents: 1_000_000,
    priceMaxCents: 1_000_000,
    typicalDealCents: 1_000_000,
    grossMargin: 0.6,
    salesCycleDays: 45,
    targetTitles: ['CIO', 'CISO', 'Head of Data', 'Chief Compliance Officer', 'CTO', 'VP Engineering'],
    industries: ['Healthcare services', 'Financial services', 'Insurance', 'Legal services', 'Software', 'Commercial real estate', 'Professional services'],
    proofPoints: ['Readiness and governance score across six domains, 0 to 4', 'Gap to control map plus a remediation roadmap that becomes the next SOW', 'MediPulse AI: clinician-facing assistant built with retrieval and per-user memory'],
    ...MIDMARKET,
    approved: true,
    cases: ['MediPulse AI', 'Taurex', 'Safeguard AI'],
  },
  {
    slug: 'fde-sprint',
    name: 'FDE Sprint',
    practice: 'ai-transformation',
    promise: 'A forward-deployed engineer takes one workflow from we know what to fix to a working result in your environment.',
    priceMinCents: 0,
    priceMaxCents: 1_000_000,
    typicalDealCents: 1_000_000,
    grossMargin: 0.5,
    salesCycleDays: 21,
    targetTitles: ['COO', 'VP Operations', 'Director of Operations', 'Controller', 'Revenue Cycle Director'],
    industries: ['Commercial real estate', 'Healthcare services', 'Logistics', 'Legal services', 'Insurance', 'Transportation', 'Property management'],
    proofPoints: ['Snapform: intake from 3 hours to 45 minutes', 'Safeguard AI: 80% less processing time at 98% accuracy', 'Quote Harness: worked example of a Sprint build'],
    ...MIDMARKET,
    approved: true,
    cases: ['Snapform', 'Tobi', 'Safeguard AI'],
  },
  {
    slug: 'smart-space-poc',
    name: 'Smart Space POC Build',
    practice: 'ai-operating-platforms',
    promise: 'A client-owned AI application for one department, live on your data with governance built in.',
    priceMinCents: 2_500_000,
    priceMaxCents: 4_500_000,
    typicalDealCents: 3_500_000,
    grossMargin: 0.55,
    salesCycleDays: 60,
    targetTitles: ['VP Operations', 'Head of Investments', 'Chief Risk Officer', 'VP Medical Affairs', 'VP Customer Success', 'Head of Corporate Development'],
    industries: ['Commercial real estate', 'Private equity', 'Financial services', 'Healthcare services', 'Life sciences', 'Food and beverage', 'Software'],
    proofPoints: ['About 70% reusable shell, 30% configured to your data and systems', 'Every answer cites its source; every step is audited', 'Taurex: 85% faster responses with numbers computed outside the model'],
    ...MIDMARKET,
    approved: true,
    cases: ['MediPulse AI', 'Taurex', 'Civi'],
  },
  {
    slug: 'company-brain',
    name: 'Company Brain',
    practice: 'ai-operating-platforms',
    promise: 'One department running on a maintained company memory any AI model can use, live in six to eight weeks.',
    priceMinCents: 1_000_000,
    priceMaxCents: 4_500_000,
    typicalDealCents: 3_500_000,
    grossMargin: 0.55,
    salesCycleDays: 60,
    targetTitles: ['CEO', 'COO', 'President'],
    industries: ['Commercial real estate', 'Professional services', 'Healthcare services', 'Distribution', 'IT services', 'Construction'],
    proofPoints: ['Taazaa runs on it first: sales, bid discovery and content', 'Blueprint fee credited if you proceed'],
    ...MIDMARKET,
    approved: false,
    cases: ['Civi', 'Snapform'],
  },
  {
    slug: 'modernization-blueprint',
    name: 'Modernization Blueprint',
    practice: 'ai-operating-platforms',
    promise: 'A current-state map, target architecture and a fixed price for Release 1 in two weeks, or the Blueprint is free.',
    priceMinCents: 1_000_000,
    priceMaxCents: 1_000_000,
    typicalDealCents: 1_000_000,
    grossMargin: 0.6,
    salesCycleDays: 30,
    targetTitles: ['COO', 'CIO', 'IT Director', 'Owner', 'VP Operations'],
    industries: ['Logistics', 'Property management', 'Healthcare services', 'Insurance', 'Manufacturing', 'Nonprofit', 'Government services', 'Professional services'],
    proofPoints: ["Guarantee: if Release 1 can't be fixed-priced from the Blueprint, the Blueprint is free"],
    ...MIDMARKET,
    approved: true,
    cases: [],
  },
  // Draft offers for the two practices that had none; a person approves the wording and price.
  {
    slug: 'ai-data-readiness-assessment',
    name: 'AI Data Readiness Assessment',
    practice: 'data-engineering',
    promise: 'In two to four weeks, a measured baseline of the data your AI plans depend on: quality, lineage and integration gaps across your critical entities, with a prioritized fix backlog.',
    priceMinCents: 2_000_000,
    priceMaxCents: 4_500_000,
    targetTitles: ['CIO', 'CTO', 'Chief Data Officer', 'VP Data', 'Director of IT', 'COO'],
    approved: false,
    cases: [],
  },
  {
    slug: 'gtm-audit-pilot',
    name: '30-Day GTM Audit and Pilot',
    practice: 'ai-marketing-studio',
    promise: 'A 30-day go-to-market audit and one live pilot (account-based campaigns, AI content or attribution) aimed at the growth mandate you already have.',
    priceMinCents: 1_500_000,
    priceMaxCents: 3_500_000,
    targetTitles: ['CMO', 'VP Marketing', 'VP Growth', 'Head of Demand Generation', 'CEO'],
    approved: false,
    cases: [],
  },
];

/** Case studies from the v1 seed, none public yet. Each offer's `cases` names them by client. */
export const TAAZAA_CASE_STUDIES = [
  { title: 'AI-assisted dispatch for non-emergency medical transport', clientName: 'Tobi', industry: 'Transportation and healthcare services', result: '32% more revenue and 100% on-time trips.', linkUrl: null },
  { title: 'AI document processing for payment cycles', clientName: 'Safeguard AI', industry: 'Financial services', result: '80% less processing time at 98% accuracy.', linkUrl: null },
  { title: 'Legal intake and document abstraction', clientName: 'Snapform', industry: 'Legal services', result: 'Intake from 3 hours to 45 minutes, with 60 to 80% less paralegal time.', linkUrl: null },
  { title: 'AI trading coach with deterministic metrics', clientName: 'Taurex', industry: 'Financial services', result: 'Responses from 148 to 22 seconds, 88% fewer tokens per request, 95% of 75,523 load-test requests under 650 ms.', linkUrl: 'https://www.taazaa.com/success-story/ai-trading-coach-gives-taurex-a-competitive-moat' },
  { title: 'Clinical AI assistant hospital clinicians can trust', clientName: 'MediPulse AI', industry: 'Healthcare services', result: 'Clinician-facing assistant with layered retrieval and per-user memory. Outcome metrics still to confirm.', linkUrl: 'https://www.taazaa.com/success-story/medipulse-ai-streamlines-healthcare-workflows-for-hospitals' },
  { title: 'AI tax assistant', clientName: 'Civi', industry: 'Professional services', result: 'AI assistant for tax workflows. Outcome metrics still to confirm.', linkUrl: null },
];

/**
 * Loads Taazaa's catalogue into the tenant. Matches by slug (practices, offers) or client name (case
 * studies), so a rerun adds what is missing and leaves anything a person has edited alone.
 */
export async function seedOffers(ctx: ModuleContext): Promise<void> {
  const practiceIds = new Map<string, string>();
  for (const [i, p] of TAAZAA_PRACTICES.entries()) {
    const [have] = await ctx.tx
      .select({ id: practice.id })
      .from(practice)
      .where(and(eq(practice.tenantId, ctx.tenantId), eq(practice.slug, p.slug)));
    practiceIds.set(p.slug, have?.id ?? (await createPractice(ctx, { ...p, sort: i })).id);
  }

  const caseIds = new Map<string, string>();
  for (const c of TAAZAA_CASE_STUDIES) {
    const [have] = await ctx.tx
      .select({ id: caseStudy.id })
      .from(caseStudy)
      .where(and(eq(caseStudy.tenantId, ctx.tenantId), eq(caseStudy.clientName, c.clientName)));
    caseIds.set(c.clientName, have?.id ?? (await createCaseStudy(ctx, { ...c, public: false })).id);
  }

  for (const { practice: practiceSlug, approved, cases, ...fields } of TAAZAA_OFFERS) {
    const [have] = await ctx.tx
      .select({ id: offer.id })
      .from(offer)
      .where(and(eq(offer.tenantId, ctx.tenantId), eq(offer.slug, fields.slug)));
    let id = have?.id;
    if (!id) {
      id = (await createOffer(ctx, { ...fields, practiceId: practiceIds.get(practiceSlug)! })).id;
      if (approved) {
        await ctx.tx
          .update(offer)
          .set({ status: 'approved', approvedBy: ctx.actor.id, approvedAt: new Date() })
          .where(eq(offer.id, id));
      }
    }
    await seedSignalRules(ctx, id, fields.slug);
    for (const client of cases) await linkCaseStudy(ctx, id, caseIds.get(client)!);
  }
}
