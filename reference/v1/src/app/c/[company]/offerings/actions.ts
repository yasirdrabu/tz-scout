"use server";

import { authorize } from "@/server/context";
import { act, cents, list, num, optStr, rate, str, type ActionResult } from "@/server/action";
import { CaseStudyInput, deleteCaseStudy, draftOffering, OfferingInput, saveCaseStudy, saveOffering, setOfferingStatus } from "@/server/offerings";
import { textFromFile, textFromUrl } from "@/lib/extract";
import { scoreAllOffers, scoreOffer, setReadinessOverride } from "@/server/offerReadiness";

const path = (slug: string) => `/c/${slug}/offerings`;

function parseOffering(fd: FormData) {
  const revMin = num(fd, "revenueMinM");
  const revMax = num(fd, "revenueMaxM");
  return OfferingInput.parse({
    name: str(fd, "name"),
    promise: str(fd, "promise"),
    priceMinCents: cents(fd, "priceMin"),
    priceMaxCents: cents(fd, "priceMax"),
    grossMargin: rate(fd, "grossMargin"),
    dealSizeCents: cents(fd, "dealSize"),
    salesCycleDays: num(fd, "salesCycleDays"),
    targetTitles: list(fd, "targetTitles"),
    companySizeMin: num(fd, "companySizeMin"),
    companySizeMax: num(fd, "companySizeMax"),
    revenueMinCents: revMin == null ? null : revMin * 100_000_000,
    revenueMaxCents: revMax == null ? null : revMax * 100_000_000,
    industries: list(fd, "industries"),
    regions: list(fd, "regions"),
    excludedDomains: list(fd, "excludedDomains"),
    excludedCategories: list(fd, "excludedCategories"),
    proofPoints: list(fd, "proofPoints"),
    timelineWindowDays: num(fd, "timelineWindowDays") ?? 180,
    caseStudyIds: fd.getAll("caseStudyIds").map(String),
  });
}

export async function saveOfferingAction(slug: string, id: string | null, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      return saveOffering(ctx, id, parseOffering(fd));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

export async function setOfferingStatusAction(slug: string, id: string, status: "APPROVED" | "ARCHIVED" | "DRAFT", _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, status === "APPROVED" ? "offering.approve" : "offering.edit");
      await setOfferingStatus(ctx, id, status);
    },
    { revalidate: path(slug) },
  );
}

/** AI draft from a URL or uploaded file. Returns the draft for the form to apply; nothing is saved as approved. */
export async function draftOfferingAction(slug: string, offeringId: string | null, _prev: ActionResult | null, fd: FormData) {
  return act(async () => {
    const ctx = await authorize(slug, "offering.edit");
    const url = str(fd, "url");
    const file = fd.get("file");
    let text = "";
    let label = "";
    if (file instanceof File && file.size > 0) {
      text = await textFromFile(file);
      label = file.name;
    } else if (url) {
      text = await textFromUrl(url);
      label = url;
    } else {
      throw new Error("Paste a web address or choose a file.");
    }
    return draftOffering(ctx, { text, label, offeringId, offeringName: optStr(fd, "name") ?? undefined });
  });
}

export async function saveCaseStudyAction(slug: string, id: string | null, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      return saveCaseStudy(ctx, id, CaseStudyInput.parse({ title: str(fd, "title"), client: str(fd, "client"), industry: str(fd, "industry"), result: str(fd, "result"), link: str(fd, "link") }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

export async function deleteCaseStudyAction(slug: string, id: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      await deleteCaseStudy(ctx, id);
    },
    { revalidate: path(slug) },
  );
}

// ---------- Offer readiness ----------

export async function scoreOfferAction(slug: string, offeringId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      await scoreOffer(ctx.db, ctx.company.id, offeringId);
    },
    { revalidate: path(slug), message: "Offer scored." },
  );
}

export async function scoreAllOffersAction(slug: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      await scoreAllOffers(ctx.db, ctx.company.id);
    },
    { revalidate: path(slug), message: "All offers scored." },
  );
}

export async function setReadinessOverrideAction(slug: string, offeringId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "offering.edit");
      const key = str(fd, "key");
      const raw = str(fd, "value");
      await setReadinessOverride(ctx, offeringId, key, raw === "" || raw === "clear" ? null : Number(raw), optStr(fd, "note"));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}
