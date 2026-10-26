// Module 2: segment generation, enrichment, scoring, overrides and status.

import { z } from "zod";
import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { runAi } from "@/ai/run";
import { segmentsTask, type SegmentProposal } from "@/ai/segments";
import { adapters } from "@/integrations";
import { audienceRating, competitionRating, dealSizeRating, FACTOR_BY_KEY, FACTOR_KEYS, proofRating, rankSegments, scoreSegment, type FactorKey, type Weights } from "@/lib/scoring";
import { compact, money } from "@/lib/format";
import { getSettings } from "./settings";
import { matchesIndustry } from "./offerings";
import { audit } from "./audit";

type Proposal = SegmentProposal["segments"][number];
type FactorRow = { factor: FactorKey; value: number; reason: string };

/** Data factors from enrichment. */
async function enrich(
  db: ScopedDb,
  companyId: string,
  offering: { id: string; targetTitles: string[]; industries: string[]; regions: string[]; companySizeMin: number | null; companySizeMax: number | null; dealSizeCents: number | null },
  seg: { key: string; buyer: string; industry: string | null; keywords: string[]; expectedDealCents: number | null },
  currency: string,
) {
  const a = adapters(db, companyId);
  // LinkedIn and Google may not be connected yet; their numbers are then unknown rather than invented.
  const [audienceSize, kw, links] = await Promise.all([
    a.linkedin.audienceSize({ key: `${offering.id}:${seg.key}`, titles: offering.targetTitles, industries: seg.industry ? [seg.industry] : offering.industries, companySizeMin: offering.companySizeMin, companySizeMax: offering.companySizeMax, regions: offering.regions }).catch(() => null),
    a.googleAds.keywordMetrics({ key: `${offering.id}:${seg.key}`, keywords: seg.keywords }).catch(() => null),
    db.offeringCaseStudy.findMany({ where: { offeringId: offering.id }, include: { caseStudy: true } }),
  ]);
  const caseStudyCount = links.filter((l) => matchesIndustry(l.caseStudy.industry, seg.industry)).length;
  const factors: FactorRow[] = [
    { factor: "audience", value: audienceRating(audienceSize), reason: audienceSize != null ? `About ${compact(audienceSize)} people on LinkedIn match the titles and company filters.` : "LinkedIn isn't connected, so audience size is unknown." },
    { factor: "competition", value: competitionRating(kw?.avgCpcCents), reason: kw ? `Average cost per click ${money(kw.avgCpcCents, currency, { precise: true })} on ${kw.keywords.slice(0, 2).join(", ") || "related searches"}.` : "Google Ads isn't connected, so cost per click is unknown (scored as average)." },
    { factor: "proof", value: proofRating(caseStudyCount), reason: caseStudyCount ? `${caseStudyCount} case ${caseStudyCount === 1 ? "study matches" : "studies match"} this industry.` : "No matching case study yet." },
    {
      factor: "deal_size",
      value: dealSizeRating(seg.expectedDealCents, offering.dealSizeCents),
      reason: seg.expectedDealCents && offering.dealSizeCents ? `Likely first deal ${money(seg.expectedDealCents, currency, { compact: true })} against a target of ${money(offering.dealSizeCents, currency, { compact: true })}.` : "No target deal size on the offering.",
    },
  ];
  return { factors, audienceSize, searchVolume: kw?.monthlySearches ?? null, cpcCents: kw?.avgCpcCents ?? null, caseStudyCount };
}

async function upsertFactors(db: ScopedDb, companyId: string, segmentId: string, rows: FactorRow[]) {
  for (const r of rows) {
    const value = Math.max(0, Math.min(10, Math.round(r.value * 10) / 10));
    // Overrides are never touched here, so they survive regeneration.
    await db.segmentFactor.upsert({
      where: { segmentId_factor: { segmentId, factor: r.factor } },
      create: { companyId, segmentId, factor: r.factor, value, reason: r.reason },
      update: { value, reason: r.reason },
    });
  }
}

