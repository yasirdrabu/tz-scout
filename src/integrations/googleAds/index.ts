// Google Ads: keyword planner data (monthly searches, average cost per click) for segment enrichment.

import { between, rng } from "@/lib/rand";
import { modeOf, NotConnectedError, requireEnv } from "../mode";

export type KeywordMetrics = { monthlySearches: number; avgCpcCents: number; keywords: string[] };

export interface GoogleAdsAdapter {
  readonly mode: "mock" | "live";
  keywordMetrics(q: { key: string; keywords: string[] }): Promise<KeywordMetrics>;
}

const mock: GoogleAdsAdapter = {
  mode: "mock",
  async keywordMetrics(q) {
    const r = rng(`gads:${q.key}`);
    return {
      monthlySearches: Math.round(between(r, 300, 14000)),
      avgCpcCents: Math.round(between(r, 250, 1900)),
      keywords: q.keywords,
    };
  },
};

const live: GoogleAdsAdapter = {
  mode: "live",
  async keywordMetrics() {
    requireEnv("googleAds", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID");
    throw new NotConnectedError("googleAds", "live Google Ads adapter waits on API approval (milestone 10)");
  },
};

export function googleAdsAdapter(): GoogleAdsAdapter {
  return modeOf("googleAds") === "live" ? live : mock;
}
