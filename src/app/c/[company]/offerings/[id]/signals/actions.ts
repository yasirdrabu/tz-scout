"use server";

import { authorize } from "@/server/context";
import { act, str, type ActionResult } from "@/server/action";
import { saveSignalRules, SignalRulesSchema } from "@/server/buyers";
import { SIGNAL_TYPES, type SignalRule } from "@/lib/matching";

type RawRule = { id?: unknown; type?: unknown; label?: unknown; match?: unknown; weight?: unknown; min?: unknown };

/** Rules come from the editor as JSON. Check each with a plain message before the schema check. */
function parseRules(json: string): SignalRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The rules couldn't be read. Refresh the page and try again.");
  }
  if (!Array.isArray(raw)) throw new Error("The rules couldn't be read. Refresh the page and try again.");
  const rules = (raw as RawRule[]).map((r, i) => {
    const n = `Rule ${i + 1}`;
    const type = String(r.type);
    if (!(SIGNAL_TYPES as readonly string[]).includes(type)) throw new Error(`${n}: pick a signal type.`);
    const label = String(r.label ?? "").trim();
    if (!label) throw new Error(`${n}: give it a label.`);
    const weight = Number(r.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new Error(`${n} (${label}): points must be from 0 to 100.`);
    const match = Array.isArray(r.match) ? r.match.map((k) => String(k).trim()).filter(Boolean) : [];
    let min: number | undefined;
    if (type === "growth" && r.min != null && r.min !== "") {
      min = Number(r.min);
      if (!Number.isFinite(min) || min < 0 || min > 10) throw new Error(`${n} (${label}): enter the minimum growth as a percent, for example 10.`);
    }
    return { id: String(r.id || `rule-${i + 1}`), type: type as SignalRule["type"], label, match, weight, ...(min != null ? { min } : {}) };
  });
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) r.id = `${r.id}-${ids.size}`;
    ids.add(r.id);
  }
  return SignalRulesSchema.parse(rules);
}

export async function saveRulesAction(slug: string, offeringId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.rules");
      const rules = parseRules(str(fd, "rules"));
      if (rules.length === 0) throw new Error("Keep at least one rule, or reset to the starting rules.");
      await ctx.db.offering.findUniqueOrThrow({ where: { id: offeringId } });
      await saveSignalRules(ctx, offeringId, rules);
    },
    { revalidate: [`/c/${slug}/offerings`, `/c/${slug}/buyers`], message: "Saved. Rankings update in a few seconds." },
  );
}