const aiFactors = (p: Proposal): FactorRow[] =>
  (["pain", "urgency", "ability_to_pay", "delivery_fit", "committee", "cycle"] as const).map((k) => ({ factor: k, value: p.factors[k].value, reason: p.factors[k].reason }));

export async function generateSegments(ctx: Pick<CompanyContext, "db" | "company"> & { user?: { id: string } }, offeringId: string, count = 10) {
  const { db, company } = ctx;
  const offering = await db.offering.findUniqueOrThrow({ where: { id: offeringId }, include: { caseStudies: { include: { caseStudy: true } }, segments: { select: { key: true } } } });
  if (offering.status !== "APPROVED") throw new Error("Approve the offering before generating segments.");
  const { output, runId } = await runAi(db, company.id, segmentsTask, {
    offeringSlug: offering.slug,
    offering: {
      name: offering.name,
      promise: offering.promise,
      targetTitles: offering.targetTitles,
      industries: offering.industries,
      dealSizeDollars: offering.dealSizeCents ? offering.dealSizeCents / 100 : null,
      companySize: `${offering.companySizeMin ?? "any"} to ${offering.companySizeMax ?? "any"} employees`,
      revenueBand: `${offering.revenueMinCents ? money(Number(offering.revenueMinCents), company.currency, { compact: true }) : "any"} to ${offering.revenueMaxCents ? money(Number(offering.revenueMaxCents), company.currency, { compact: true }) : "any"}`,
      salesCycleDays: offering.salesCycleDays,
    },
    caseStudies: offering.caseStudies.map((c) => ({ title: c.caseStudy.title, industry: c.caseStudy.industry, result: c.caseStudy.result })),
    count: Math.max(8, Math.min(12, count)),
    existingKeys: offering.segments.map((s) => s.key),
  });

  const ids: string[] = [];
  for (const p of output.segments) {
    const key = p.key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64);
    const name = `${p.buyer} ${p.problem}`.replace(/\s+/g, " ").trim();
    const seg = await db.segment.upsert({
      where: { offeringId_key: { offeringId, key } },
      create: { companyId: company.id, offeringId, key, name, buyer: p.buyer, problem: p.problem, industry: p.industry, origin: "AI" },
      update: { name, buyer: p.buyer, problem: p.problem, industry: p.industry },
    });
    const e = await enrich(db, company.id, offering, { key, buyer: p.buyer, industry: p.industry, keywords: p.keywords, expectedDealCents: Math.round(p.expectedDealDollars * 100) }, company.currency);
    await db.segment.update({ where: { id: seg.id }, data: { audienceSize: e.audienceSize, searchVolume: e.searchVolume, cpcCents: e.cpcCents, caseStudyCount: e.caseStudyCount } });
    await upsertFactors(db, company.id, seg.id, [...aiFactors(p), ...e.factors]);
    ids.push(seg.id);
  }
  await audit(db, company.id, { userId: ctx.user?.id, action: "segments.generate", entity: "offering", entityId: offeringId, data: { count: ids.length, aiRunId: runId } });
  return ids;
}

export const ManualSegmentInput = z.object({
  buyer: z.string().trim().min(3),
  problem: z.string().trim().min(3),
  industry: z.string().trim().min(2),
  keywords: z.array(z.string()).default([]),
  expectedDealDollars: z.number().nonnegative().nullable().default(null),
  pain: z.number().min(0).max(10),
  urgency: z.number().min(0).max(10),
  ability_to_pay: z.number().min(0).max(10),
  delivery_fit: z.number().min(0).max(10),
  committee: z.number().min(0).max(10),
  cycle: z.number().min(0).max(10),
});

