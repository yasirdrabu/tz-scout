"use server";

import { authorize } from "@/server/context";
import { act, optStr, str, type ActionResult } from "@/server/action";
import { deleteScenario, FunnelInputsSchema, saveScenario } from "@/server/funnel";

const path = (slug: string) => `/c/${slug}/funnel`;

/** Save the editor's inputs as a new scenario, or update the loaded one (mode=update). */
export async function saveScenarioAction(slug: string, offeringId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "funnel.edit");
      const name = str(fd, "name");
      if (!name) throw new Error("Give the scenario a name.");
      let raw: unknown;
      try {
        raw = JSON.parse(str(fd, "inputs"));
      } catch {
        throw new Error("The funnel inputs could not be read. Refresh the page and try again.");
      }
      const inputs = FunnelInputsSchema.parse(raw);
      const id = str(fd, "mode") === "update" ? optStr(fd, "scenarioId") : null;
      if (id) {
        const existing = await ctx.db.funnelScenario.findUniqueOrThrow({ where: { id } });
        if (existing.offeringId !== offeringId) throw new Error("That scenario belongs to another offering.");
      }
      return saveScenario(ctx, offeringId, name, inputs, id);
    },
    { revalidate: path(slug), message: "Scenario saved." },
  );
}

export async function deleteScenarioAction(slug: string, id: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "funnel.edit");
      await deleteScenario(ctx, id);
    },
    { revalidate: path(slug) },
  );
}
