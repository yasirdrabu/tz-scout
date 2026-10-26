import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  const { cfg } = await import('../integrations/cfg');
  const over = cfg as Record<string, unknown>;
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, p) => (over[p as string] !== undefined ? over[p as string] : (t as never)[p]),
    }),
  };
});

import { AI_LABEL, defineTask, getRun, listRuns, runTask, runTotalsThisMonth } from '@/modules/ai-tasks';
import type { AnthropicAdapter } from '@/modules/ai-tasks';
import { anthropicMock, registerAnthropicAdapter } from '@/modules/ai-tasks/adapters/anthropic/mock';
import { aiRun } from '@/modules/ai-tasks/db/schema';
import { costCents } from '@/modules/ai-tasks/pricing';
import { canonicalJson } from '@/modules/ai-tasks/runner';
import { registerAdapter, saveCredential, setDisabled, setMode, testConnection } from '@/modules/integrations';
import { connection } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { cfg } from '../integrations/cfg';
import { freshTenant, newKey } from '../integrations/helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});

const echo = defineTask({
  name: 'echo_test',
  promptVersion: 'v1.0',
  model: 'claude-haiku-5-5',
  system: 'Echo the text.',
  buildUser: (i: { text: string }) => `Text: ${i.text}`,
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  rules: (i) => ({ echoed: i.text }),
  mock: (i) => ({ echoed: `mock ${i.text}` }),
  maxTokens: 200,
});
const noRules = defineTask({ ...echo, name: 'echo_no_rules', rules: undefined });
const subject = { type: 'test', id: 'x1' };

type Tenant = Awaited<ReturnType<typeof freshTenant>>;

/** Registers a fake live Claude adapter. Each call returns the next reply (the last one repeats). */
function fakeLive(replies: unknown[], tokens = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0 }) {
  let n = 0;
  const complete = vi.fn(async (_req: { user: string }) => ({ json: replies[Math.min(n++, replies.length - 1)], ...tokens }));
  const adapter: AnthropicAdapter = {
    async test() {
      return { ok: true, message: 'Claude answered.' };
    },
    complete: complete as unknown as AnthropicAdapter['complete'],
  };
  registerAdapter('anthropic', { mock: () => anthropicMock, live: () => adapter });
  return complete;
}

async function goLive(t: Tenant) {
  await t.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
  await t.run((ctx) => testConnection(ctx, 'anthropic'));
  await t.run((ctx) => setMode(ctx, 'anthropic', 'live'));
}

/** Live mode with no saved credential (cannot be reached through the public flow). */
async function liveWithoutKey(t: Tenant) {
  await t.run((ctx) => setMode(ctx, 'anthropic', 'mock'));
  await adminDb.update(connection).set({ mode: 'live' }).where(eq(connection.tenantId, t.tenantId));
}

const runsOf = (tenantId: string) =>
  adminDb.select().from(aiRun).where(eq(aiRun.tenantId, tenantId)).orderBy(aiRun.createdAt, aiRun.id);
const eventsOf = (tenantId: string) =>
  adminDb
    .select()
    .from(outbox)
    .where(sql`${outbox.tenantId} = ${tenantId} and ${outbox.payload}->>'type' = 'ai.run.completed'`);

