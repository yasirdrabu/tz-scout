// Module 1: offerings and case studies.

import { z } from "zod";
import type { CompanyContext } from "./context";
import type { ScopedDb } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { runAi } from "@/ai/run";
import { offeringDraftTask, type OfferingDraft } from "@/ai/offeringDraft";
import { audit } from "./audit";

const list = z.array(z.string().trim().min(1)).default([]);
const optInt = z.number().int().nonnegative().nullable().default(null);

export const OfferingInput = z.object({
  name: z.string().trim().min(2, "Give the offering a name."),
  promise: z.string().trim().max(240).default(""),
  priceMinCents: optInt,
  priceMaxCents: optInt,
  grossMargin: z.number().min(0).max(1).nullable().default(null),
  dealSizeCents: optInt,
  salesCycleDays: optInt,
  targetTitles: list,
  companySizeMin: optInt,
  companySizeMax: optInt,
  revenueMinCents: z.number().nonnegative().nullable().default(null),
  revenueMaxCents: z.number().nonnegative().nullable().default(null),
  industries: list,
  regions: list,
  excludedDomains: list,
  excludedCategories: list,
  proofPoints: list,
  timelineWindowDays: z.number().int().positive().default(180),
  caseStudyIds: z.array(z.string()).default([]),
});
export type OfferingInputT = z.infer<typeof OfferingInput>;

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "offering";

export async function listOfferings(db: ScopedDb, opts: { includeArchived?: boolean } = {}) {
  const rows = await db.offering.findMany({
    where: opts.includeArchived ? {} : { status: { not: "ARCHIVED" } },
    orderBy: { name: "asc" },
    include: { _count: { select: { segments: true, caseStudies: true, leads: true } } },
  });
  const order = { APPROVED: 0, DRAFT: 1, ARCHIVED: 2 } as const;
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

export async function getOffering(db: ScopedDb, id: string) {
  return db.offering.findUnique({ where: { id }, include: { caseStudies: { include: { caseStudy: true } } } });
}

export async function saveOffering(ctx: CompanyContext, id: string | null, input: OfferingInputT) {
  const { db, company, user } = ctx;
  const { caseStudyIds, revenueMinCents, revenueMaxCents, ...rest } = input;
  if (rest.priceMinCents != null && rest.priceMaxCents != null && rest.priceMinCents > rest.priceMaxCents) throw new Error("Price minimum is above the maximum.");
  if (rest.companySizeMin != null && rest.companySizeMax != null && rest.companySizeMin > rest.companySizeMax) throw new Error("Company size minimum is above the maximum.");
  const data = {
    ...rest,
    revenueMinCents: revenueMinCents == null ? null : BigInt(Math.round(revenueMinCents)),
    revenueMaxCents: revenueMaxCents == null ? null : BigInt(Math.round(revenueMaxCents)),
  };

  // Case studies must belong to this company.
  const cs = caseStudyIds.length ? await db.caseStudy.findMany({ where: { id: { in: caseStudyIds } }, select: { id: true } }) : [];

  let offeringId: string;
  if (id) {
    const existing = await db.offering.findUniqueOrThrow({ where: { id } });
    // Editing an approved offering's buyer definition sends it back to draft for re-approval.
    const material = ["targetTitles", "industries", "companySizeMin", "companySizeMax", "promise"] as const;
    const changed = material.some((k) => JSON.stringify(existing[k]) !== JSON.stringify(data[k]));
    await db.offering.update({ where: { id }, data: { ...data, ...(existing.status === "APPROVED" && changed ? { status: "DRAFT", approvedAt: null, approvedById: null } : {}) } });
    offeringId = id;
  } else {
    let slug = slugify(data.name);
    if (await db.offering.findFirst({ where: { slug } })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const created = await db.offering.create({ data: { ...data, slug, companyId: company.id } });
    offeringId = created.id;
  }
  await db.offeringCaseStudy.deleteMany({ where: { offeringId, caseStudyId: { notIn: cs.map((c) => c.id) } } });
  for (const c of cs) {
    await db.offeringCaseStudy.upsert({ where: { offeringId_caseStudyId: { offeringId, caseStudyId: c.id } }, create: { companyId: company.id, offeringId, caseStudyId: c.id }, update: {} });
  }
  await audit(db, company.id, { userId: user.id, action: id ? "offering.update" : "offering.create", entity: "offering", entityId: offeringId });
  return offeringId;
}

export async function setOfferingStatus(ctx: CompanyContext, id: string, status: "APPROVED" | "ARCHIVED" | "DRAFT") {
  const { db, company, user } = ctx;
  const o = await db.offering.findUniqueOrThrow({ where: { id } });
  if (status === "APPROVED" && (!o.promise || o.targetTitles.length === 0)) throw new Error("Add a promise and at least one target title before approving.");
  await db.offering.update({
    where: { id },
    data: { status, ...(status === "APPROVED" ? { approvedAt: new Date(), approvedById: user.id } : status === "DRAFT" ? { approvedAt: null, approvedById: null } : {}) },
  });
  await audit(db, company.id, { userId: user.id, action: `offering.${status.toLowerCase()}`, entity: "offering", entityId: id });
}

export async function draftOffering(ctx: CompanyContext, source: { text: string; label: string; offeringId?: string | null; offeringName?: string }): Promise<OfferingDraft> {
  const { db, company } = ctx;
  if (source.text.trim().length < 80) throw new Error("Not enough text in that source to draft from. Try a different page or file.");
  const { output } = await runAi(db, company.id, offeringDraftTask, { sourceText: source.text, sourceLabel: source.label, offeringName: source.offeringName });
  if (source.offeringId) {
    await db.offering.update({ where: { id: source.offeringId }, data: { aiDraft: output as unknown as Prisma.InputJsonValue, sourceUrl: source.label.startsWith("http") ? source.label : undefined } });
  }
  return output;
}

// ---------- Case studies ----------

export const CaseStudyInput = z.object({
  title: z.string().trim().min(2),
  client: z.string().trim().min(1),
  industry: z.string().trim().min(1),
  result: z.string().trim().min(1),
  link: z.string().trim().url().or(z.literal("")).optional(),
});

export async function saveCaseStudy(ctx: CompanyContext, id: string | null, input: z.infer<typeof CaseStudyInput>) {
  const data = { ...input, link: input.link || null };
  if (id) {
    await ctx.db.caseStudy.update({ where: { id }, data });
    return id;
  }
  const c = await ctx.db.caseStudy.create({ data: { ...data, companyId: ctx.company.id } });
  return c.id;
}

export async function deleteCaseStudy(ctx: CompanyContext, id: string) {
  await ctx.db.caseStudy.delete({ where: { id } });
}

/** Case studies whose industry overlaps the given one. Used for segment proof and pre-call notes. */
export function matchesIndustry(caseIndustry: string, industry: string | null | undefined): boolean {
  if (!industry) return false;
  const a = caseIndustry.toLowerCase();
  const b = industry.toLowerCase();
  if (a.includes(b) || b.includes(a)) return true;
  const stop = new Set(["services", "and", "the", "of"]);
  const words = (s: string) => s.split(/[^a-z]+/).filter((w) => w.length > 3 && !stop.has(w));
  const bw = new Set(words(b));
  return words(a).some((w) => bw.has(w));
}
