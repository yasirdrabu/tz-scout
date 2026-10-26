"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authorize, type CompanyContext } from "@/server/context";
import { act, bool, num, str, type ActionResult } from "@/server/action";
import { getSettings } from "@/server/settings";
import { audit } from "@/server/audit";
import { FACTORS } from "@/lib/scoring";
import { METRICS } from "@/lib/scorecard";
import { RATE_KEYS } from "@/lib/funnel";
import { rematchAll } from "@/server/buyers";
import { setOnTeam, setUpHubSpotFields, syncSellers } from "@/server/crm";

const path = (slug: string) => `/c/${slug}/settings`;
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** A required number typed by a person, with a plain error when it is missing. */
function need(fd: FormData, key: string, label: string): number {
  const n = num(fd, key);
  if (n == null) throw new Error(`Enter ${label}.`);
  return n;
}
const needCents = (fd: FormData, key: string, label: string) => Math.round(need(fd, key, label) * 100);
const needRate = (fd: FormData, key: string, label: string) => need(fd, key, label) / 100;
const numList = (fd: FormData, key: string, label: string) =>
  str(fd, key)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`${label}: "${s}" is not a number.`);
      return n;
    });

async function save(slug: string, section: string, build: (ctx: CompanyContext) => Prisma.SettingsUpdateInput) {
  const ctx = await authorize(slug, "settings.edit");
  const current = await getSettings(ctx.db);
  const data = build(ctx);
  await ctx.db.settings.update({ where: { id: current.id }, data });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: `settings.${section}`, entity: "settings", entityId: current.id, data });
  return ctx;
}

const rate01 = (label: string) => z.number().min(0, `${label} can't be negative.`).max(1, `${label} can't be over 100%.`);

const ScoringInput = z.object({
  weights: z.record(z.string(), z.number().min(0, "Weights can't be negative.").max(100, "Keep each weight at 100 or less.")),
  maxActiveSegments: z.number().int("Use a whole number of segments.").min(1, "Allow at least one active segment.").max(20),
});

export async function saveScoringAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const parsed = ScoringInput.parse({
        weights: Object.fromEntries(FACTORS.map((f) => [f.key, need(fd, `w_${f.key}`, `a weight for ${f.label.toLowerCase()}`)])),
        maxActiveSegments: need(fd, "maxActiveSegments", "the most active segments per offering"),
      });
      if (Object.values(parsed.weights).every((w) => w === 0)) throw new Error("At least one weight must be above zero.");
      await save(slug, "scoring", () => ({ weights: json(parsed.weights), maxActiveSegments: parsed.maxActiveSegments }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

const TestsInput = z.object({
  budgetCents: z.number().int().positive("Budget must be above zero."),
  durationHours: z.number().int("Use whole hours.").min(1).max(24 * 30),
  channel: z.enum(["meta", "linkedin"]),
  targetCtr: rate01("Target clickthrough rate"),
  targetCpcCents: z.number().int().nonnegative(),
  minImpressions: z.number().int("Use a whole number of impressions.").nonnegative(),
  statementCount: z.number().int("Use a whole number of statements.").min(2, "Test at least two statements.").max(50),
});

export async function saveTestsAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const parsed = TestsInput.parse({
        budgetCents: needCents(fd, "budget", "a default budget"),
        durationHours: need(fd, "durationHours", "a duration"),
        channel: str(fd, "channel"),
        targetCtr: needRate(fd, "targetCtr", "a target clickthrough rate"),
        targetCpcCents: needCents(fd, "targetCpc", "a target cost per click"),
        minImpressions: need(fd, "minImpressions", "the minimum impressions"),
        statementCount: need(fd, "statementCount", "how many statements to test"),
      });
      await save(slug, "tests", () => ({ testDefaults: json(parsed) }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

const FunnelInput = z.object({
  cpmCents: z.number().nonnegative(),
  ctr: rate01("Clickthrough rate"),
  formRate: rate01("Form conversion rate"),
  validationRate: rate01("Validation pass rate"),
  discoveryShowRate: rate01("Discovery show-up rate"),
  qualificationRate: rate01("Qualification rate"),
  salesShowRate: rate01("Sales call show-up rate"),
  closeRate: rate01("Close rate"),
  dealValueCents: z.number().int().nonnegative(),
  margin: rate01("Gross margin"),
  targetWonPerMonth: z.number().nonnegative(),
  budgetCents: z.number().int().nonnegative(),
});

export async function saveFunnelAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const parsed = FunnelInput.parse({
        cpmCents: needCents(fd, "cpm", "a cost per 1,000 impressions"),
        ...Object.fromEntries(RATE_KEYS.map((k) => [k, needRate(fd, k, "every stage rate")])),
        dealValueCents: needCents(fd, "dealValue", "a deal value"),
        margin: needRate(fd, "margin", "a gross margin"),
        targetWonPerMonth: need(fd, "targetWonPerMonth", "a target for won clients per month"),
        budgetCents: needCents(fd, "budget", "a monthly budget"),
      });
      await save(slug, "funnel", () => ({ funnelDefaults: json(parsed) }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

const SequenceInput = z.object({
  reminderHours: z.array(z.number().int("Use whole hours for reminders.").min(1).max(168)).max(5),
  rebookDays: z.array(z.number().int("Use whole days for rebooking.").min(0).max(60)).max(5),
  bookingLinkDelayMinutes: z.number().int("Use whole minutes.").min(0).max(24 * 60),
  smsReminders: z.boolean(),
});

export async function saveSequenceAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const parsed = SequenceInput.parse({
        reminderHours: [...new Set(numList(fd, "reminderHours", "Reminder hours"))].sort((a, b) => b - a),
        rebookDays: [...new Set(numList(fd, "rebookDays", "Rebook days"))].sort((a, b) => a - b),
        bookingLinkDelayMinutes: need(fd, "bookingLinkDelayMinutes", "a booking link delay"),
        smsReminders: bool(fd, "smsReminders"),
      });
      await save(slug, "sequence", () => ({ sequence: json(parsed) }));
    },
    { revalidate: path(slug), message: "Saved." },
  );
}

export async function saveScorecardAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const config: Record<string, { target: number | null; minSample: number }> = {};
      for (const m of METRICS) {
        const raw = num(fd, `t_${m.key}`);
        if (raw != null && raw < 0) throw new Error(`${m.label}: the target can't be negative.`);
        const target = raw == null ? null : m.format === "rate" ? raw / 100 : m.format === "money" || m.format === "moneyPrecise" ? Math.round(raw * 100) : raw;
        const minSample = num(fd, `m_${m.key}`) ?? 0;
        if (minSample < 0 || !Number.isInteger(minSample)) throw new Error(`${m.label}: the minimum sample must be a whole number.`);
        config[m.key] = { target, minSample };
      }
      await save(slug, "scorecard", () => ({ scorecard: json(config) }));
    },
    { revalidate: [path(slug), `/c/${slug}/scorecard`], message: "Saved." },
  );
}