describe('runTask', () => {
  it('uses the mock in mock mode and records a run and an event', async () => {
    registerAnthropicAdapter();
    const t = await freshTenant();
    const r = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(r.mode).toBe('mock');
    expect(r.output).toEqual({ echoed: 'mock hi' });
    const rows = await runsOf(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.runId,
      mode: 'mock',
      status: 'ok',
      task: 'echo_test',
      promptVersion: 'v1.0',
      costCents: 0,
    });
    expect(rows[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await eventsOf(t.tenantId);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.payload as { data: { runId: string } }).data.runId).toBe(r.runId);
  });

  it('returns a schema-valid minimal object from the mock when the task has no sample', async () => {
    registerAnthropicAdapter();
    const t = await freshTenant();
    const bare = defineTask({ ...echo, name: 'echo_bare', mock: undefined });
    expect((await t.run((ctx) => runTask(ctx, bare, { text: 'hi' }, { subject }))).output).toEqual({ echoed: '' });
  });

  it('runs live with a key and records tokens and cost (AI-E1-S1-AC1)', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ echoed: 'hi' }]);
    await goLive(t);
    const r = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(r).toMatchObject({ mode: 'live', output: { echoed: 'hi' } });
    expect(complete).toHaveBeenCalledTimes(1);
    const [row] = await runsOf(t.tenantId);
    expect(row).toMatchObject({ mode: 'live', model: 'claude-haiku-5-5', inputTokens: 120, outputTokens: 30 });
    expect(row!.costCents).toBeGreaterThan(0);
  });

  it('retries once with the errors, then stores invalid_output and names the task (AC2)', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ wrong: 1 }, { wrong: 2 }]);
    await goLive(t);
    const err = (await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject })).catch((e) => e)) as Error;
    expect(err.message).toContain('echo_test');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].user).toContain('echoed');
    // Written in its own transaction, so it survives the caller's rollback.
    const rows = await runsOf(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'invalid_output', mode: 'live', inputTokens: 240 });
    expect(await eventsOf(t.tenantId)).toHaveLength(1);
  });

  it('succeeds when the retry fixes the output', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ nope: 1 }, { echoed: 'ok' }]);
    await goLive(t);
    const r = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(r.output).toEqual({ echoed: 'ok' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('records an error run when the adapter throws', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ echoed: 'hi' }]);
    complete.mockRejectedValue(new Error('upstream down'));
    await goLive(t);
    await expect(t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }))).rejects.toMatchObject({
      slug: 'ai_failed',
    });
    expect((await runsOf(t.tenantId))[0]).toMatchObject({ status: 'error', error: 'upstream down' });
  });

  it('reuses an identical ok run within 24 hours unless fresh (AI-E1-S2-AC1)', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ echoed: 'hi' }]);
    await goLive(t);
    const a = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    const b = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(b.runId).toBe(a.runId);
    expect(complete).toHaveBeenCalledTimes(1);
    const c = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject, fresh: true }));
    expect(c.runId).not.toBe(a.runId);
    expect(complete).toHaveBeenCalledTimes(2);
    await adminDb.execute(sql`update ai.ai_run set created_at = now() - interval '25 hours' where tenant_id = ${t.tenantId}`);
    const d = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect([a.runId, c.runId]).not.toContain(d.runId);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('does not serve a rules run once live is available', async () => {
    const t = await freshTenant();
    await liveWithoutKey(t);
    const rules = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(rules.mode).toBe('rules');
    const complete = fakeLive([{ echoed: 'from claude' }]);
    await goLive(t);
    const live = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(live).toMatchObject({ mode: 'live', output: { echoed: 'from claude' } });
    expect(live.runId).not.toBe(rules.runId);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('falls back to rules when live has no credential (AI-E2-S1-AC1) and says so without rules', async () => {
    const t = await freshTenant();
    fakeLive([{ echoed: 'x' }]);
    await liveWithoutKey(t);
    const r = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(r).toMatchObject({ mode: 'rules', output: { echoed: 'hi' } });
    expect((await runsOf(t.tenantId))[0]).toMatchObject({ mode: 'rules', model: null, costCents: 0 });
    const err = await t.run((ctx) => runTask(ctx, noRules, { text: 'hi' }, { subject })).catch((e) => e as Error);
    expect(err).toMatchObject({ slug: 'ai_unavailable', detail: 'Add a Claude key to use this.' });
    expect((err as Error).message).toBe('Add a Claude key to use this.');
    await expect(
      t.run((ctx) => runTask(ctx, echo, { text: 'zz' }, { subject, allowRules: false })),
    ).rejects.toMatchObject({ slug: 'ai_unavailable' });
  });

  it('uses rules when the connection is disabled, and the mock for test keys', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setDisabled(ctx, 'anthropic', true));
    expect((await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }))).mode).toBe('rules');
    const t2 = await freshTenant();
    const test = await t2.run((ctx) => runTask({ ...ctx, environment: 'test' }, echo, { text: 'k' }, { subject }));
    expect(test.mode).toBe('mock');
  });

  it('refuses a call that could pass the cost limit and uses rules', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ echoed: 'hi' }]);
    await goLive(t);
    const pricey = defineTask({ ...echo, name: 'echo_pricey', model: 'claude-opus-5-5', maxTokens: 100_000, maxCostCents: 5 });
    const r = await t.run((ctx) => runTask(ctx, pricey, { text: 'hi' }, { subject }));
    expect(r.mode).toBe('rules');
    expect(complete).not.toHaveBeenCalled();
    expect((await runsOf(t.tenantId)).map((x) => x.status).sort()).toEqual(['ok', 'refused_by_cap']);
  });

  it('rejects invalid input, and lists, gets and totals runs', async () => {
    const t = await freshTenant();
    await expect(t.run((ctx) => runTask(ctx, echo, { text: 5 } as never, { subject }))).rejects.toMatchObject({
      slug: 'invalid_input',
    });
    const a = await t.run((ctx) => runTask(ctx, echo, { text: 'a' }, { subject }));
    await t.run((ctx) => runTask(ctx, echo, { text: 'b' }, { subject }));
    await t.run(async (ctx) => {
      expect((await getRun(ctx, a.runId))?.id).toBe(a.runId);
      expect(await listRuns(ctx)).toHaveLength(2);
      expect(await listRuns(ctx, { mode: 'rules' })).toHaveLength(0);
      const window = { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) };
      expect(await listRuns(ctx, { task: 'echo_test', status: 'ok', ...window })).toHaveLength(2);
      expect(await runTotalsThisMonth(ctx)).toEqual([expect.objectContaining({ task: 'echo_test', runs: 2 })]);
    });
    const other = await freshTenant();
    await other.run(async (ctx) => expect(await getRun(ctx, a.runId)).toBeUndefined());
  });
});

