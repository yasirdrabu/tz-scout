// Fix round: retries never pay twice, the last run always leaves a brief, freezes hold, double clicks spend once,
// and a stuck draft is swept.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
import { anthropicMock } from '@/modules/ai-tasks/adapters/anthropic/mock';
import { registerAdapter, saveCredential, setMode, testConnection } from '@/modules/integrations';
import { briefDraftHandler, briefFreeze, briefUnfreezeOnDeclined, briefUnfreezeOnWithdrawn, requestDraft, runDraft, sweepBriefs, type BriefOutput } from '@/modules/playbooks';
import { brief } from '@/modules/playbooks/db/schema';
import { assign, decline } from '@/modules/routing';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema, type Envelope } from '@/platform/events/envelope';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { cfg } from '../integrations/cfg';
import { newKey } from '../integrations/helpers';
import { member } from '../routing/helpers';
import { asPerson, briefRow, briefRuns, deferred, draftJobs, routingTenant, scoredAccount, sectionRows, type Tenant } from './helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});

const claudeBrief: BriefOutput = {
  recommendation: { headline: 'Approve it and send it to the transit team.', detail: 'The fare system work is open now.' },
  sections: {
    overview: { text: 'Claude overview.', citations: [] },
    approach: { text: 'Claude approach.', citations: [] },
    valueAngle: { text: 'Claude value angle.', citations: [] },
    risks: { text: 'Claude risks.', citations: [] },
    whyNow: { text: 'Claude why now.', citations: [] },
  },
  opener: { subject: 'Your fare system', body: 'Hi there, I saw the new fare system plans.' },
  whoFirst: { personId: null, title: 'COO', reason: 'Runs operations.' },
};

function fakeLive(gate?: Promise<void>) {
  const started = deferred();
  const complete = vi.fn(async () => {
    started.resolve();
    if (gate) await gate;
    return { json: claudeBrief, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };
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

/** Unsent outbox rows of one type, oldest first. */
async function pending(tenantId: string, type: string): Promise<Envelope[]> {
  const rows = await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt))).orderBy(asc(outbox.seq));
  return rows.map((r) => EnvelopeSchema.parse(r.payload) as Envelope).filter((e) => e.type === type);
}
const markAllSent = (tenantId: string) => adminDb.update(outbox).set({ sentAt: new Date() }).where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt)));

describe('draft retries and the last attempt (fix 1)', () => {
  it('a run that times out after Claude answered does not pay again on retry', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const live = fakeLive();
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const [job] = await pending(t.tenantId, 'jobs.playbooks.brief.draft');
    const data = job!.data as Parameters<typeof runDraft>[1];
    const meta = { jobId: job!.id, queuedAt: new Date(job!.occurredAt) };
    // The first run gets its answer, then its transaction is rolled back (as a timeout does).
    await expect(
      t.run(async (ctx) => {
        await runDraft(ctx, data, meta, new Date());
        throw new Error('timed out');
      }),
    ).rejects.toThrow('timed out');
    expect(live.complete).toHaveBeenCalledTimes(1);
    await runOutbox(t.tenantId);
    expect(live.complete).toHaveBeenCalledTimes(1);
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready', mode: 'live', draftAttempts: 2 });
  });

  it('the last attempt drafts from rules without calling Claude, so the account always has a brief', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const live = fakeLive();
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const [job] = await pending(t.tenantId, 'jobs.playbooks.brief.draft');
    await adminDb.update(brief).set({ draftJobId: job!.id, draftAttempts: 2 }).where(eq(brief.accountId, id));
    await runOutbox(t.tenantId);
    expect(live.complete).not.toHaveBeenCalled();
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready', mode: 'rules', draftAttempts: 3 });
  });
});

