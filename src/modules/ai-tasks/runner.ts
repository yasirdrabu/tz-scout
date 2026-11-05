import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { connectionStatus, gateway } from '@/modules/integrations';
import { config } from '@/platform/config';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import type { AnthropicAdapter, CompleteRequest } from './adapters/anthropic/contract';
import { aiRunCompleted } from './contracts/events';
import { aiRun, aiSetting } from './db/schema';
import { claudePrices, type ClaudePrices } from './pricing';

export type AiMode = 'live' | 'rules' | 'mock';
export type AiStatus = 'ok' | 'invalid_output' | 'error' | 'refused_by_cap';
export type AiRunRow = typeof aiRun.$inferSelect;

export const AI_LABEL: Record<AiMode, string> = {
  live: 'Written by Claude',
  rules: 'Assembled from rules',
  mock: 'Sample output',
};
export const NO_KEY = 'Add a Claude key to use this.';
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROVIDER = 'anthropic';

export type TaskDef<I, O> = {
  name: string;
  promptVersion: string;
  model: string;
  system: string;
  buildUser: (i: I) => string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  rules?: (i: I) => O;
  mock?: (i: I) => O;
  maxTokens: number;
  maxCostCents?: number;
};

export const defineTask = <I, O>(def: TaskDef<I, O>): TaskDef<I, O> => def;

export type RunOpts = {
  subject: { type: string; id: string };
  allowRules?: boolean;
  fresh?: boolean;
  /** Skips mock and live and runs the rules, or says there is no key for a task without rules. Recorded as `mode: 'rules'`. */
  rulesOnly?: boolean;
  /** Like `fresh`, but a run made at or after this time is reused: a job retried after a timeout finds the run it paid for. */
  reuseAfter?: Date;
  /** The account the run is for, when the caller knows it: carried on the usage record (R3a Ruling 3). */
  accountId?: string;
};
export type RunResult<O> = { output: O; runId: string; mode: AiMode };

/** JSON with object keys sorted at every depth, so equal inputs always hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
export const inputHash = (input: unknown): string => createHash('sha256').update(canonicalJson(input)).digest('hex');

/** Gateway refusals that mean "no live Claude right now": the task falls back to rules. */
const FALLBACK_SLUGS = new Set(['connection_not_ready', 'connection_disabled', 'credential_unreadable']);
const actorText = (ctx: ModuleContext) => `${ctx.actor.kind}:${ctx.actor.id}`;

type Draft = Omit<
  AiRunRow,
  'id' | 'tenantId' | 'createdAt' | 'actor' | 'correlationId' | 'inputRef' | 'task' | 'promptVersion' | 'inputHash'
>;
type Subject = { type: string; id: string };

/** Writes the run and its event. `inOwnTx` commits them even if the caller later throws and rolls back. */
async function record<I, O>(
  ctx: ModuleContext,
  task: TaskDef<I, O>,
  hash: string,
  subject: Subject,
  d: Draft,
  inOwnTx = false,
): Promise<string> {
  const id = newId('run');
  const write = async (c: ModuleContext) => {
    await c.tx.insert(aiRun).values({
      id,
      tenantId: ctx.tenantId,
      task: task.name,
      promptVersion: task.promptVersion,
      inputHash: hash,
      inputRef: { subject },
      actor: actorText(ctx),
      correlationId: ctx.correlationId,
      ...d,
    });
    await publish(
      c,
      aiRunCompleted,
      {
        runId: id,
        task: task.name,
        promptVersion: task.promptVersion,
        mode: d.mode as AiMode,
        model: d.model ?? null,
        status: d.status as AiStatus,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        costCents: d.costCents,
        subject,
        correlationId: ctx.correlationId,
      },
      subject,
    );
  };
  if (inOwnTx) await withTenant(ctx.tenantId, (tx) => write({ ...ctx, tx }));
  else await write(ctx);
  return id;
}

