"use server";

import { z } from "zod";
import { authorize } from "@/server/context";
import { act, str, type ActionResult } from "@/server/action";
import { addFix, buildWeeks, diagnoseWeek, editDiagnosis, syncConversions, toggleFix } from "@/server/scorecard";
import { audit } from "@/server/audit";

const path = (slug: string) => `/c/${slug}/scorecard`;

export async function rebuildWeeksAction(slug: string, fromIso: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "scorecard.edit");
      const from = new Date(`${fromIso}T00:00:00Z`);
      if (Number.isNaN(from.getTime())) throw new Error("That week range is not valid.");
      await buildWeeks(ctx.db, ctx.company.id, from, new Date());
      await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "scorecard.rebuild", entity: "week", data: { from: fromIso } });
    },
    { revalidate: path(slug), message: "Weeks rebuilt." },
  );
}

export async function diagnoseWeekAction(slug: string, weekId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "scorecard.edit");
      return diagnoseWeek(ctx.db, ctx.company.id, weekId);
    },
    { revalidate: path(slug), message: "Diagnosis updated." },
  );
}

const DiagnosisInput = z.object({
  bottleneck: z.string().trim().min(1, "Name the bottleneck.").max(500),
  cause: z.string().trim().min(1, "Describe the likely cause.").max(2000),
  summary: z.string().trim().min(1, "Write a short summary.").max(4000),
});

export async function editDiagnosisAction(slug: string, diagnosisId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "scorecard.edit");
      await editDiagnosis(ctx, diagnosisId, DiagnosisInput.parse({ bottleneck: str(fd, "bottleneck"), cause: str(fd, "cause"), summary: str(fd, "summary") }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

const FixInput = z.object({ text: z.string().trim().min(1, "Describe the fix.").max(500), ownerRole: z.enum(["Owner", "Operator", "Sales"]) });

export async function addFixAction(slug: string, diagnosisId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "scorecard.edit");
      // Load the parent through the scoped client so another company's id fails here.
      await ctx.db.diagnosis.findUniqueOrThrow({ where: { id: diagnosisId } });
      const f = FixInput.parse({ text: str(fd, "text"), ownerRole: str(fd, "ownerRole") });
      await addFix(ctx, diagnosisId, f.text, f.ownerRole);
    },
    { revalidate: path(slug) },
  );
}

export async function toggleFixAction(slug: string, fixId: string, done: boolean, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "fix.complete");
      await toggleFix(ctx, fixId, done);
    },
    { revalidate: path(slug) },
  );
}

export async function syncConversionsAction(slug: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "scorecard.edit");
      const sent = await syncConversions(ctx.db, ctx.company.id);
      return { sent };
    },
    { revalidate: path(slug), message: "Sent closed deals to the ad platform." },
  );
}