describe('a timed-out Claude call (fix round 2, item 1)', () => {
  it('aborts the call, and when it completes anyway the retry reuses it instead of paying again', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const gate = deferred();
    let seen: AbortSignal | undefined;
    const complete = vi.fn(async (req: { signal?: AbortSignal }) => {
      seen = req.signal;
      await gate.promise; // a slow call that ignores the abort
      return { json: claudeBrief, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };
    });
    const adapter: AnthropicAdapter = { test: async () => ({ ok: true, message: 'ok' }), complete: complete as unknown as AnthropicAdapter['complete'] };
    registerAdapter('anthropic', { mock: () => anthropicMock, live: () => adapter });
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const [job] = await pending(t.tenantId, 'jobs.playbooks.brief.draft');
    const short = { ...briefDraftHandler, job: { ...briefDraftHandler.job, opts: { ...briefDraftHandler.job.opts, timeoutMs: 300 } } };
    await expect(deliverOnce(short, job!)).rejects.toThrow(/did not finish within/);
    expect(seen?.aborted).toBe(true);
    gate.resolve();
    // The late answer is recorded in its own transaction.
    for (let i = 0; i < 50 && (await briefRuns(t.tenantId)).filter((r) => r.mode === 'live' && r.status === 'ok').length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await deliverOnce(briefDraftHandler, job!);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready', mode: 'live' });
  });

  it('retries a draft only after the worst Claude call is over', () => {
    expect(briefDraftHandler.job.opts.backoffMs![0]).toBeGreaterThan(briefDraftHandler.job.opts.timeoutMs!);
  });
});

describe('freezing (fixes 3 and 4)', () => {
  it('an assignment made while a draft runs keeps the draft from writing', async () => {
    const t = await routingTenant();
    const seller = await member(t, 'seller');
    const id = await scoredAccount(t, 'act_now');
    const before = await sectionRows(id);
    const gate = deferred();
    const live = fakeLive(gate.promise);
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id));
    const drafting = runOutbox(t.tenantId);
    await live.started;
    await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: seller }));
    const [created] = await pending(t.tenantId, 'routing.assignment.created');
    await deliverOnce(briefFreeze, created!);
    gate.resolve();
    await drafting;
    expect((await sectionRows(id)).map((s) => [s.key, s.version, s.body])).toEqual(before.map((s) => [s.key, s.version, s.body]));
    const row = (await briefRow(id))!;
    expect(row).toMatchObject({ draftState: 'ready', mode: 'mock' });
    expect(row.draftedSeq).toBe(row.requestedSeq);
    expect(row.frozenAt).not.toBeNull();
  });

  it('a decline processed after a reassign does not unfreeze; a freeze for an answered assignment does not stick', async () => {
    const t = await routingTenant();
    const [s1, s2] = [await member(t, 'seller'), await member(t, 'seller')];
    const id = await scoredAccount(t, 'watch');
    await markAllSent(t.tenantId);
    const a = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s1 }));
    await asPerson(t, (ctx) => decline(ctx, a.id, { reasonKey: 'not_a_fit' }), { userId: s1, dataLimit: { kind: 'own_accounts' } });
    const b = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s2 }));
    const created = await pending(t.tenantId, 'routing.assignment.created');
    const [declined] = await pending(t.tenantId, 'routing.assignment.declined');
    await markAllSent(t.tenantId);
    const byId = (x: string) => created.find((e) => (e.data as { assignmentId: string }).assignmentId === x)!;

    // A's freeze arrives after A was declined: ignored. B's freeze holds. A's decline, late, leaves B's freeze.
    await deliverOnce(briefFreeze, byId(a.id));
    expect((await briefRow(id))!.frozenAt).toBeNull();
    await deliverOnce(briefFreeze, byId(b.id));
    expect(await briefRow(id)).toMatchObject({ frozenByAssignmentId: b.id });
    await deliverOnce(briefUnfreezeOnDeclined, declined!);
    expect(await briefRow(id)).toMatchObject({ frozenByAssignmentId: b.id });
    expect((await briefRow(id))!.frozenAt).not.toBeNull();
  });
});

