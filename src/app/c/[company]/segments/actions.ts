"use server";

import { authorize, getCompanyContext } from "@/server/context";
import { act, list, num, str, type ActionResult } from "@/server/action";
import { addManualSegment, generateSegments, ManualSegmentInput, overrideFactor, setSegmentStatus } from "@/server/segments";
import { getSettings } from "@/server/settings";
import { FACTOR_KEYS, type FactorKey, type Weights } from "@/lib/scoring";
import { isSegmentStatus, MANUAL_FACTORS, moveNeeds, type SegmentStatusKey } from "./labels";

const paths = (slug: string) => [`/c/${slug}/segments`, `/c/${slug}/tests`];

const isFactor = (k: string): k is FactorKey => (FACTOR_KEYS as readonly string[]).includes(k);

export async function generateSegmentsAction(slug: string, offeringId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "segment.generate");
      const ids = await generateSegments(ctx, offeringId);
      return { count: ids.length };
    },
    { revalidate: paths(slug), message: "Segments updated." },
  );
}

export async function addManualSegmentAction(slug: string, offeringId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "segment.generate");
      const offering = await ctx.db.offering.findUniqueOrThrow({ where: { id: offeringId } });
      if (offering.status !== "APPROVED") throw new Error("Approve the offering before adding segments.");
      const factors: Record<string, number> = {};
      for (const k of MANUAL_FACTORS) {
        const v = num(fd, k);
        if (v == null || v < 0 || v > 10) throw new Error("Rate every factor from 0 to 10.");
        factors[k] = v;
      }
      const input = ManualSegmentInput.parse({
        buyer: str(fd, "buyer"),
        problem: str(fd, "problem"),
        industry: str(fd, "industry"),
        keywords: list(fd, "keywords"),
        expectedDealDollars: num(fd, "expectedDeal"),
        ...factors,
      });
      return addManualSegment(ctx, offering.id, input);
    },
    { revalidate: paths(slug), message: "Segment added and scored." },
  );
}

export async function setSegmentStatusAction(slug: string, segmentId: string, status: SegmentStatusKey, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      if (!isSegmentStatus(status)) throw new Error("Unknown status.");
      const base = await getCompanyContext(slug);
      const seg = await base.db.segment.findUniqueOrThrow({ where: { id: segmentId } });
      const ctx = await authorize(slug, moveNeeds(seg.status, status));
      await setSegmentStatus(ctx, seg.id, status);
    },
    { revalidate: paths(slug) },
  );
}

export async function overrideFactorAction(slug: string, segmentId: string, factor: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "segment.override");
      if (!isFactor(factor)) throw new Error("Unknown factor.");
      const value = num(fd, "value");
      if (value == null || value < 0 || value > 10) throw new Error("Enter a value from 0 to 10.");
      const note = str(fd, "note");
      await overrideFactor(ctx, segmentId, factor, value, note || undefined);
    },
    { revalidate: paths(slug), message: "Override saved." },
  );
}

export async function clearOverrideAction(slug: string, segmentId: string, factor: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "segment.override");
      if (!isFactor(factor)) throw new Error("Unknown factor.");
      await overrideFactor(ctx, segmentId, factor, null);
    },
    { revalidate: paths(slug) },
  );
}

/** Saves the weights being tried on the segments page as the company's scoring weights. */
export async function saveWeightsAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "settings.edit");
      const weights = {} as Weights;
      for (const k of FACTOR_KEYS) {
        const v = num(fd, `w_${k}`) ?? 0;
        if (v < 0) throw new Error("Weights can't be negative.");
        weights[k] = Math.round(v * 10) / 10;
      }
      const total = Math.round(FACTOR_KEYS.reduce((s, k) => s + weights[k], 0) * 10) / 10;
      if (total !== 100) throw new Error(`Company weights must add up to 100. These add up to ${total}.`);
      const settings = await getSettings(ctx.db);
      await ctx.db.settings.update({ where: { id: settings.id }, data: { weights } });
    },
    { revalidate: [...paths(slug), `/c/${slug}/settings`], message: "Saved as company weights." },
  );
}
