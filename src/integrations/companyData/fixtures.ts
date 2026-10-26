// Fictional companies used by the seed and the "simulate a form fill" tool. Each one is shaped to
// exercise a specific validation path. None of these are real companies.

import type { CompanyProfile } from "./index";

type Known = Omit<CompanyProfile, "domain">;
const M = 1_000_000 * 100; // one million dollars in cents

export const KNOWN_COMPANIES: Record<string, Known> = {
  "keystone-ridge-properties.com": { name: "Keystone Ridge Properties", employees: 640, revenueCents: 180 * M, industry: "Commercial real estate", hq: "Charlotte, NC", description: "Owner-operator of 40 suburban office and flex buildings across the Carolinas. Leasing and maintenance run on spreadsheets and an aging Yardi instance." },
  "brightwater-residential.com": { name: "Brightwater Residential", employees: 1150, revenueCents: 310 * M, industry: "Property management", hq: "Atlanta, GA", description: "Manages 22,000 multifamily units for institutional owners. Growing through acquisition; reporting is stitched together by hand each month." },
  "cedarline-health.com": { name: "Cedarline Health Partners", employees: 900, revenueCents: 140 * M, industry: "Healthcare services", hq: "Raleigh, NC", description: "Regional network of outpatient clinics. Prior authorization and intake are mostly manual; leadership wants AI but compliance is nervous." },
  "northgate-freight.com": { name: "Northgate Freight", employees: 420, revenueCents: 95 * M, industry: "Logistics", hq: "Columbus, OH", description: "Regional LTL carrier. Dispatch runs on a 15-year-old Access database maintained by one person who is retiring." },
  "summit-legal-group.com": { name: "Summit Legal Group", employees: 260, revenueCents: 62 * M, industry: "Legal services", hq: "Denver, CO", description: "Plaintiff-side firm with heavy document intake. Paralegals spend hours per matter on intake and abstraction." },
  "tinyshop-studio.com": { name: "Tinyshop Studio", employees: 9, revenueCents: 1 * M, industry: "Retail", hq: "Austin, TX", description: "Two-person e-commerce studio." },
  "orbit-casino-games.com": { name: "Orbit Casino Games", employees: 700, revenueCents: 200 * M, industry: "Gambling", hq: "Las Vegas, NV", description: "Online casino operator." },
  "harborpoint-logistics.com": { name: "Harborpoint Logistics", employees: 800, revenueCents: 160 * M, industry: "Logistics", hq: "Savannah, GA", description: "Existing Taazaa client (fictional)." },
  "lumenvale-health.com": { name: "Lumenvale Health", employees: 1300, revenueCents: 260 * M, industry: "Healthcare services", hq: "Nashville, TN", description: "Has an open opportunity (fictional)." },
  "quietwater-partners.com": { name: "Quietwater Partners", employees: 380, revenueCents: null, industry: null, hq: null, description: null },
};

/** Domains the mock CRM treats as existing customers or open deals. */
export const MOCK_CRM = {
  customers: { "harborpoint-logistics.com": "Customer since 2023, Modernization Release 2." },
  openDeals: { "lumenvale-health.com": "Open deal: AgentReady Diagnostic, stage Proposal." },
} as const;