const BuyersInput = z
  .object({
    fitWeight: rate01("Fit share"),
    signalWeight: rate01("Signal share"),
    briefLimit: z.number().int("Use a whole number of accounts.").min(0, "Brief zero or more accounts.").max(50, "Brief at most 50 accounts per pull."),
    lookbackDays: z.number().int("Use whole days.").min(30, "Look back at least 30 days.").max(730, "Look back at most 730 days."),
  })
  .refine((v) => Math.round((v.fitWeight + v.signalWeight) * 100) === 100, { message: "Fit and signals must add up to 100%." });

export async function saveBuyersAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const parsed = BuyersInput.parse({
        fitWeight: needRate(fd, "fitPct", "how much fit counts"),
        signalWeight: needRate(fd, "signalPct", "how much signals count"),
        briefLimit: need(fd, "briefLimit", "how many accounts Claude briefs per pull"),
        lookbackDays: need(fd, "lookbackDays", "how many days of signals to read"),
      });
      const ctx = await save(slug, "buyers", () => ({ buyers: json(parsed) }));
      // Re-rank every account with the new split so Buyers is current when the page reloads.
      await rematchAll(ctx.db, ctx.company.id);
    },
    { revalidate: [path(slug), `/c/${slug}/buyers`], message: "Saved. Every account was re-ranked." },
  );
}

// ---------- Who follows up (HubSpot owners) ----------

export async function setOnTeamAction(slug: string, sellerId: string, onTeam: boolean, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "settings.edit");
      await setOnTeam(ctx, sellerId, onTeam);
    },
    { revalidate: [path(slug), `/c/${slug}/buyers`] },
  );
}

export async function addToTeamAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "settings.edit");
      const id = str(fd, "sellerId");
      if (!id) throw new Error("Pick someone from the HubSpot owner list.");
      await setOnTeam(ctx, id, true);
    },
    { revalidate: [path(slug), `/c/${slug}/buyers`], message: "Added. They can now be assigned accounts." },
  );
}

export async function syncSellersAction(slug: string, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let message = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "settings.edit");
      const n = await syncSellers(ctx);
      message = `Synced ${n} owners from HubSpot.`;
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message } : r;
}

export async function setUpHubSpotFieldsAction(slug: string, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let message = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "settings.edit");
      const made = await setUpHubSpotFields(ctx);
      message = made.length ? `Created ${made.length} fields in HubSpot.` : "All fields were already there.";
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message } : r;
}