async function findReusable(
  ctx: ModuleContext,
  taskName: string,
  promptVersion: string,
  hash: string,
  mode: AiMode,
  model: string | null,
  after?: Date,
) {
  const [row] = await ctx.tx
    .select()
    .from(aiRun)
    .where(
      and(
        eq(aiRun.tenantId, ctx.tenantId),
        eq(aiRun.task, taskName),
        eq(aiRun.promptVersion, promptVersion),
        eq(aiRun.inputHash, hash),
        eq(aiRun.status, 'ok'),
        eq(aiRun.mode, mode),
        model === null ? isNull(aiRun.model) : eq(aiRun.model, model),
        gte(aiRun.createdAt, new Date(Date.now() - REUSE_WINDOW_MS)),
        after ? gte(aiRun.createdAt, after) : undefined,
      ),
    )
    .orderBy(desc(aiRun.createdAt))
    .limit(1);
  return row;
}

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
type Attempt = { ok: true; output: unknown; usage: Usage } | { ok: false; errors: string; usage: Usage };

const zodErrors = (e: z.ZodError) => e.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

export const SECOND_TRY_OVER_CAP = 'Stopped before a second try: it could pass the cost limit for this task.';

/**
 * Asks the model, checks the answer, and asks once more with the problems listed if it does not fit. With `capCents`
 * the cap holds for the whole run: the second try is skipped when what the first cost plus its worst case would pass it.
 */
async function completeValidated<O>(
  adapter: AnthropicAdapter,
  base: CompleteRequest,
  schema: z.ZodType<O>,
  prices: ClaudePrices,
  capCents?: number,
): Promise<Attempt> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let user = base.user;
  let errors = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    // The caller gave up (time limit): no second, paid try.
    if (attempt > 0 && base.signal?.aborted) return { ok: false, errors: `The caller stopped waiting.\n${errors}`, usage };
    if (attempt > 0 && capCents !== undefined) {
      const next = prices.worstCase(Math.ceil((base.system.length + user.length) / 4), base.maxTokens);
      if (prices.cost(usage) + next > capCents) return { ok: false, errors: `${SECOND_TRY_OVER_CAP}\n${errors}`, usage };
    }
    const r = await adapter.complete({ ...base, user });
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    usage.cacheReadTokens += r.cacheReadTokens;
    const parsed = schema.safeParse(r.json);
    if (parsed.success) return { ok: true, output: parsed.data, usage };
    errors = zodErrors(parsed.error);
    user = `${base.user}\n\nYour previous reply did not match the required format:\n${errors}\nReply again with JSON that fixes these problems.`;
  }
  return { ok: false, errors, usage };
}

const UNAVAILABLE_DETAIL = {
  no_key: NO_KEY,
  cap: 'This would cost more than the limit set for this task.',
  off: 'This task is turned off in Settings.',
} as const;
const unavailable = (why: keyof typeof UNAVAILABLE_DETAIL) =>
  new ScoutError({ slug: 'ai_unavailable', status: 409, title: NO_KEY, detail: UNAVAILABLE_DETAIL[why] });
const noUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCents: 0 };

/**
 * The one way to run an AI task. Picks live, mock or rules (ai-tasks/rules-fallback.md), reuses a
 * recent identical run, validates the output and records an `ai_run` row and an `ai.run.completed` event.
 */
