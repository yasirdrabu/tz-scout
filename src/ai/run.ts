// The single path for every Claude call: build prompt, call the adapter (mock or live), validate the
// output with Zod, and log the run (input hash, model, tokens, result) to AiRun.

import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import { anthropicAdapter } from "@/integrations/anthropic";

export type AiTask<I, O> = {
  name: string;
  promptVersion: string;
  system: string;
  schema: z.ZodType<O>;
  buildUser: (input: I) => string;
  mock: (input: I) => O;
  maxTokens?: number;
};

/** JSON schema for structured output: every object closed, no numeric or length constraints. */
export function toStructuredSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  const strip = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (!strip.has(k)) out[k] = walk(v);
    if (out.type === "object") {
      out.additionalProperties = false;
      if (out.properties && !out.required) out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

export class AiError extends Error {
  constructor(message: string, public runId: string) {
    super(message);
    this.name = "AiError";
  }
}

export async function runAi<I, O>(db: ScopedDb, companyId: string, task: AiTask<I, O>, input: I): Promise<{ output: O; runId: string }> {
  const adapter = anthropicAdapter();
  const user = task.buildUser(input);
  const inputHash = createHash("sha256").update(task.name + task.promptVersion + user).digest("hex").slice(0, 32);
  const started = Date.now();
  try {
    const res = await adapter.complete({
      system: task.system,
      user,
      schema: toStructuredSchema(task.schema),
      maxTokens: task.maxTokens,
      mockResponse: adapter.mode === "mock" ? task.mock(input) : undefined,
    });
    const parsed = task.schema.safeParse(res.json);
    if (!parsed.success) throw new Error(`Claude's answer did not match the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const run = await db.aiRun.create({
      data: {
        companyId,
        task: task.name,
        promptVersion: task.promptVersion,
        model: res.model,
        mock: adapter.mode === "mock",
        inputHash,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        ok: true,
        result: parsed.data as Prisma.InputJsonValue,
        durationMs: Date.now() - started,
      },
    });
    return { output: parsed.data, runId: run.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const run = await db.aiRun.create({
      data: { companyId, task: task.name, promptVersion: task.promptVersion, model: adapter.model, mock: adapter.mode === "mock", inputHash, ok: false, error: message, durationMs: Date.now() - started },
    });
    throw new AiError(message, run.id);
  }
}
