// Module 3: message test batches, launch, results, verdicts, decisions and the winners library.

import { z } from "zod";
import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { runAi } from "@/ai/run";
import { rewriteTask, statementsTask } from "@/ai/statements";
import { adapters, adChannel } from "@/integrations";
import { verdict, type Verdict } from "@/lib/verdict";
import { enqueue, QUEUES } from "@/jobs/queue";
import { getSettings } from "./settings";
import { audit } from "./audit";

type Ctx = Pick<CompanyContext, "db" | "company"> & { user?: { id: string; name?: string } };

export const BatchSettingsInput = z.object({
  name: z.string().trim().min(2).optional(),
  channel: z.enum(["meta", "linkedin"]).default("meta"),
  budgetCents: z.number().int().positive(),
  durationHours: z.number().int().positive().max(24 * 14),
  targetCtr: z.number().positive().max(1),
  targetCpcCents: z.number().int().positive(),
  minImpressions: z.number().int().positive().default(1000),
  statementCount: z.number().int().min(12).max(15).default(12),
});

async function winnersFor(db: ScopedDb, segmentId: string) {
  return (await db.statement.findMany({ where: { segmentId, inLibrary: true }, select: { text: true } })).map((s) => s.text);
}

export async function createBatch(ctx: Ctx, segmentId: string, input: z.infer<typeof BatchSettingsInput>) {
  const { db, company } = ctx;
  const seg = await db.segment.findUniqueOrThrow({ where: { id: segmentId }, include: { offering: true } });
  if (seg.status !== "ACTIVE") throw new Error("Make the segment active before writing a test batch.");
  if (seg.offering.status !== "APPROVED") throw new Error("The offering needs to be approved before testing messages for it.");
  const n = await db.batch.count({ where: { segmentId } });
  const { output } = await runAi(db, company.id, statementsTask, {
    segmentKey: seg.key,
    buyer: seg.buyer,
    problem: seg.problem,
    industry: seg.industry,
    promise: seg.offering.promise,
    count: input.statementCount,
    winners: await winnersFor(db, segmentId),
  });
  const batch = await db.batch.create({
    data: {
      companyId: company.id,
      segmentId,
      name: input.name ?? `Batch ${n + 1}`,
      channel: input.channel,
      budgetCents: input.budgetCents,
      durationHours: input.durationHours,
      targetCtr: input.targetCtr,
      targetCpcCents: input.targetCpcCents,
      minImpressions: input.minImpressions,
    },
  });
  await db.statement.createMany({ data: output.statements.map((s) => ({ companyId: company.id, batchId: batch.id, segmentId, text: s.text.trim(), kind: s.kind })) });
  await audit(db, company.id, { userId: ctx.user?.id, action: "batch.create", entity: "batch", entityId: batch.id });
  return batch.id;
}

export async function newBatchDefaults(db: ScopedDb) {
  return (await getSettings(db)).testDefaults;
}

const assertDraft = async (db: ScopedDb, batchId: string) => {
  const b = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
  if (b.status !== "DRAFT") throw new Error("Only draft batches can be edited. Approved batches are locked.");
  return b;
};

export const StatementText = z.string().trim().min(5).refine((s) => s.split(/\s+/).length <= 25, "Keep statements under 25 words.");

export async function updateStatement(ctx: Ctx, statementId: string, text: string, kind: "PROBLEM" | "OUTCOME") {
  const st = await ctx.db.statement.findUniqueOrThrow({ where: { id: statementId } });
  await assertDraft(ctx.db, st.batchId);
  await ctx.db.statement.update({ where: { id: statementId }, data: { text: StatementText.parse(text), kind } });
}

export async function addStatement(ctx: Ctx, batchId: string, text: string, kind: "PROBLEM" | "OUTCOME") {
  const b = await assertDraft(ctx.db, batchId);
  await ctx.db.statement.create({ data: { companyId: ctx.company.id, batchId, segmentId: b.segmentId, text: StatementText.parse(text), kind } });
}

export async function removeStatement(ctx: Ctx, statementId: string) {
  const st = await ctx.db.statement.findUniqueOrThrow({ where: { id: statementId } });
  await assertDraft(ctx.db, st.batchId);
  await ctx.db.statement.delete({ where: { id: statementId } });
}

export async function updateBatchSettings(ctx: Ctx, batchId: string, input: z.infer<typeof BatchSettingsInput>) {
  await assertDraft(ctx.db, batchId);
  const { statementCount: _ignored, ...rest } = input;
  void _ignored;
  await ctx.db.batch.update({ where: { id: batchId }, data: rest });
}

export async function approveBatch(ctx: Ctx, batchId: string) {
  const b = await assertDraft(ctx.db, batchId);
  const count = await ctx.db.statement.count({ where: { batchId } });
  if (count < 2) throw new Error("A batch needs at least two statements.");
  await ctx.db.batch.update({ where: { id: b.id }, data: { status: "APPROVED" } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user?.id, action: "batch.approve", entity: "batch", entityId: batchId, data: { budgetCents: b.budgetCents } });
}

