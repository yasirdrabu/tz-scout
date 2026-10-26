// Mock ad channel. Results are deterministic per ad set and grow over the (compressed) test
// window: MOCK_AD_TEST_SECONDS real seconds stand in for the batch duration.

import { between, rng } from "@/lib/rand";
import { mockSeconds } from "../mode";
import type { AdChannelAdapter, AdSetResult, DailyStats } from "./types";

type Profile = { cpmCents: [number, number]; ctr: [number, number] };

export function createMockChannel(channel: "meta" | "linkedin"): AdChannelAdapter {
  // Always-on campaign spend (scorecard) vs small test ad sets, which run on broad audiences and
  // buy cheaper impressions so $300 across 12 to 15 statements can reach 1,000 impressions each.
  const profile: Profile = channel === "meta" ? { cpmCents: [1800, 4200], ctr: [0.004, 0.022] } : { cpmCents: [3500, 9000], ctr: [0.003, 0.012] };
  const testCpm: [number, number] = channel === "meta" ? [900, 2600] : [2500, 6000];

  return {
    channel,
    mode: "mock",
    async launchTest(input) {
      await new Promise((r) => setTimeout(r, 300));
      return { adSets: input.statements.map((s) => ({ statementId: s.statementId, externalId: `${channel}_mock_${s.statementId}` })) };
    },

    async getResults(externalIds, ctx) {
      const elapsed = (Date.now() - ctx.launchedAt.getTime()) / 1000;
      const progress = Math.max(0, Math.min(1, elapsed / mockSeconds()));
      const perSetBudget = ctx.budgetCents / Math.max(1, ctx.adSetCount);
      return externalIds.map((id): AdSetResult => {
        const r = rng(id);
        // Some ad sets under-deliver so "not enough data" shows up in real use too.
        const delivery = r() < 0.12 ? between(r, 0.15, 0.4) : between(r, 0.85, 1);
        const cpm = between(r, testCpm[0], testCpm[1]);
        const ctr = between(r, profile.ctr[0], profile.ctr[1]);
        const spendCents = Math.round(perSetBudget * delivery * progress);
        const impressions = Math.round((spendCents / cpm) * 1000);
        const clicks = Math.round(impressions * ctr);
        return { externalId: id, impressions, clicks, spendCents, complete: progress >= 1 };
      });
    },

    async getDailyStats(companyKey, from, to) {
      const out: DailyStats[] = [];
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        const r = rng(`${channel}:${companyKey}:${date}`);
        const dow = d.getUTCDay();
        const weekend = dow === 0 || dow === 6;
        const spendCents = Math.round(between(r, 38000, 62000) * (weekend ? 0.6 : 1));
        const cpm = between(r, profile.cpmCents[0], profile.cpmCents[1]);
        const impressions = Math.round((spendCents / cpm) * 1000);
        const clicks = Math.round(impressions * between(r, profile.ctr[0], profile.ctr[1]));
        out.push({ date, spendCents, impressions, clicks });
      }
      return out;
    },

    async sendConversion() {
      return { accepted: true };
    },
  };
}
