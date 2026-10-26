// Module 4: funnel defaults from history (ads, validation, HubSpot meetings and deals) and saved scenarios.

import { z } from "zod";
import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { Prisma } from "@prisma/client";
import { mergeRates, ratio, RATE_KEYS, type FunnelInputs, type FunnelRates } from "@/lib/funnel";
import { adapters } from "@/integrations";
import { addDays } from "@/lib/scorecard";
import { getSettings } from "./settings";

export type HistorySource = "ads" | "site" | "validation" | "hubspot";
export type History = { rates: Partial<FunnelRates>; samples: Partial<Record<keyof FunnelRates, number>>; days: number };

/** Rates over the last `days` days. A rate only counts when its sample is big enough to trust. */
export async function funnelHistory(db: ScopedDb, companyId: string, opts: { offeringId?: string | null; days?: number; now?: Date } = {}): Promise<History> {
  const days = opts.days ?? 90;
  const now = opts.now ?? new Date();
  const from = addDays(now, -days);
  const offeringFilter = opts.offeringId ? { offeringId: opts.offeringId } : {};

  const a = adapters(db, companyId);
  let spend = 0, impressions = 0, clicks = 0;
  try {
    const stats = await a.meta.getDailyStats(companyId, from, now);
    for (const s of stats) { spend += s.spendCents; impressions += s.impressions; clicks += s.clicks; }
  } catch {
    // Not connected: no ad history.
  }

  const [leads, validated, dBooked, dHeld, sBooked, sHeld, qualified, won] = await Promise.all([
    db.lead.count({ where: { submittedAt: { gte: from }, source: "inbound", ...offeringFilter } }),
    db.lead.count({ where: { submittedAt: { gte: from }, source: "inbound", ...offeringFilter, OR: [{ status: "VALIDATED", overrideStatus: null }, { overrideStatus: "VALIDATED" }] } }),
    db.meeting.count({ where: { type: "DISCOVERY", scheduledAt: { gte: from, lte: now }, status: { in: ["HELD", "NO_SHOW", "REBOOKED"] }, lead: offeringFilter } }),
    db.meeting.count({ where: { type: "DISCOVERY", scheduledAt: { gte: from, lte: now }, status: "HELD", lead: offeringFilter } }),
    db.meeting.count({ where: { type: "SALES", scheduledAt: { gte: from, lte: now }, status: { in: ["HELD", "NO_SHOW", "REBOOKED"] }, lead: offeringFilter } }),
    db.meeting.count({ where: { type: "SALES", scheduledAt: { gte: from, lte: now }, status: "HELD", lead: offeringFilter } }),
    db.dealLink.count({ where: { qualifiedAt: { gte: from }, lead: offeringFilter } }),
    db.dealLink.count({ where: { isWon: true, closedAt: { gte: from }, lead: offeringFilter } }),
  ]);

  const rates: Partial<FunnelRates> = {
    cpmCents: impressions >= 1000 ? (spend / impressions) * 1000 : undefined,
    ctr: ratio(clicks, impressions, 1000),
    formRate: ratio(leads, clicks, 100),
    validationRate: ratio(validated, leads, 10),
    discoveryShowRate: ratio(dHeld, dBooked, 5),
    qualificationRate: ratio(qualified, dHeld, 5),
    salesShowRate: ratio(sHeld, sBooked, 3),
    closeRate: ratio(won, sHeld, 3),
  };
  return {
    rates,
    samples: { cpmCents: impressions, ctr: impressions, formRate: clicks, validationRate: leads, discoveryShowRate: dBooked, qualificationRate: dHeld, salesShowRate: sBooked, closeRate: sHeld },
    days,
  };
}

export type FunnelDefaultsView = {
  inputs: FunnelInputs;
  fallback: FunnelRates;
  fromHistory: Partial<Record<keyof FunnelRates, boolean>>;
  history: History;
};

export async function funnelDefaults(db: ScopedDb, companyId: string, offeringId: string): Promise<FunnelDefaultsView> {
  const settings = await getSettings(db);
  const offering = await db.offering.findUniqueOrThrow({ where: { id: offeringId } });
  const fd = settings.funnelDefaults;
  const fallback: FunnelRates = { cpmCents: fd.cpmCents, ...Object.fromEntries(RATE_KEYS.map((k) => [k, fd[k]])) } as FunnelRates;
  // Use offering-specific history when it has enough volume; otherwise company-wide.
  let history = await funnelHistory(db, companyId, { offeringId });
  if (Object.values(history.rates).filter((v) => v != null).length < 4) history = await funnelHistory(db, companyId);
  const { rates, fromHistory } = mergeRates(fallback, history.rates);
  return {
    inputs: {
      ...rates,
      dealValueCents: offering.dealSizeCents ?? fd.dealValueCents,
      margin: offering.grossMargin ?? fd.margin,
      expansion: null,
      targetWonPerMonth: fd.targetWonPerMonth,
      budgetCents: fd.budgetCents,
    },
    fallback,
    fromHistory,
    history,
  };
}

export const FunnelInputsSchema = z.object({
  cpmCents: z.number().nonnegative(),
  ctr: z.number().min(0).max(1),
  formRate: z.number().min(0).max(1),
  validationRate: z.number().min(0).max(1),
  discoveryShowRate: z.number().min(0).max(1),
  qualificationRate: z.number().min(0).max(1),
  salesShowRate: z.number().min(0).max(1),
  closeRate: z.number().min(0).max(1),
  dealValueCents: z.number().nonnegative(),
  margin: z.number().min(0).max(1),
  expansion: z.object({ rate: z.number().min(0).max(1), valueCents: z.number().nonnegative(), margin: z.number().min(0).max(1) }).nullable().optional(),
  targetWonPerMonth: z.number().nonnegative().nullable().optional(),
  budgetCents: z.number().nonnegative().nullable().optional(),
});

export async function saveScenario(ctx: CompanyContext, offeringId: string, name: string, inputs: FunnelInputs, id?: string | null) {
  const parsed = FunnelInputsSchema.parse(inputs);
  await ctx.db.offering.findUniqueOrThrow({ where: { id: offeringId } });
  const data = { name: name.trim() || "Untitled scenario", inputs: parsed as unknown as Prisma.InputJsonValue };
  if (id) {
    await ctx.db.funnelScenario.update({ where: { id }, data });
    return id;
  }
  const s = await ctx.db.funnelScenario.create({ data: { ...data, companyId: ctx.company.id, offeringId, createdBy: ctx.user.name } });
  return s.id;
}

export async function deleteScenario(ctx: CompanyContext, id: string) {
  await ctx.db.funnelScenario.delete({ where: { id } });
}

export async function listScenarios(db: ScopedDb, offeringId: string) {
  const rows = await db.funnelScenario.findMany({ where: { offeringId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name, createdBy: r.createdBy, createdAt: r.createdAt, inputs: FunnelInputsSchema.parse(r.inputs) as FunnelInputs }));
}
