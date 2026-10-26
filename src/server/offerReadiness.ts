// Offer readiness: measure the market half from our accounts, judge the offer half, keep overrides.

import { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { runAi } from "@/ai/run";
import { offerJudgementTask } from "@/ai/offerReadiness";
import { modeOf } from "@/integrations/mode";
import { money } from "@/lib/format";
import { combineReadiness, measuredFactors, READINESS_FACTORS, type Readiness, type ReadinessFacts } from "@/lib/offerReadiness";
import { audit } from "./audit";

/** Wins per offering slug from the latest win analysis, if one has been run. */
async function winsFor(db: ScopedDb, slug: string): Promise<number | null> {
  const latest = await db.winAnalysis.findFirst({ orderBy: { createdAt: "desc" } });
  if (!latest) return null;
  const byOffer = (latest.findings as { winsByOffer?: Record<string, number> } | null)?.winsByOffer ?? {};
  return byOffer[slug] ?? 0;
}

export async function readinessFacts(db: ScopedDb, offeringId: string): Promise<ReadinessFacts> {
  const o = await db.offering.findUniqueOrThrow({ where: { id: offeringId }, include: { _count: { select: { caseStudies: true } } } });
  const matched = await db.account.findMany({ where: { bestOfferingId: offeringId, tier: { in: ["act_now", "good_fit"] } }, select: { tier: true, _count: { select: { contacts: true } } } });
  return {
    caseStudies: o._count.caseStudies,
    proofPoints: o.proofPoints.length,
    priceMinCents: o.priceMinCents,
    matchedAccounts: matched.length,
    actNow: matched.filter((a) => a.tier === "act_now").length,
    withBuyer: matched.filter((a) => a._count.contacts > 0).length,
    wins: await winsFor(db, o.slug),
  };
}

/** Score one offer and store it. Overrides set by hand survive a rescore. */
export async function scoreOffer(db: ScopedDb, companyId: string, offeringId: string, now = new Date()): Promise<Readiness> {
  const o = await db.offering.findUniqueOrThrow({ where: { id: offeringId }, include: { caseStudies: { include: { caseStudy: true } } } });
  const facts = await readinessFacts(db, offeringId);
  const price = o.priceMinCents != null ? (o.priceMaxCents && o.priceMaxCents !== o.priceMinCents ? `${money(o.priceMinCents)} to ${money(o.priceMaxCents)}` : money(o.priceMinCents)) : null;
  const { output } = await runAi(db, companyId, offerJudgementTask, {
    name: o.name,
    promise: o.promise,
    price,
    salesCycleDays: o.salesCycleDays,
    targetTitles: o.targetTitles,
    industries: o.industries,
    proofPoints: o.proofPoints,
    caseStudies: o.caseStudies.map((c) => `${c.caseStudy.title} (${c.caseStudy.client}): ${c.caseStudy.result}`),
  });
  const source = modeOf("anthropic") === "live" ? ("ai" as const) : ("rules" as const);
  const judged = Object.fromEntries((["outcome", "speed", "risk", "deliverable", "different"] as const).map((k) => [k, { ...output[k], source }]));
  const previous = o.readiness as Readiness | null;
  const overrides = Object.fromEntries((previous?.factors ?? []).filter((f) => f.override).map((f) => [f.key, f.override!]));
  const r = combineReadiness(judged, measuredFactors(facts), overrides, output.fixes, now);
  await db.offering.update({ where: { id: offeringId }, data: { readiness: r as unknown as Prisma.InputJsonValue, readinessAt: now } });
  return r;
}

export async function scoreAllOffers(db: ScopedDb, companyId: string) {
  const offers = await db.offering.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true } });
  for (const o of offers) await scoreOffer(db, companyId, o.id);
  return offers.length;
}

/** Set (or clear, with null) one factor by hand. The reason is kept for the record. */
export async function setReadinessOverride(ctx: CompanyContext, offeringId: string, key: string, value: number | null, note: string | null) {
  if (!READINESS_FACTORS.some((f) => f.key === key)) throw new Error("Unknown factor.");
  if (value != null && (value < 0 || value > 10)) throw new Error("Use a value from 0 to 10.");
  const o = await ctx.db.offering.findUniqueOrThrow({ where: { id: offeringId } });
  const r = o.readiness as Readiness | null;
  if (!r) throw new Error("Score the offer first.");
  const isMeasured = (k: string) => !!READINESS_FACTORS.find((d) => d.key === k)?.measured;
  const judged = Object.fromEntries(r.factors.filter((f) => !isMeasured(f.key)).map((f) => [f.key, { value: f.base, reason: f.reason, source: f.baseSource }]));
  const measured = Object.fromEntries(r.factors.filter((f) => isMeasured(f.key)).map((f) => [f.key, { value: f.base, reason: f.reason }]));
  const overrides = Object.fromEntries(r.factors.filter((f) => f.override && f.key !== key).map((f) => [f.key, f.override!]));
  if (value != null) overrides[key] = { value, note };
  const next = combineReadiness(judged, measured, overrides, r.fixes.filter((x) => !READINESS_FACTORS.some((d) => x.startsWith(`${d.label}:`))));
  await ctx.db.offering.update({ where: { id: offeringId }, data: { readiness: next as unknown as Prisma.InputJsonValue } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "offering.readinessOverride", entity: "offering", entityId: offeringId, data: { key, value, note } });
}
