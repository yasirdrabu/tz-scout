// LinkedIn: ad channel (optional) plus audience size for segment enrichment.

import { between, rng } from "@/lib/rand";
import { modeOf, NotConnectedError, requireEnv } from "../mode";
import { createMockChannel } from "../ads/mockChannel";
import type { AdChannelAdapter } from "../ads/types";

export type AudienceQuery = { titles: string[]; industries: string[]; companySizeMin?: number | null; companySizeMax?: number | null; regions: string[]; key: string };

export interface LinkedInAdapter {
  readonly mode: "mock" | "live";
  channel(): AdChannelAdapter;
  audienceSize(q: AudienceQuery): Promise<number>;
}

const mock: LinkedInAdapter = {
  mode: "mock",
  channel: () => createMockChannel("linkedin"),
  async audienceSize(q) {
    const r = rng(`li:${q.key}`);
    // Narrow title sets and small company bands shrink the audience.
    const titleFactor = Math.min(1, 0.35 + q.titles.length * 0.15);
    const sizeFactor = q.companySizeMax && q.companySizeMax <= 1000 ? 0.6 : 1;
    const base = between(r, 18000, 420000);
    return Math.round(base * titleFactor * sizeFactor);
  },
};

const live: LinkedInAdapter = {
  mode: "live",
  channel() {
    requireEnv("linkedin", "LINKEDIN_ACCESS_TOKEN");
    throw new NotConnectedError("linkedin", "live LinkedIn adapter waits on API approval (milestone 10)");
  },
  async audienceSize() {
    requireEnv("linkedin", "LINKEDIN_ACCESS_TOKEN");
    throw new NotConnectedError("linkedin", "live LinkedIn adapter waits on API approval (milestone 10)");
  },
};

export function linkedinAdapter(): LinkedInAdapter {
  return modeOf("linkedin") === "live" ? live : mock;
}
