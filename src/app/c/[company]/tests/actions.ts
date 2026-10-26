"use server";

import { authorize } from "@/server/context";
import { act, cents, num, rate, str, type ActionResult } from "@/server/action";
import { addStatement, approveBatch, BatchSettingsInput, createBatch, decideStatement, launchBatch, removeStatement, updateBatchSettings, updateStatement } from "@/server/tests";
import { DECISIONS, isKind, type DecisionKey } from "./labels";

const paths = (slug: string) => [`/c/${slug}/tests`, `/c/${slug}/segments`];

function need<T>(v: T | null, message: string): T {
  if (v == null) throw new Error(message);
  return v;
}

function parseSettings(fd: FormData) {
  const channel = str(fd, "channel") || "meta";
  return BatchSettingsInput.parse({
    name: str(fd, "name") || undefined,
    channel,
    budgetCents: need(cents(fd, "budget"), "Enter a budget in dollars."),
    durationHours: Math.round(need(num(fd, "durationHours"), "Enter a duration in hours.")),
    targetCtr: need(rate(fd, "targetCtr"), "Enter a target clickthrough rate."),
    targetCpcCents: need(cents(fd, "targetCpc"), "Enter a target cost per click."),
    minImpressions: Math.round(num(fd, "minImpressions") ?? 1000),
    statementCount: Math.round(num(fd, "statementCount") ?? 12),
  });
}

function parseStatement(fd: FormData) {
  const kind = str(fd, "kind");
  if (!isKind(kind)) throw new Error("Choose problem or outcome.");
  return { text: str(fd, "text"), kind };
}

export async function createBatchAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.edit");
      const segmentId = str(fd, "segmentId");
      if (!segmentId) throw new Error("Choose an active segment.");
      const seg = await ctx.db.segment.findUniqueOrThrow({ where: { id: segmentId } });
      return createBatch(ctx, seg.id, parseSettings(fd));
    },
    { revalidate: paths(slug) },
  );
}

export async function updateBatchSettingsAction(slug: string, batchId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.edit");
      await updateBatchSettings(ctx, batchId, parseSettings(fd));
    },
    { revalidate: paths(slug), message: "Settings saved." },
  );
}

export async function updateStatementAction(slug: string, statementId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.edit");
      const { text, kind } = parseStatement(fd);
      await updateStatement(ctx, statementId, text, kind);
    },
    { revalidate: paths(slug) },
  );
}

export async function addStatementAction(slug: string, batchId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.edit");
      const { text, kind } = parseStatement(fd);
      await addStatement(ctx, batchId, text, kind);
    },
    { revalidate: paths(slug) },
  );
}

export async function removeStatementAction(slug: string, statementId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.edit");
      await removeStatement(ctx, statementId);
    },
    { revalidate: paths(slug) },
  );
}

export async function approveBatchAction(slug: string, batchId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.approve");
      await approveBatch(ctx, batchId);
    },
    { revalidate: paths(slug) },
  );
}

export async function launchBatchAction(slug: string, batchId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "batch.launch");
      await launchBatch(ctx, batchId);
    },
    { revalidate: paths(slug) },
  );
}

export async function decideStatementAction(slug: string, statementId: string, decision: DecisionKey, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      if (!(DECISIONS as readonly string[]).includes(decision)) throw new Error("Unknown decision.");
      const ctx = await authorize(slug, "batch.edit");
      return { createdId: await decideStatement(ctx, statementId, decision) };
    },
    { revalidate: paths(slug) },
  );
}
