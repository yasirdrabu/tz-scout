import type { Offering } from "@prisma/client";
import type { OfferingFormValues } from "./offering-form";

const s = (n: number | bigint | null | undefined, div = 1) => (n == null ? "" : String(Number(n) / div));

export function toFormValues(o: (Offering & { caseStudies?: { caseStudyId: string }[] }) | null): OfferingFormValues {
  return {
    name: o?.name ?? "",
    promise: o?.promise ?? "",
    priceMin: s(o?.priceMinCents, 100),
    priceMax: s(o?.priceMaxCents, 100),
    grossMargin: o?.grossMargin != null ? String(Math.round(o.grossMargin * 1000) / 10) : "",
    dealSize: s(o?.dealSizeCents, 100),
    salesCycleDays: s(o?.salesCycleDays),
    targetTitles: (o?.targetTitles ?? []).join(", "),
    companySizeMin: s(o?.companySizeMin),
    companySizeMax: s(o?.companySizeMax),
    revenueMinM: s(o?.revenueMinCents, 100_000_000),
    revenueMaxM: s(o?.revenueMaxCents, 100_000_000),
    industries: (o?.industries ?? []).join(", "),
    regions: (o?.regions ?? ["United States"]).join(", "),
    excludedDomains: (o?.excludedDomains ?? []).join(", "),
    excludedCategories: (o?.excludedCategories ?? []).join(", "),
    proofPoints: (o?.proofPoints ?? []).join("\n"),
    timelineWindowDays: s(o?.timelineWindowDays ?? 180),
    caseStudyIds: o?.caseStudies?.map((c) => c.caseStudyId) ?? [],
  };
}