export async function runTask<I, O>(
  ctx: ModuleContext,
  task: TaskDef<I, O>,
  rawInput: I,
  opts: RunOpts,
): Promise<RunResult<O>> {
  const parsedInput = task.input.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new ScoutError({
      slug: 'invalid_input',
      status: 422,
      title: `The input for ${task.name} is not valid.`,
      errors: parsedInput.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const input = parsedInput.data;
  const hash = inputHash(input);
  const [setting] = await ctx.tx
    .select()
    .from(aiSetting)
    .where(and(eq(aiSetting.tenantId, ctx.tenantId), eq(aiSetting.task, task.name)));
  const model = setting?.model ?? task.model;
  const reusable = (mode: AiMode) =>
    opts.fresh && !opts.reuseAfter ? undefined : findReusable(ctx, task.name, task.promptVersion, hash, mode, mode === 'rules' ? null : model, opts.reuseAfter);
  const reuse = (row: AiRunRow): RunResult<O> => ({ output: row.output as O, runId: row.id, mode: row.mode as AiMode });
  const costCap = setting?.maxCostCentsPerRun ?? task.maxCostCents;
  const user = task.buildUser(input);

  // 1. Which mode would run?
  let tentative: 'mock' | 'live' | 'none' = 'none';
  if (setting?.enabled !== false && !opts.rulesOnly) {
    if (config.forceMock || ctx.environment === 'test') tentative = 'mock';
    else {
      const st = await connectionStatus(ctx, PROVIDER);
      tentative = st.status === 'disabled' ? 'none' : st.mode === 'mock' ? 'mock' : 'live';
    }
  }

  if (tentative !== 'none') {
    const hit = await reusable(tentative);
    if (hit) return reuse(hit);
  }
  // Read before the call: a timed-out job's transaction is gone when a late answer is priced. The tenant's rates
  // whatever the tentative mode, so a call that turns live meanwhile is priced right.
  const prices = tentative === 'none' ? undefined : await claudePrices(ctx, model);

  // 2. A call that could cost more than the limit is refused before it is made.
  let capRefused = false;
  const noRules = !task.rules || opts.allowRules === false;
  if (tentative === 'live' && prices && costCap !== undefined) {
    const worst = prices.worstCase(Math.ceil((task.system.length + user.length) / 4), task.maxTokens);
    if (worst > costCap) {
      capRefused = true;
      tentative = 'none';
      await record(ctx, task, hash, opts.subject, {
        mode: 'live',
        model,
        status: 'refused_by_cap',
        output: null,
        error: `Could cost up to ${worst} cents; the limit is ${costCap}.`,
        durationMs: 0,
        ...noUsage,
      }, noRules);
    }
  }

  // 3. Mock or live, through the gateway.
  if (tentative !== 'none' && prices) {
    const mode = tentative;
    const started = performance.now();
    let entered = false;
    /** Whether the gateway reached live Claude: only that is priced, even if the mode changed since step 1. */
    let live = false;
    const callOpts = {
      module: 'ai-tasks',
      unit: 'tokens',
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      requestSummary: { task: task.name, promptVersion: task.promptVersion, model },
      // Held against Claude's monthly cost limit before the call; mock calls hold it too, so the limit works locally.
      reserveCents: prices.worstCase(Math.ceil((task.system.length + user.length) / 4), task.maxTokens),
      // Both attempts' tokens are counted. Cost is only logged for live calls.
      measure: (a: Attempt, call: { live: boolean }) => {
        live = call.live;
        return { units: a.usage.inputTokens + a.usage.outputTokens + a.usage.cacheReadTokens, costCents: live ? prices.cost(a.usage) : 0 };
      },
    };
    try {
      const attempt = await gateway.call(
        ctx,
        PROVIDER,
        `messages.${task.name}`,
        async (adapter) => {
          entered = true;
          const mockOutput = mode === 'mock' && task.mock ? task.mock(input) : undefined;
          const a = await completeValidated(
            adapter as AnthropicAdapter,
            {
              model,
              system: task.system,
              user,
              maxTokens: task.maxTokens,
              jsonSchema: z.toJSONSchema(task.output, { io: 'output' }),
              cacheSystem: true,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              ...(mockOutput !== undefined ? { mockOutput } : {}),
            },
            task.output,
            prices,
            mode === 'live' ? costCap : undefined,
          );
          return a;
        },
        callOpts,
      );
      const durationMs = Math.round(performance.now() - started);
      const cost = live ? prices.cost(attempt.usage) : 0;
      if (attempt.ok) {
        const runId = await record(ctx, task, hash, opts.subject, {
          mode,
          model,
          status: 'ok',
          output: attempt.output,
          error: null,
          ...attempt.usage,
          costCents: cost,
          durationMs,
          // A paid run is kept even if the caller then rolls back (a job that times out), so its retry reuses it.
        }, mode === 'live');
        return { output: attempt.output as O, runId, mode };
      }
      await record(
        ctx,
        task,
        hash,
        opts.subject,
        {
          mode,
          model,
          status: 'invalid_output',
          output: null,
          error: attempt.errors.slice(0, 500),
          ...attempt.usage,
          costCents: cost,
          durationMs,
        },
        true,
      );
      throw new ScoutError({
        slug: 'invalid_output',
        status: 502,
        title: `The ${task.name} task returned output that could not be used.`,
        detail: 'Try again. If it keeps happening, contact support.',
      });
    } catch (e) {
      if (e instanceof ScoutError && e.slug === 'invalid_output') throw e;
      if (!entered && e instanceof ScoutError && e.slug === 'blocked_by_cap') {
        // Claude's usage limit is reached: recorded, then rules below; with no rules the refusal stands, so a job waits (Ruling 10).
        await record(ctx, task, hash, opts.subject, {
          mode,
          model,
          status: 'refused_by_cap',
          output: null,
          error: e.message.slice(0, 500),
          durationMs: Math.round(performance.now() - started),
          ...noUsage,
        }, noRules);
        if (noRules) throw e;
      } else if (!entered && e instanceof ScoutError && FALLBACK_SLUGS.has(e.slug)) {
        // No live Claude right now: continue to rules below.
      } else {
        const message = e instanceof Error ? e.message : String(e);
        await record(
          ctx,
          task,
          hash,
          opts.subject,
          {
            mode,
            model,
            status: 'error',
            output: null,
            error: message.slice(0, 500),
            durationMs: Math.round(performance.now() - started),
            ...noUsage,
          },
          true,
        );
        throw new ScoutError({
          slug: 'ai_failed',
          status: 502,
          title: `The ${task.name} task failed.`,
          detail: "Claude didn't return a usable answer. Try again.",
        });
      }
    }
  }

  // 4. Rules, or a clear message.
  if (!task.rules || opts.allowRules === false) throw unavailable(capRefused ? 'cap' : setting?.enabled === false ? 'off' : 'no_key');
  const hit = await reusable('rules');
  if (hit) return reuse(hit);
  const started = performance.now();
  const output = task.output.parse(task.rules(input));
  const runId = await record(ctx, task, hash, opts.subject, {
    mode: 'rules',
    model: null,
    status: 'ok',
    output,
    error: capRefused ? 'Over the cost limit for this task.' : null,
    durationMs: Math.round(performance.now() - started),
    ...noUsage,
  });
  return { output, runId, mode: 'rules' };
}

export async function getRun(ctx: ModuleContext, runId: string): Promise<AiRunRow | undefined> {
  const [row] = await ctx.tx.select().from(aiRun).where(and(eq(aiRun.tenantId, ctx.tenantId), eq(aiRun.id, runId)));
  return row;
}

export type RunFilter = { task?: string; status?: AiStatus | AiStatus[]; mode?: AiMode; from?: Date; to?: Date; limit?: number };

export async function listRuns(ctx: ModuleContext, f: RunFilter = {}): Promise<AiRunRow[]> {
  return ctx.tx
    .select()
    .from(aiRun)
    .where(
      and(
        eq(aiRun.tenantId, ctx.tenantId),
        f.task ? eq(aiRun.task, f.task) : undefined,
        f.status ? inArray(aiRun.status, ([] as AiStatus[]).concat(f.status)) : undefined,
        f.mode ? eq(aiRun.mode, f.mode) : undefined,
        f.from ? gte(aiRun.createdAt, f.from) : undefined,
        f.to ? lte(aiRun.createdAt, f.to) : undefined,
      ),
    )
    .orderBy(desc(aiRun.createdAt), desc(aiRun.id))
    .limit(Math.min(f.limit ?? 200, 1000));
}

/** Runs, tokens and cost per task since the start of this month (UTC). */
export async function runTotalsThisMonth(
  ctx: ModuleContext,
): Promise<{ task: string; runs: number; inputTokens: number; outputTokens: number; costCents: number }[]> {
  return ctx.tx
    .select({
      task: aiRun.task,
      runs: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiRun.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiRun.outputTokens}), 0)::int`,
      costCents: sql<number>`coalesce(sum(${aiRun.costCents}), 0)::int`,
    })
    .from(aiRun)
    .where(
      and(
        eq(aiRun.tenantId, ctx.tenantId),
        gte(aiRun.createdAt, sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`),
      ),
    )
    .groupBy(aiRun.task)
    .orderBy(aiRun.task);
}