describe('withdrawal hand-off (fix round 2, item 4)', () => {
  it('a reassignment whose new AE already declined does not hand the freeze on', async () => {
    const t = await routingTenant();
    const [s1, s2] = [await member(t, 'seller'), await member(t, 'seller')];
    const id = await scoredAccount(t, 'watch');
    await markAllSent(t.tenantId);
    const a = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s1 }));
    const [createdA] = await pending(t.tenantId, 'routing.assignment.created');
    await deliverOnce(briefFreeze, createdA!);
    await markAllSent(t.tenantId);
    const b = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s2 }));
    await asPerson(t, (ctx) => decline(ctx, b.id, { reasonKey: 'not_a_fit' }), { userId: s2, dataLimit: { kind: 'own_accounts' } });
    const [withdrawn] = await pending(t.tenantId, 'routing.assignment.withdrawn');
    expect(withdrawn!.data).toMatchObject({ assignmentId: a.id, replacedBy: b.id });
    await deliverOnce(briefUnfreezeOnWithdrawn, withdrawn!);
    const row = (await briefRow(id))!;
    expect(row.frozenAt).toBeNull();
    expect(row.frozenByAssignmentId).toBeNull();
  });
});

describe('double clicks (fix 10)', () => {
  it('two manual requests in a row make one Claude run', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const live = fakeLive();
    await goLive(t);
    const first = await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const second = await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    expect(first).toEqual({ state: 'drafting', queued: true });
    expect(second).toEqual({ state: 'drafting', queued: false });
    await runOutbox(t.tenantId);
    expect(live.complete).toHaveBeenCalledTimes(1);
  });

  it('a second manual request while the first is running joins it', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'act_now');
    const gate = deferred();
    const live = fakeLive(gate.promise);
    await goLive(t);
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    const drafting = runOutbox(t.tenantId);
    await live.started;
    expect(await t.run((ctx) => requestDraft(ctx, id, { manual: true }))).toEqual({ state: 'drafting', queued: false });
    gate.resolve();
    await drafting;
    expect(live.complete).toHaveBeenCalledTimes(1);
    expect(await draftJobs(t.tenantId, id)).toBe(2); // the first draft and the manual one; no third
  });

  it('a job whose request a newer draft already covered does nothing', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    const row = (await briefRow(id))!;
    await t.run((ctx) => runDraft(ctx, { accountId: id, manual: false, includeEdited: [], seq: row.draftedSeq }, { jobId: 'job_dup', queuedAt: new Date() }, new Date()));
    expect(await briefRow(id)).toMatchObject({ draftAttempts: row.draftAttempts, draftJobId: row.draftJobId, updatedAt: row.updatedAt });
  });
});

describe('stuck drafts (fix 6)', () => {
  const age = (id: string) => adminDb.execute(sql`update playbooks.brief set updated_at = now() - interval '20 minutes' where account_id = ${id}`);

  it('the sweep queues a stuck draft again, and settles one with nothing left to draft', async () => {
    const t = await routingTenant();
    const stuck = await scoredAccount(t, 'watch');
    const settled = await scoredAccount(t, 'watch');
    await adminDb.execute(sql`update playbooks.brief set draft_state = 'drafting', requested_seq = drafted_seq + 1 where account_id = ${stuck}`);
    await adminDb.execute(sql`update playbooks.brief set draft_state = 'drafting' where account_id = ${settled}`);
    await age(stuck);
    await age(settled);
    const jobs = await draftJobs(t.tenantId, stuck);
    expect(await t.run((ctx) => sweepBriefs(ctx, new Date()))).toEqual({ queued: 1, settled: 1 });
    expect(await draftJobs(t.tenantId, stuck)).toBe(jobs + 1);
    expect(await briefRow(settled)).toMatchObject({ draftState: 'ready' });
    await runOutbox(t.tenantId);
    expect(await briefRow(stuck)).toMatchObject({ draftState: 'ready' });
    const row = (await briefRow(stuck))!;
    expect(row.draftedSeq).toBe(row.requestedSeq);
  });

  it('a stuck draft on a frozen brief is settled by the next request', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    await adminDb.execute(sql`update playbooks.brief set draft_state = 'drafting', frozen_at = now() where account_id = ${id}`);
    await age(id);
    expect(await t.run((ctx) => requestDraft(ctx, id))).toEqual({ state: 'ready', queued: false });
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready' });
  });

  it('every new tenant gets the sweep schedule', async () => {
    const t = await routingTenant();
    const rows = (await adminDb.execute(
      sql`select cron from platform.schedule where tenant_id = ${t.tenantId} and job_name = 'playbooks.brief.sweep'`,
    )) as unknown as { cron: string }[];
    expect(rows.map((r) => r.cron)).toEqual(['*/15 * * * *']);
  });
});