describe('helpers', () => {
  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[{"x":2,"y":1}]},"b":1}');
  });
  it('prices round up and unknown models cost nothing', () => {
    expect(costCents('claude-haiku-5-5', { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 })).toBe(1);
    expect(costCents('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 })).toBe(600);
    expect(costCents('nope', { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0 })).toBe(0);
  });
  it('labels', () => {
    expect(AI_LABEL).toEqual({ live: 'Written by Claude', rules: 'Assembled from rules', mock: 'Sample output' });
  });
});

describe('runTask fix round 1', () => {
  it('falls back to rules when live has a credential but no live adapter is registered', async () => {
    const t = await freshTenant();
    registerAdapter('anthropic', { mock: () => anthropicMock });
    await t.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
    await adminDb.update(connection).set({ mode: 'live' }).where(eq(connection.tenantId, t.tenantId));
    const r = await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(r).toMatchObject({ mode: 'rules', output: { echoed: 'hi' } });
  });

  it('logs units and cost on the call log, counting both attempts', async () => {
    const t = await freshTenant();
    fakeLive([{ bad: 1 }, { echoed: 'ok' }]);
    await goLive(t);
    await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    const [row] = (await adminDb.execute(
      sql`select units, cost_cents, unit from integrations.call_log where tenant_id = ${t.tenantId} and provider = 'anthropic' and operation = 'messages.echo_test'`,
    )) as unknown as { units: number; cost_cents: number; unit: string }[];
    expect(row).toMatchObject({ units: 300, unit: 'tokens' });
    expect(row!.cost_cents).toBeGreaterThan(0);
  });

  it('gives distinct reasons when there are no rules', async () => {
    const t = await freshTenant();
    fakeLive([{ echoed: 'hi' }]);
    await goLive(t);
    const pricey = defineTask({ ...noRules, name: 'p_no_rules', model: 'claude-opus-5-5', maxTokens: 100_000, maxCostCents: 5 });
    const err = (await t.run((ctx) => runTask(ctx, pricey, { text: 'hi' }, { subject })).catch((e) => e)) as { detail: string };
    expect(err.detail).toBe('This would cost more than the limit set for this task.');
    // The refusal row is kept even though the caller rolled back.
    expect((await runsOf(t.tenantId)).map((x) => x.status)).toEqual(['refused_by_cap']);
    await adminDb.execute(sql`insert into ai.ai_setting (tenant_id, task, enabled) values (${t.tenantId}, 'echo_no_rules', false)`);
    const off = (await t.run((ctx) => runTask(ctx, noRules, { text: 'hi' }, { subject })).catch((e) => e)) as { detail: string };
    expect(off.detail).toBe('This task is turned off in Settings.');
  });

  it('does not reuse a run made with another model', async () => {
    const t = await freshTenant();
    const complete = fakeLive([{ echoed: 'hi' }]);
    await goLive(t);
    await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    await adminDb.execute(sql`insert into ai.ai_setting (tenant_id, task, model) values (${t.tenantId}, 'echo_test', 'claude-sonnet-5-5')`);
    await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject }));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('hides upstream text in ai_failed and hashes dates and bigints', async () => {
    const t = await freshTenant();
    fakeLive([{ echoed: 'hi' }]).mockRejectedValue(new Error('secret upstream text'));
    await goLive(t);
    const err = (await t.run((ctx) => runTask(ctx, echo, { text: 'hi' }, { subject })).catch((e) => e)) as { detail: string };
    expect(err.detail).toBe("Claude didn't return a usable answer. Try again.");
    expect((await runsOf(t.tenantId))[0]!.error).toBe('secret upstream text');
    expect(canonicalJson({ d: new Date('2026-01-01T00:00:00Z'), n: 5n })).toBe('{"d":"2026-01-01T00:00:00.000Z","n":"5"}');
  });
});