export async function addManualSegment(ctx: CompanyContext, offeringId: string, input: z.infer<typeof ManualSegmentInput>) {
  const { db, company, user } = ctx;
  const offering = await db.offering.findUniqueOrThrow({ where: { id: offeringId } });
  const key = `manual-${input.buyer}-${input.industry}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 56) + "-" + Date.now().toString(36).slice(-4);
  const seg = await db.segment.create({ data: { companyId: company.id, offeringId, key, name: `${input.buyer} ${input.problem}`, buyer: input.buyer, problem: input.problem, industry: input.industry, origin: "MANUAL" } });
  const e = await enrich(db, company.id, offering, { key, buyer: input.buyer, industry: input.industry, keywords: input.keywords.length ? input.keywords : [input.problem], expectedDealCents: input.expectedDealDollars != null ? input.expectedDealDollars * 100 : offering.dealSizeCents }, company.currency);
  await db.segment.update({ where: { id: seg.id }, data: { audienceSize: e.audienceSize, searchVolume: e.searchVolume, cpcCents: e.cpcCents, caseStudyCount: e.caseStudyCount } });
  const manual = (["pain", "urgency", "ability_to_pay", "delivery_fit", "committee", "cycle"] as const).map((k) => ({ factor: k, value: input[k], reason: "Set by hand." }));
  await upsertFactors(db, company.id, seg.id, [...manual, ...e.factors]);
  await audit(db, company.id, { userId: user.id, action: "segment.create", entity: "segment", entityId: seg.id });
  return seg.id;
}

export async function overrideFactor(ctx: CompanyContext, segmentId: string, factor: FactorKey, value: number | null, note?: string) {
  const { db, company, user } = ctx;
  if (!FACTOR_KEYS.includes(factor)) throw new Error("Unknown factor.");
  const f = await db.segmentFactor.findUniqueOrThrow({ where: { segmentId_factor: { segmentId, factor } } });
  const v = value == null ? null : Math.max(0, Math.min(10, value));
  await db.segmentFactor.update({
    where: { id: f.id },
    data: v == null ? { overrideValue: null, overrideNote: null, overriddenBy: null, overriddenAt: null } : { overrideValue: v, overrideNote: note ?? null, overriddenBy: user.name, overriddenAt: new Date() },
  });
  await audit(db, company.id, { userId: user.id, action: v == null ? "segment.override.clear" : "segment.override", entity: "segment", entityId: segmentId, data: { factor, from: f.overrideValue ?? f.value, to: v ?? f.value, note } });
}

export async function setSegmentStatus(ctx: CompanyContext, segmentId: string, status: "PROPOSED" | "SHORTLISTED" | "ACTIVE" | "REJECTED") {
  const { db, company, user } = ctx;
  const seg = await db.segment.findUniqueOrThrow({ where: { id: segmentId } });
  if (status === "ACTIVE" && seg.status !== "ACTIVE") {
    const settings = await getSettings(db);
    const active = await db.segment.count({ where: { offeringId: seg.offeringId, status: "ACTIVE" } });
    if (active >= settings.maxActiveSegments) throw new Error(`Only ${settings.maxActiveSegments} segments can be active per offering. Pause one first.`);
  }
  await db.segment.update({ where: { id: segmentId }, data: { status } });
  await audit(db, company.id, { userId: user.id, action: `segment.${status.toLowerCase()}`, entity: "segment", entityId: segmentId });
}

export type RankedSegment = Awaited<ReturnType<typeof rankedSegments>>[number];

export async function rankedSegments(db: ScopedDb, offeringId: string, weights: Weights) {
  const segs = await db.segment.findMany({ where: { offeringId }, include: { factors: true, _count: { select: { batches: true } } } });
  return rankSegments(
    segs.map((s) => {
      const breakdown = scoreSegment(s.factors, weights);
      return { ...s, score: breakdown.total, breakdown };
    }),
  );
}

export function factorLabel(key: string) {
  return FACTOR_BY_KEY[key as FactorKey]?.label ?? key;
}
