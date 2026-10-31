import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as adminRuns } from '@/app/v1/admin/ai-runs/route';
import { GET as adminRun } from '@/app/v1/admin/ai-runs/[id]/route';
import { GET as tenantRuns } from '@/app/v1/ai-runs/route';
import { GET as tenantRun } from '@/app/v1/ai-runs/[id]/route';
import { aiRun } from '@/modules/ai-tasks/db/schema';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

let admin: Person;
let owner: Person;
let leader: Person;
let alpha: { tenantId: string; slug: string };
let beta: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};
let keySecret: string;
/** A task name only this file uses, so other files' runs do not get in the way. */
const task = `test_task_${newId('cor').toLowerCase()}`;
const ids: Record<string, string> = {};

async function run(tenantId: string, name: string, status: string, extra: Partial<typeof aiRun.$inferInsert> = {}) {
  const id = newId('run');
  ids[name] = id;
  await adminDb.insert(aiRun).values({
    id,
    tenantId,
    task,
    promptVersion: 'v1',
    mode: 'live',
    model: 'claude-test',
    inputHash: 'abc123',
    inputRef: { subject: { type: 'account', id: `acc_${name}` } },
    status,
    output: status === 'ok' ? { brief: 'Fine' } : null,
    error: status === 'ok' ? null : 'Bad answer from ana@example.com',
    inputTokens: 100,
    outputTokens: 50,
    costCents: 3,
    durationMs: 1200,
    actor: 'system:system',
    ...extra,
  });
  return id;
}

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  leader = await seedUser({ signedIn: true });
  alpha = await tenantOwnedBy(admin, owner.email, 'Alpha Runs');
  beta = await tenantOwnedBy(admin, (await seedUser()).email, 'Beta Runs');
  await inTenant(alpha.tenantId, owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
  for (const p of [admin, owner, leader]) cookies[p.id] = await signedIn(p.id);
  keySecret = (
    await inTenant(alpha.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['accounts:read'] }, SYSTEM_GRANTOR),
    )
  ).secret;
  const t0 = Date.now();
  await run(alpha.tenantId, 'a_ok', 'ok', { createdAt: new Date(t0 - 4000) });
  await run(alpha.tenantId, 'a_invalid', 'invalid_output', { createdAt: new Date(t0 - 3000) });
  await run(beta.tenantId, 'b_error', 'error', { createdAt: new Date(t0 - 2000) });
  await run(beta.tenantId, 'b_cap', 'refused_by_cap', { createdAt: new Date(t0 - 1000), costCents: 0 });
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person) => ({ cookies: cookies[p.id] });
type Opts = Parameters<typeof v1Req>[1];
const idsOf = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

async function refusesNonAdmins(call: (opts: Opts) => Promise<Response>) {
  expect((await call(as(owner))).status).toBe(403);
  expect((await call({ headers: { authorization: `Bearer ${keySecret}` } })).status).toBe(403);
  expect((await call({})).status).toBe(401);
}

