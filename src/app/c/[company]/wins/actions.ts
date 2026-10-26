"use server";

import { authorize } from "@/server/context";
import { act, type ActionResult } from "@/server/action";
import { applyRuleSuggestion, runWinAnalysis } from "@/server/wins";

const path = (slug: string) => `/c/${slug}/wins`;

export async function runWinAnalysisAction(slug: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      await runWinAnalysis(ctx);
    },
    { revalidate: [path(slug), `/c/${slug}/offerings`], message: "Wins analyzed. Offer readiness was rescored with them." },
  );
}

export async function applyRuleSuggestionAction(slug: string, analysisId: string, index: number, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.rules");
      await applyRuleSuggestion(ctx, analysisId, index);
    },
    { revalidate: path(slug), message: "Rule added. Accounts are being rescored." },
  );
}
