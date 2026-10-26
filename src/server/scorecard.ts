// Module 7: build weekly counts from adapters and our records, colour them against targets,
// diagnose the biggest bottleneck each Monday, and track fixes until done.

import type { ScopedDb } from "@/lib/db";
import { unscopedDb, scopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { adapters } from "@/integrations";
import { runAi } from "@/ai/run";
import { weeklyDiagnosisTask } from "@/ai/weeklyDiagnosis";
import { addDays, buildScorecard, emptyCounts, METRIC_BY_KEY, RAW_KEYS, weekStart, type RawCounts } from "@/lib/scorecard";
import { money, num, pct } from "@/lib/format";
import { getSettings } from "./settings";
import { audit } from "./audit";

/** Meetings whose outcome is known. Booked meetings still ahead (or not yet logged) don't count against show-up. */
const RESOLVED: ("HELD" | "NO_SHOW" | "REBOOKED")[] = ["HELD", "NO_SHOW", "REBOOKED"];

const validatedWhere = { OR: [{ status: "VALIDATED" as const, overrideStatus: null }, { overrideStatus: "VALIDATED" as const }] };

/** Raw counts for one Monday to Sunday week. */
export async function countsForWeek(db: ScopedDb, companyId: string, monday: Date): Promise<RawCounts> {
  const from = monday;
  const to = addDays(monday, 7);
  const c = emptyCounts();
  const a = adapters(db, companyId);
  try {
    const stats = await a.meta.getDailyStats(companyId, from, addDays(to, -1));
    for (const s of stats) { c.spendCents += s.spendCents; c.impressions += s.impressions; c.clicks += s.clicks; }
  } catch {
    // Ad channel not connected; ad rows stay at zero.
  }
  const range = { gte: from, lt: to };
  const [formFills, validated, dBooked, dHeld, sBooked, sHeld, qualified, won] = await Promise.all([
    db.lead.count({ where: { submittedAt: range, source: "inbound" } }),
    db.lead.count({ where: { validatedAt: range, source: "inbound", ...validatedWhere } }),
    db.meeting.count({ where: { type: "DISCOVERY", scheduledAt: range, status: { in: RESOLVED } } }),
    db.meeting.count({ where: { type: "DISCOVERY", scheduledAt: range, status: "HELD" } }),
    db.meeting.count({ where: { type: "SALES", scheduledAt: range, status: { in: RESOLVED } } }),
    db.meeting.count({ where: { type: "SALES", scheduledAt: range, status: "HELD" } }),
    db.dealLink.count({ where: { qualifiedAt: range } }),
    db.dealLink.findMany({ where: { isWon: true, closedAt: range }, select: { amountCents: true } }),
  ]);
  Object.assign(c, { formFills, validatedLeads: validated, discoveryBooked: dBooked, discoveryHeld: dHeld, salesBooked: sBooked, salesHeld: sHeld, qualified, won: won.length, revenueCents: won.reduce((s, d) => s + d.amountCents, 0) });
  return c;
}

/** Build (or rebuild) stored weeks from `fromMonday` through the week containing `now`. */
export async function buildWeeks(db: ScopedDb, companyId: string, fromMonday: Date, now = new Date()) {
  const last = weekStart(now);
  for (let m = weekStart(fromMonday); m <= last; m = addDays(m, 7)) {
    const counts = await countsForWeek(db, companyId, m);
    const week = await db.week.upsert({ where: { companyId_startDate: { companyId, startDate: m } }, create: { companyId, startDate: m, builtAt: new Date() }, update: { builtAt: new Date() } });
    for (const k of RAW_KEYS) {
      await db.weekMetric.upsert({ where: { weekId_key: { weekId: week.id, key: k } }, create: { companyId, weekId: week.id, key: k, value: counts[k] }, update: { value: counts[k] } });
    }
  }
}

export async function loadWeeks(db: ScopedDb, opts: { count?: number; endMonday?: Date } = {}) {
  const count = opts.count ?? 8;
  const end = opts.endMonday ?? weekStart(new Date());
  const weeks = await db.week.findMany({
    where: { startDate: { lte: end, gte: addDays(end, -7 * (count - 1)) } },
    orderBy: { startDate: "asc" },
    include: { metrics: true, diagnosis: { include: { fixes: { orderBy: { createdAt: "asc" } } } } },
  });
  return weeks.map((w) => {
    const c = emptyCounts();
    for (const m of w.metrics) if ((RAW_KEYS as readonly string[]).includes(m.key)) c[m.key as keyof RawCounts] = m.value;
    return { id: w.id, startDate: w.startDate, builtAt: w.builtAt, counts: c, diagnosis: w.diagnosis };
  });
}

export async function scorecardView(db: ScopedDb, opts: { count?: number; endMonday?: Date } = {}) {
  const settings = await getSettings(db);
  const weeks = await loadWeeks(db, opts);
  // The rolling average excludes the current, partial week.
  const thisMonday = weekStart(new Date()).getTime();
  const complete = weeks.filter((w) => w.startDate.getTime() < thisMonday);
  const rows = buildScorecard(weeks.map((w) => w.counts), settings.scorecard);
  const rollingRows = buildScorecard(complete.map((w) => w.counts), settings.scorecard);
  // The current week is partial: show its numbers but don't judge them.
  const inProgress = weeks.map((w) => w.startDate.getTime() >= thisMonday);
  return {
    weeks: weeks.map((w, i) => ({ ...w, inProgress: inProgress[i]! })),
    rows: rows.map((r, i) => ({
      ...r,
      weeks: r.weeks.map((c, j) => (inProgress[j] ? { ...c, colour: "none" as const } : c)),
      rolling: rollingRows[i]!.rolling,
    })),
    config: settings.scorecard,
  };
}

const fmtValue = (key: string, v: number | null) => {
  const def = METRIC_BY_KEY[key];
  if (!def || v == null) return "n/a";
  if (def.format === "rate") return pct(v);
  if (def.format === "money" || def.format === "moneyPrecise") return money(v, "USD", { precise: def.format === "moneyPrecise" });
  return num(v);
};

/** Diagnose the most recent complete week from the last four. Replaces the AI text but keeps fixes already done. */
export async function diagnoseWeek(db: ScopedDb, companyId: string, weekId: string) {
  const company = await db.company.findFirstOrThrow();
  const week = await db.week.findUniqueOrThrow({ where: { id: weekId } });
  const view = await scorecardView(db, { count: 4, endMonday: week.startDate });
  const openFixes = await db.fix.findMany({ where: { done: false, diagnosis: { week: { startDate: { lt: week.startDate } } } }, select: { text: true } });
  const stageKeys = ["ctr", "cpc", "formRate", "validationRate", "discoveryShowRate", "qualificationRate", "salesShowRate", "closeRate"];
  const input = {
    company: company.name,
    weeks: view.weeks.map((w) => w.startDate.toISOString().slice(0, 10)),
    rows: view.rows.map((r) => ({ metric: r.def.label, target: r.target == null ? null : fmtValue(r.def.key, r.target), values: r.weeks.map((c) => fmtValue(r.def.key, c.value)), rolling: fmtValue(r.def.key, r.rolling.value), status: r.rolling.colour })),
    openFixes: openFixes.map((f) => f.text),
    stages: view.rows.filter((r) => stageKeys.includes(r.def.key)).map((r) => ({ key: r.def.key, label: r.def.label, rolling: r.rolling.value, target: r.target, direction: r.def.direction })),
  };
  const { output, runId } = await runAi(db, companyId, weeklyDiagnosisTask, input);
  const existing = await db.diagnosis.findUnique({ where: { weekId } });
  if (existing) {
    await db.fix.deleteMany({ where: { diagnosisId: existing.id, done: false } });
    await db.diagnosis.update({ where: { id: existing.id }, data: { bottleneck: output.bottleneck, cause: output.cause, summary: output.summary, aiRunId: runId, editedById: null, editedAt: null } });
  }
  const d = existing ?? (await db.diagnosis.create({ data: { companyId, weekId, bottleneck: output.bottleneck, cause: output.cause, summary: output.summary, aiRunId: runId } }));
  // Fixes still open from earlier weeks already carry over; don't add them twice.
  const carried = new Set(openFixes.map((f) => f.text.trim().toLowerCase()));
  const fresh = output.fixes.filter((f) => !carried.has(f.text.trim().toLowerCase()));
  await db.fix.createMany({ data: fresh.map((f) => ({ companyId, diagnosisId: d.id, text: f.text, ownerRole: f.ownerRole })) });
  return d.id;
}

export async function editDiagnosis(ctx: CompanyContext, diagnosisId: string, data: { bottleneck: string; cause: string; summary: string }) {
  await ctx.db.diagnosis.update({ where: { id: diagnosisId }, data: { ...data, editedById: ctx.user.id, editedAt: new Date() } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "diagnosis.edit", entity: "diagnosis", entityId: diagnosisId });
}

export async function addFix(ctx: CompanyContext, diagnosisId: string, text: string, ownerRole: string) {
  if (!text.trim()) throw new Error("Describe the fix.");
  await ctx.db.fix.create({ data: { companyId: ctx.company.id, diagnosisId, text: text.trim(), ownerRole } });
}

export async function toggleFix(ctx: CompanyContext, fixId: string, done: boolean) {
  await ctx.db.fix.update({ where: { id: fixId }, data: { done, doneAt: done ? new Date() : null, doneById: done ? ctx.user.id : null } });
}

/** Open fixes from any week carry over until done. */
export async function openFixes(db: ScopedDb) {
  return db.fix.findMany({ where: { done: false }, include: { diagnosis: { include: { week: true } } }, orderBy: { createdAt: "asc" } });
}

/** Send closed-won deals to the ad platform as offline conversions. */
export async function syncConversions(db: ScopedDb, companyId: string) {
  const deals = await db.dealLink.findMany({ where: { isWon: true, conversionSentAt: null }, include: { lead: true } });
  const a = adapters(db, companyId);
  let sent = 0;
  for (const d of deals) {
    try {
      const r = await a.meta.sendConversion({ dealId: d.hubspotDealId, email: d.lead?.email, valueCents: d.amountCents, closedAt: d.closedAt ?? new Date() });
      if (r.accepted) {
        await db.dealLink.update({ where: { id: d.id }, data: { conversionSentAt: new Date() } });
        sent++;
      }
    } catch {
      break; // not connected
    }
  }
  return sent;
}

/** The Monday job: rebuild the last few weeks for every company, diagnose last week, sync conversions. */
export async function weeklyRunAllCompanies(now = new Date()) {
  const companies = await unscopedDb.company.findMany({ select: { id: true } });
  const lastMonday = addDays(weekStart(now), -7);
  for (const c of companies) {
    const db = scopedDb(c.id);
    await buildWeeks(db, c.id, addDays(lastMonday, -21), now);
    const week = await db.week.findFirst({ where: { startDate: lastMonday } });
    if (week) await diagnoseWeek(db, c.id, week.id);
    await syncConversions(db, c.id);
  }
}
