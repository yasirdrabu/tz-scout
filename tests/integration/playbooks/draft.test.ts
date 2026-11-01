import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { AnthropicAdapter } from '@/modules/ai-tasks';
import { anthropicMock, registerAnthropicAdapter } from '@/modules/ai-tasks/adapters/anthropic/mock';
import { registerAdapter, saveCredential, setMode, testConnection } from '@/modules/integrations';
import { editSection, getBrief, requestDraft, type BriefOutput } from '@/modules/playbooks';
import { runOutbox } from '../helpers/run-outbox';
import { cfg } from '../integrations/cfg';
import { newKey } from '../integrations/helpers';
import { asPerson, briefRow, briefRuns, deferred, draftJobs, historyRows, routingTenant, scoredAccount, sectionRows, type Tenant } from './helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});

const claudeBrief: BriefOutput = {
  recommendation: { headline: 'Approve it and send it to the transit team.', detail: 'The fare system work is open now.' },
  sections: {
    overview: { text: 'Claude overview.', citations: ['sig_not_in_input'] },
    approach: { text: 'Claude approach.', citations: [] },
    valueAngle: { text: 'Claude value angle.', citations: [] },
    risks: { text: 'Claude risks.', citations: [] },
    whyNow: { text: 'Claude why now.', citations: [] },
  },
  opener: { subject: 'Your fare system', body: 'Hi there, I saw the new fare system plans.' },
  whoFirst: { personId: null, title: 'COO', reason: 'Runs operations.' },
};

/** A fake live Claude. `gate` holds every answer until it resolves; `started` resolves on the first call. */
function fakeLive(reply: unknown, gate?: Promise<void>) {
  const started = deferred();
  const complete = vi.fn(async () => {
    started.resolve();
    if (gate) await gate;
    return { json: reply, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };
  });
  const adapter: AnthropicAdapter = { test: async () => ({ ok: true, message: 'Claude answered.' }), complete: complete as unknown as AnthropicAdapter['complete'] };
  registerAdapter('anthropic', { mock: () => anthropicMock, live: () => adapter });
  return { complete, started: started.promise };
}

async function goLive(t: Tenant) {
  await t.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
  await t.run((ctx) => testConnection(ctx, 'anthropic'));
  await t.run((ctx) => setMode(ctx, 'anthropic', 'live'));
}

const PAGE_KEYS = ['overview', 'approach', 'value_angle', 'risks'];

describe('drafting', () => {
  it('the first score at watch gives a rules brief in one job (PLB-E3-S1-AC1)', async () => {
    registerAnthropicAdapter();
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    expect(await draftJobs(t.tenantId, id)).toBe(1);
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready', mode: 'rules', recommendationOrigin: 'rules' });
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b.sections.map((s) => s.key)).toEqual(PAGE_KEYS);
    expect(b.sections.map((s) => s.label)).toEqual(Array(4).fill('Assembled from rules'));
    expect(b.recommendation).toMatchObject({ headline: 'Keep it in review until a stronger signal arrives.', label: 'Assembled from rules', writtenBy: 'rules' });
    expect(b.whyNow).toMatchObject({ body: 'No dated signals yet.' });
    expect((await briefRuns(t.tenantId)).map((r) => r.mode)).toEqual(['rules']);
  });

  it('a nurture account gets a rules brief like watch, never a Claude draft', async () => {
    registerAnthropicAdapter();
    const t = await routingTenant();
    const id = await scoredAccount(t, 'nurture');
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready', mode: 'rules' });
    expect((await briefRuns(t.tenantId)).map((r) => r.mode)).toEqual(['rules']);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b.recommendation).toMatchObject({ headline: 'Keep it in review until a stronger signal arrives.', writtenBy: 'rules' });
  });

  it('the first score at act now drafts with the mock: Sample output and the run id (PLB-E3-S1-AC2)', async () => {
    registerAnthropicAdapter();
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const row = await briefRow(id);
    const [run] = await briefRuns(t.tenantId);
    expect(run).toMatchObject({ mode: 'mock', status: 'ok' });
    expect(row).toMatchObject({ draftState: 'ready', mode: 'mock', aiRunId: run!.id });
    expect((await sectionRows(id)).every((s) => s.aiRunId === run!.id && s.origin === 'ai' && s.mode === 'mock')).toBe(true);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b.sections.map((s) => s.label)).toEqual(Array(4).fill('Sample output'));
    expect(b.recommendation!.label).toBe('Sample output');
  });

  it('a live run that returns invalid JSON twice gives a rules brief and keeps last_error (Review Focus 2)', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    fakeLive({ not: 'a brief' });
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    await runOutbox(t.tenantId);
    const row = await briefRow(id);
    expect(row).toMatchObject({ draftState: 'ready', mode: 'rules', recommendationOrigin: 'rules', openerOrigin: 'rules' });
    expect(row!.lastError).toContain('account_brief');
    expect(row!.lastError!.length).toBeLessThanOrEqual(300);
    const runs = (await briefRuns(t.tenantId)).slice(1);
    expect(runs.map((r) => `${r.status}:${r.mode}`).sort()).toEqual(['invalid_output:live', 'ok:rules']);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect([...b.sections.map((s) => s.label), b.recommendation!.label, b.opener!.label, b.whoFirst!.label]).toEqual(Array(7).fill('Assembled from rules'));
  });

  it('a person edits Overview while a draft runs: their text stays, the rest is drafted, history keeps version 1 (Review Focus 1)', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const before = (await sectionRows(id)).find((s) => s.key === 'overview')!;
    const gate = deferred();
    const live = fakeLive(claudeBrief, gate.promise);
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const drafting = runOutbox(t.tenantId);
    await live.started;
    await asPerson(t, (ctx) => editSection(ctx, id, 'overview', { body: 'Our own overview.', ifVersion: before.version }));
    gate.resolve();
    await drafting;

    const rows = await sectionRows(id);
    const overview = rows.find((s) => s.key === 'overview')!;
    expect(overview).toMatchObject({ body: 'Our own overview.', origin: 'human', version: 2 });
    expect(rows.find((s) => s.key === 'approach')).toMatchObject({ body: 'Claude approach.', origin: 'ai', mode: 'live' });
    const history = (await historyRows(id)).filter((h) => h.key === 'overview');
    expect(history.map((h) => [h.version, h.body])).toEqual([[1, before.body]]);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    const name = b.sections[0]!.editedByName!;
    expect(b.sections.map((s) => s.label)).toEqual([`Edited by ${name}`, 'Written by Claude', 'Written by Claude', 'Written by Claude']);
    expect(b.recommendation!.label).toBe('Written by Claude');
  });

  it('drops citations that were not in the input and replaces an opener that is not buyer safe', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    fakeLive({ ...claudeBrief, opener: { subject: 'About the lawsuit', body: 'Hi there, sorry about the lawsuit.' } });
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    await runOutbox(t.tenantId);
    expect((await sectionRows(id)).find((s) => s.key === 'overview')!.citations).toEqual([]);
    const row = await briefRow(id);
    expect(row).toMatchObject({ openerOrigin: 'rules', recommendationOrigin: 'ai' });
    expect(row!.openerBody).not.toMatch(/lawsuit/i);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b.opener!.label).toBe('Assembled from rules');
    expect(b.recommendation!.label).toBe('Written by Claude');
  });
});