describe('GET /v1/admin/ai-runs', () => {
  it('lists every tenant\'s runs newest first, with tenant names, screen statuses, tokens, cost and time', async () => {
    const res = await adminRuns(v1Req(`/admin/ai-runs?task=${task}`, as(admin)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(idsOf(body)).toEqual([ids.b_cap, ids.b_error, ids.a_invalid, ids.a_ok]);
    expect(body.data[0]).toMatchObject({
      tenant_id: beta.tenantId,
      tenant_name: 'Beta Runs',
      task,
      status: 'stopped_by_limit',
      outcome: 'refused_by_cap',
      subject: { type: 'account', id: 'acc_b_cap' },
      model: 'claude-test',
      input_tokens: 100,
      output_tokens: 50,
      cost_cents: 0,
      duration_ms: 1200,
    });
    expect(body.data.map((r: { status: string }) => r.status)).toEqual(['stopped_by_limit', 'failed', 'failed', 'succeeded']);
    expect(body.summary).toMatchObject({ runs_today: expect.any(Number), spend_today_cents: expect.any(Number) });
    expect(body.summary.runs_today).toBeGreaterThanOrEqual(4);
    expect(body.summary.failed_last_hour).toBeGreaterThanOrEqual(2);
    expect(body.next_cursor).toBeNull();
  });

  it('filters by status, tenant and search, and pages with a cursor', async () => {
    const get = async (qs: string) => (await (await adminRuns(v1Req(`/admin/ai-runs?task=${task}&${qs}`, as(admin)))).json());
    expect(idsOf(await get('status=failed'))).toEqual([ids.b_error, ids.a_invalid]);
    expect(idsOf(await get('status=succeeded'))).toEqual([ids.a_ok]);
    expect(idsOf(await get('status=stopped_by_limit'))).toEqual([ids.b_cap]);
    expect(idsOf(await get(`tenant=${alpha.tenantId}`))).toEqual([ids.a_invalid, ids.a_ok]);
    expect(idsOf(await get('q=acc_a_ok'))).toEqual([ids.a_ok]);
    expect(idsOf(await get(`q=${ids.b_error!.toLowerCase()}`))).toEqual([ids.b_error]);
    expect(idsOf(await get('q=%25'))).toEqual([]);
    const first = await get('limit=3');
    expect(idsOf(first)).toEqual([ids.b_cap, ids.b_error, ids.a_invalid]);
    const second = await get(`limit=3&cursor=${first.next_cursor}`);
    expect(idsOf(second)).toEqual([ids.a_ok]);
    expect(second.next_cursor).toBeNull();
  });

  it('gives 400 for a bad status, limit or cursor', async () => {
    for (const qs of ['status=ok', 'limit=0', 'cursor=nope']) {
      const res = await adminRuns(v1Req(`/admin/ai-runs?${qs}`, as(admin)));
      expect(res.status).toBe(400);
    }
  });

  it('refuses a tenant owner, an API key and anonymous callers', async () => {
    await refusesNonAdmins((o) => adminRuns(v1Req('/admin/ai-runs', o)));
  });
});

describe('GET /v1/admin/ai-runs/{id}', () => {
  it('gives the run with fingerprint, output and the error with personal details masked', async () => {
    const res = await adminRun(v1Req(`/admin/ai-runs/${ids.a_invalid}`, as(admin)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: ids.a_invalid,
      tenant_name: 'Alpha Runs',
      input_hash: 'abc123',
      output: null,
      error: 'Bad answer from [email]',
    });
    expect((await adminRun(v1Req('/admin/ai-runs/run_nope', as(admin)))).status).toBe(404);
  });

  it('refuses non-admins', async () => {
    await refusesNonAdmins((o) => adminRun(v1Req(`/admin/ai-runs/${ids.a_ok}`, o)));
  });
});

describe('GET /v1/ai-runs (tenant owners)', () => {
  it('lists only this workspace\'s runs, with this month\'s totals', async () => {
    const res = await tenantRuns(v1Req(`/ai-runs?task=${task}`, { ...as(owner), tenant: alpha.slug }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(idsOf(body)).toEqual([ids.a_invalid, ids.a_ok]);
    expect(body.data[0]).toMatchObject({ status: 'failed', outcome: 'invalid_output' });
    expect(body.totals).toContainEqual({ task, runs: 2, input_tokens: 200, output_tokens: 100, cost_cents: 6 });
    const failed = await (await tenantRuns(v1Req(`/ai-runs?task=${task}&status=failed`, { ...as(owner), tenant: alpha.slug }))).json();
    expect(idsOf(failed)).toEqual([ids.a_invalid]);
  });

  it('gives one run of this workspace, and 404 for another workspace\'s', async () => {
    const ok = await tenantRun(v1Req(`/ai-runs/${ids.a_ok}`, { ...as(owner), tenant: alpha.slug }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: ids.a_ok, output: { brief: 'Fine' }, error: null });
    expect((await tenantRun(v1Req(`/ai-runs/${ids.b_error}`, { ...as(owner), tenant: alpha.slug }))).status).toBe(404);
  });

  it('gives 400 for a bad status or mode', async () => {
    for (const qs of ['status=worked', 'mode=magic']) {
      expect((await tenantRuns(v1Req(`/ai-runs?${qs}`, { ...as(owner), tenant: alpha.slug }))).status).toBe(400);
    }
  });

  it('refuses a leader (no settings:manage), an API key and anonymous callers', async () => {
    expect((await tenantRuns(v1Req('/ai-runs', { ...as(leader), tenant: alpha.slug }))).status).toBe(403);
    expect((await tenantRuns(v1Req('/ai-runs', { headers: { authorization: `Bearer ${keySecret}` } }))).status).toBe(403);
    expect((await tenantRuns(v1Req('/ai-runs', { tenant: alpha.slug }))).status).toBe(401);
    expect((await tenantRun(v1Req(`/ai-runs/${ids.a_ok}`, { ...as(leader), tenant: alpha.slug }))).status).toBe(403);
  });
});
