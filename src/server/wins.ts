// Win analysis: read our closed-won deals from HubSpot, compute the hard numbers, have Claude read
// the patterns, and feed it back: offer readiness (wins) and suggested buying-signal rules.

import { Prisma } from "@prisma/client";
import type { CompanyContext } from "./context";
import { adapters } from "@/integrations";
import { runAi } from "@/ai/run";
import { winAnalysisTask, type WinFindings } from "@/ai/winAnalysis";
import { winStats, type WinStats } from "@/lib/wins";
import { money } from "@/lib/format";
import { rulesFor, saveSignalRules } from "./buyers";
import { scoreAllOffers } from "./offerReadiness";
import { audit } from "./audit";

export type StoredWinFindings = Omit<WinFindings, "winsByOffer"> & { winsByOffer: Record<string, number>; winsByOfferList: WinFindings["winsByOffer"]; stats: WinStats; appliedRules?: number[] };

export async function runWinAnalysis(ctx: CompanyContext) {
  const hs = adapters(ctx.db, ctx.company.id).hubspot;
  const deals = await hs.listWonDeals(200);
  if (!deals.length) throw new Error("No closed-won deals found in HubSpot.");
  const stats = winStats(deals);
  const offers = await ctx.db.offering.findMany({ where: { status: { not: "ARCHIVED" } }, select: { slug: true, name: true, promise: true } });
  const cycle = (d: (typeof deals)[number]) => (d.closedAt && d.createdAt ? `${Math.max(0, Math.round((new Date(d.closedAt).getTime() - new Date(d.createdAt).getTime()) / 86400_000))} days` : "cycle unknown");
  const { output, runId } = await runAi(ctx.db, ctx.company.id, winAnalysisTask, {
    stats: [
      `${stats.deals} won deals, ${money(stats.totalCents)} total, median ${stats.medianCents != null ? money(stats.medianCents) : "unknown"}, median cycle ${stats.medianCycleDays ?? "unknown"} days.`,
      `Industries: ${stats.industries.map((x) => `${x.name} ${x.deals}`).join(", ") || "unknown"}`,
      `Sizes: ${stats.sizes.map((x) => `${x.band} ${x.deals}`).join(", ") || "unknown"}`,
      `Buyer functions: ${stats.titles.map((x) => `${x.title} ${x.deals}`).join(", ") || "unknown"}`,
    ].join("\n"),
    deals: deals.map((d) => `- ${d.name} | ${d.amountCents != null ? money(d.amountCents) : "amount unknown"} | ${cycle(d)} | ${d.company ? `${d.company.name ?? "?"}, ${d.company.industry ?? "industry ?"}, ${d.company.employees ?? "?"} employees` : "no company"} | buyers: ${d.buyerTitles.join(", ") || "none on file"}${d.description ? ` | ${d.description.slice(0, 200)}` : ""}`),
    offers,
    raw: deals.map((d) => ({ name: d.name, description: d.description })),
  });
  const findings: StoredWinFindings = { ...output, winsByOffer: Object.fromEntries(output.winsByOffer.map((w) => [w.offerSlug, w.wins])), winsByOfferList: output.winsByOffer, stats };
  const a = await ctx.db.winAnalysis.create({ data: { companyId: ctx.company.id, source: hs.mode === "live" ? "hubspot" : "sample", dealCount: deals.length, deals: deals as unknown as Prisma.InputJsonValue, findings: findings as unknown as Prisma.InputJsonValue, aiRunId: runId, createdBy: ctx.user.name } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "wins.analyze", entity: "winAnalysis", entityId: a.id, data: { deals: deals.length } });
  // Wins feed the offers' readiness ("Wins like it").
  await scoreAllOffers(ctx.db, ctx.company.id).catch((e) => console.error("[wins] rescore failed", (e as Error).message));
  return a.id;
}

/** Add one suggested rule to its offer's buying signals. */
export async function applyRuleSuggestion(ctx: CompanyContext, analysisId: string, index: number) {
  const a = await ctx.db.winAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
  const f = a.findings as unknown as StoredWinFindings;
  const s = f.ruleSuggestions[index];
  if (!s) throw new Error("That suggestion no longer exists.");
  const o = await ctx.db.offering.findFirst({ where: { slug: s.offerSlug } });
  if (!o) throw new Error("That offer no longer exists.");
  const rules = rulesFor(o);
  const id = `win-${analysisId.slice(-6)}-${index}`;
  if (!rules.some((r) => r.id === id)) {
    await saveSignalRules(ctx, o.id, [...rules, { id, type: s.type, label: s.label, weight: s.type === "intent" ? 30 : 20, match: s.keywords, why: s.why, ...(s.type === "intent" ? { min: 0.6 } : {}) }]);
  }
  await ctx.db.winAnalysis.update({ where: { id: analysisId }, data: { findings: { ...f, appliedRules: [...new Set([...(f.appliedRules ?? []), index])] } as unknown as Prisma.InputJsonValue } });
}