export async function launchBatch(ctx: Ctx, batchId: string, now = new Date()) {
  const { db, company } = ctx;
  const b = await db.batch.findUniqueOrThrow({ where: { id: batchId }, include: { statements: true, segment: { include: { offering: true } } } });
  if (b.status !== "APPROVED") throw new Error("An owner must approve the batch budget before launch.");
  const channel = adChannel(adapters(db, company.id), b.channel);
  const { adSets } = await channel.launchTest({
    batchId,
    statements: b.statements.map((s) => ({ statementId: s.id, text: s.text })),
    budgetCents: b.budgetCents,
    durationHours: b.durationHours,
    audience: { titles: b.segment.offering.targetTitles, industries: b.segment.industry ? [b.segment.industry] : b.segment.offering.industries, companySizeMin: b.segment.offering.companySizeMin, companySizeMax: b.segment.offering.companySizeMax },
    launchedAt: now,
  });
  for (const a of adSets) await db.statement.update({ where: { id: a.statementId }, data: { externalId: a.externalId } });
  await db.batch.update({ where: { id: batchId }, data: { status: "RUNNING", launchedAt: now, endsAt: new Date(now.getTime() + b.durationHours * 3600_000) } });
  await audit(db, company.id, { userId: ctx.user?.id, action: "batch.launch", entity: "batch", entityId: batchId, data: { channel: b.channel, adSets: adSets.length } });
  await enqueue(QUEUES.batchCollect, { companyId: company.id, batchId }, { startAfterSeconds: 5 });
}

/** Pull results from the channel. Returns true once every ad set has finished. */
export async function collectResults(db: ScopedDb, companyId: string, batchId: string): Promise<boolean> {
  const b = await db.batch.findUniqueOrThrow({ where: { id: batchId }, include: { statements: true } });
  if (b.status !== "RUNNING" || !b.launchedAt) return true;
  const channel = adChannel(adapters(db, companyId), b.channel);
  const withIds = b.statements.filter((s) => s.externalId);
  const results = await channel.getResults(withIds.map((s) => s.externalId!), { launchedAt: b.launchedAt, durationHours: b.durationHours, budgetCents: b.budgetCents, adSetCount: withIds.length });
  for (const r of results) {
    const st = withIds.find((s) => s.externalId === r.externalId);
    if (!st) continue;
    await db.statementResult.upsert({
      where: { statementId: st.id },
      create: { companyId, statementId: st.id, impressions: r.impressions, clicks: r.clicks, spendCents: r.spendCents },
      update: { impressions: r.impressions, clicks: r.clicks, spendCents: r.spendCents, fetchedAt: new Date() },
    });
  }
  const done = results.length > 0 && results.every((r) => r.complete);
  if (done) await db.batch.update({ where: { id: batchId }, data: { status: "COMPLETE", completedAt: new Date() } });
  return done;
}

export function statementVerdict(batch: { targetCtr: number; targetCpcCents: number; minImpressions: number }, result: { impressions: number; clicks: number; spendCents: number } | null): Verdict {
  return verdict(result, batch);
}

/** The draft batch that collects rewrites and retests for a segment, created on first use. */
async function followUpBatch(ctx: Ctx, segmentId: string, from: { channel: string; budgetCents: number; durationHours: number; targetCtr: number; targetCpcCents: number; minImpressions: number }) {
  const existing = await ctx.db.batch.findFirst({ where: { segmentId, status: "DRAFT" }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  const n = await ctx.db.batch.count({ where: { segmentId } });
  const { channel, budgetCents, durationHours, targetCtr, targetCpcCents, minImpressions } = from;
  return ctx.db.batch.create({ data: { companyId: ctx.company.id, segmentId, name: `Batch ${n + 1} (retest)`, channel, budgetCents, durationHours, targetCtr, targetCpcCents, minImpressions } });
}

export async function decideStatement(ctx: Ctx, statementId: string, decision: "KEEP" | "DROP" | "REWRITE" | "RETEST") {
  const { db, company } = ctx;
  const st = await db.statement.findUniqueOrThrow({ where: { id: statementId }, include: { batch: true, segment: true } });
  if (st.batch.status !== "COMPLETE" && st.batch.status !== "RUNNING") throw new Error("Decide after results come in.");
  let createdId: string | null = null;
  if (decision === "REWRITE" || decision === "RETEST") {
    const target = await followUpBatch(ctx, st.segmentId, st.batch);
    let text = st.text;
    if (decision === "REWRITE") {
      const { output } = await runAi(db, company.id, rewriteTask, { statement: st.text, kind: st.kind, buyer: st.segment.buyer, winners: await winnersFor(db, st.segmentId) });
      text = output.text;
    }
    const created = await db.statement.create({ data: { companyId: company.id, batchId: target.id, segmentId: st.segmentId, text, kind: st.kind, rewriteOfId: st.id } });
    createdId = created.id;
  }
  await db.statement.update({ where: { id: statementId }, data: { decision, inLibrary: decision === "KEEP" } });
  await audit(db, company.id, { userId: ctx.user?.id, action: `statement.${decision.toLowerCase()}`, entity: "statement", entityId: statementId, data: { createdId } });
  return createdId;
}

export async function library(db: ScopedDb, opts: { segmentId?: string } = {}) {
  const rows = await db.statement.findMany({
    where: { inLibrary: true, ...(opts.segmentId ? { segmentId: opts.segmentId } : {}) },
    include: { result: true, batch: true, segment: { include: { offering: { select: { name: true } } } } },
    orderBy: [{ segmentId: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({ ...r, verdict: verdict(r.result, r.batch) }));
}

/** Winners reshaped for three uses. Plain transformations so the team can edit from a sensible start. */
export function exportWinners(rows: { text: string; kind: "PROBLEM" | "OUTCOME" }[]) {
  const strip = (s: string) => s.replace(/[.!?]+$/, "");
  const problems = rows.filter((r) => r.kind === "PROBLEM").map((r) => r.text);
  const outcomes = rows.filter((r) => r.kind === "OUTCOME").map((r) => r.text);
  return {
    adCopy: rows.map((r) => r.text),
    headlines: outcomes.map((o) => strip(o)),
    discoveryQuestions: problems.map((p) => `When you say "${strip(p)}", what does that cost you today, and who feels it most?`),
  };
}
