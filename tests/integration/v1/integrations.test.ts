import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { GET as list } from '@/app/v1/integrations/route';
import { POST as action } from '@/app/v1/integrations/[key]/route';
import { PUT as putCredential } from '@/app/v1/integrations/[key]/credential/route';
import { PUT as putMode } from '@/app/v1/integrations/[key]/mode/route';
import { PUT as putDisabled } from '@/app/v1/integrations/[key]/disabled/route';
import { GET as calls } from '@/app/v1/integrations/[key]/calls/route';
import { webhookSecret } from '@/modules/integrations';
import { registerDemoAdapter } from '@/modules/integrations/adapters/demo/mock';
import { callLog, connection, credential } from '@/modules/integrations/db/schema';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { auditLog, outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { cfg } from '../integrations/cfg';
import { newKey } from '../integrations/helpers';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from './session-helpers';

let owner: Person;
let leader: Person;
let t: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};

beforeAll(async () => {
  cfg.masterKey = newKey();
  cfg.forceMock = false;
  registerDemoAdapter();
  const admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  leader = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
  await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
  for (const p of [owner, leader]) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
  v1Req(path, { ...opts, cookies: cookies[p.id], tenant: t.slug });

const save = (key: string, value: string, kind = 'api_key', headers: Record<string, string> = {}) =>
  putCredential(as(owner, `/integrations/${key}/credential`, { method: 'PUT', body: { kind, value }, headers }));

const logCall = (provider: string, outcome: string, durationMs: number, at = new Date()) =>
  adminDb.insert(callLog).values({
    id: newId('call'),
    tenantId: t.tenantId,
    provider,
    operation: `${provider}.test`,
    outcome,
    durationMs,
    statusCode: outcome === 'ok' ? 200 : 500,
    errorMessage: outcome === 'ok' ? null : 'It broke.',
    at,
  });

describe('GET /v1/integrations (integrations:manage)', () => {
  it('lists every workspace service with mode, status, usage and the credential label and last 4', async () => {
    await logCall('apollo', 'ok', 100);
    await logCall('apollo', 'error', 300);
    await logCall('apollo', 'ok', 999, new Date(Date.now() - 3 * 86_400_000));
    expect((await save('hubspot', 'pat-xyz-secret-4f2a', 'private_app_token')).status).toBe(200);

    const res = await list(as(owner, '/integrations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = body.data.map((r: { key: string }) => r.key);
    expect(keys).toContain('hubspot');
    expect(keys).not.toContain('microsoft'); // set up for all of Scout, not per workspace
    expect(keys).not.toContain('demo');

    const apollo = body.data.find((r: { key: string }) => r.key === 'apollo');
    expect(apollo).toMatchObject({
      name: 'Apollo',
      group: 'Data and enrichment',
      used_for: 'Finds people and companies to contact',
      mode: 'mock',
      status: 'not_set_up',
      calls_today: 2,
      calls_today_cap: null,
      errors_today: 1,
      avg_ms: 200,
      credentials: [],
    });
    expect(Date.parse(apollo.last_call_at)).toBeGreaterThan(Date.now() - 60_000);

    const hubspot = body.data.find((r: { key: string }) => r.key === 'hubspot');
    expect(hubspot).toMatchObject({ group: 'CRM', calls_today: 0, avg_ms: null, last_call_at: null });
    expect(hubspot.credentials).toEqual([
      { kind: 'private_app_token', label: 'Private app token', last4: '4f2a', saved_at: expect.any(String) },
    ]);
    expect(JSON.stringify(body)).not.toContain('pat-xyz-secret');
  });

  it('refuses people without integrations:manage', async () => {
    const res = await list(as(leader, '/integrations'));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});

describe('PUT /v1/integrations/{key}/credential', () => {
  it('stores the credential sealed, returns only the last 4, audits it and is never idempotency-stored', async () => {
    const secret = 'demo-secret-value-9a7b';
    const res = await save('demo', secret, 'api_key', { 'idempotency-key': 'cred-1' });
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row).toMatchObject({ key: 'demo', credentials: [{ kind: 'api_key', label: 'Key', last4: '9a7b' }] });
    expect(JSON.stringify(row)).not.toContain(secret);

    const stored = await adminDb.execute(sql`select 1 from platform.idempotency_key where response_body::text like ${`%${secret}%`}`);
    expect(stored.length).toBe(0);
    const [entry] = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, t.tenantId), eq(auditLog.action, 'integrations.credential.saved')))
      .orderBy(sql`${auditLog.at} desc`)
      .limit(1);
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it('400s an empty value, an unknown kind and an unknown field; 404s an unknown service', async () => {
    const empty = await save('demo', '   ');
    expect(empty.status).toBe(400);
    expect((await empty.json()).title).toBe('Paste the key or token to save it.');
    expect((await save('demo', 'abc-def-1234', 'password')).status).toBe(400);
    const extra = await putCredential(as(owner, '/integrations/demo/credential', { method: 'PUT', body: { kind: 'api_key', value: 'x', note: 1 } }));
    expect(extra.status).toBe(400);
    expect((await save('nope', 'abc-def-1234')).status).toBe(404);
  });

  it('refuses a leader and an API key, even one holding integrations:manage', async () => {
    expect((await putCredential(as(leader, '/integrations/demo/credential', { method: 'PUT', body: { kind: 'api_key', value: 'abc-def-1234' } }))).status).toBe(403);
    const k = await inTenant(t.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'int key', environment: 'live', scopes: ['integrations:manage'] }, SYSTEM_GRANTOR),
    );
    const res = await putCredential(
      new Request('http://x/v1/integrations/demo/credential', {
        method: 'PUT',
        headers: { authorization: `Bearer ${k.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'api_key', value: 'abc-def-1234' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/integrations/{key}:test and PUT /v1/integrations/{key}/mode', () => {
  it('tests with the round trip time, then live is allowed; a failing test lists missing permissions', async () => {
    // Live needs a saved credential (and a passing test).
    await adminDb.delete(credential).where(eq(credential.tenantId, t.tenantId));
    await adminDb.update(connection).set({ credentialId: null, lastTestResult: null, lastTestedAt: null }).where(eq(connection.tenantId, t.tenantId));
    const early = await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'live' } }));
    expect(early.status).toBe(409);
    expect((await early.json()).title).toBe('Test the connection before switching it to live.');

    await save('demo', 'bad-token-0000-1111');
    const failed = await action(as(owner, '/integrations/demo:test', { method: 'POST' }));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ok: false, message: 'The token was refused.', missing_permissions: ['demo.read'] });

    await save('demo', 'good-token-0000-2222');
    const passed = await action(as(owner, '/integrations/demo:test', { method: 'POST' }));
    const result = await passed.json();
    expect(result).toMatchObject({ ok: true, message: 'Connected to the demo service.' });
    expect(result.duration_ms).toEqual(expect.any(Number));

    const live = await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'live' } }));
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ key: 'demo', mode: 'live', status: 'connected' });

    const back = await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'mock' } }));
    expect((await back.json()).mode).toBe('mock');
  });

  it('400s a bad mode, 404s an unknown action and refuses a leader', async () => {
    expect((await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'sandbox' } }))).status).toBe(400);
    expect((await action(as(owner, '/integrations/demo:explode', { method: 'POST' }))).status).toBe(404);
    expect((await action(as(leader, '/integrations/demo:test', { method: 'POST' }))).status).toBe(403);
    expect((await putMode(as(leader, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'mock' } }))).status).toBe(403);
  });
});

describe('PUT /v1/integrations/{key}/disabled', () => {
  it('turns a service off and on', async () => {
    const off = await putDisabled(as(owner, '/integrations/apollo/disabled', { method: 'PUT', body: { disabled: true } }));
    expect(off.status).toBe(200);
    expect((await off.json()).status).toBe('disabled');
    const on = await putDisabled(as(owner, '/integrations/apollo/disabled', { method: 'PUT', body: { disabled: false } }));
    expect((await on.json()).status).toBe('not_set_up');
    expect((await putDisabled(as(owner, '/integrations/apollo/disabled', { method: 'PUT', body: { disabled: 'yes' } }))).status).toBe(400);
    expect((await putDisabled(as(leader, '/integrations/apollo/disabled', { method: 'PUT', body: { disabled: true } }))).status).toBe(403);
  });
});

describe('POST /v1/integrations/{key}:disconnect', () => {
  it('clears the credential, returns to sample data, audits and publishes connection.changed', async () => {
    await save('demo', 'good-token-0000-3333');
    await action(as(owner, '/integrations/demo:test', { method: 'POST' }));
    expect((await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'live' } }))).status).toBe(200);

    const res = await action(as(owner, '/integrations/demo:disconnect', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: 'demo', mode: 'mock', status: 'not_set_up', credentials: [] });

    const [conn] = await adminDb
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, t.tenantId), eq(connection.provider, 'demo')));
    expect(conn).toMatchObject({ credentialId: null, mode: 'mock', lastTestResult: null });
    const live = await adminDb
      .select()
      .from(credential)
      .where(and(eq(credential.tenantId, t.tenantId), eq(credential.connectionId, conn!.id), sql`${credential.replacedAt} is null`));
    expect(live).toHaveLength(0);

    const audits = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, t.tenantId), eq(auditLog.action, 'integrations.connection.disconnected')));
    expect(audits).toHaveLength(1);
    const changed = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId))).filter(
      (r) => (r.payload as { type: string; data?: { mode?: string } }).type === 'integrations.connection.changed',
    );
    expect(changed.length).toBeGreaterThan(0);

    // Live now needs a new credential and test.
    expect((await putMode(as(owner, '/integrations/demo/mode', { method: 'PUT', body: { mode: 'live' } }))).status).toBe(409);
  });

  it('shows HubSpot token and webhook secret as two credentials and clears both', async () => {
    await save('hubspot', 'pat-xyz-secret-4f2b', 'private_app_token');
    const both = await (await save('hubspot', 'webhook-client-secret-77aa', 'client_secret')).json();
    expect(both.credentials.map((c: { label: string; last4: string }) => `${c.label} ${c.last4}`)).toEqual([
      'Private app token 4f2b',
      'Client secret 77aa',
    ]);
    const res = await action(as(owner, '/integrations/hubspot:disconnect', { method: 'POST' }));
    expect((await res.json()).credentials).toEqual([]);
    expect(await inTenant(t.tenantId, owner.actor, (ctx) => webhookSecret(ctx, 'hubspot'))).toBeNull();
  });

  it('refuses a leader and 404s an unknown service', async () => {
    expect((await action(as(leader, '/integrations/demo:disconnect', { method: 'POST' }))).status).toBe(403);
    expect((await action(as(owner, '/integrations/nope:disconnect', { method: 'POST' }))).status).toBe(404);
  });
});

describe('GET /v1/integrations/{key}/calls', () => {
  it('lists the last 50 calls newest first, or only the failed ones', async () => {
    for (let i = 0; i < 52; i++) await logCall('vibe', i % 4 === 0 ? 'rate_limited' : 'ok', i, new Date(Date.now() - i * 1000));
    const all = await calls(as(owner, '/integrations/vibe/calls'));
    expect(all.status).toBe(200);
    const rows = (await all.json()).data;
    expect(rows).toHaveLength(50);
    expect(rows[0]).toMatchObject({ operation: 'vibe.test', outcome: 'rate_limited', duration_ms: 0, status_code: 500, error_message: 'It broke.' });
    expect(rows[0].at).toEqual(expect.any(String));

    const errors = (await (await calls(as(owner, '/integrations/vibe/calls?errors_only=true'))).json()).data;
    expect(errors).toHaveLength(13);
    expect(errors.every((r: { outcome: string }) => r.outcome !== 'ok')).toBe(true);
  });

  it('400s a bad errors_only, 404s an unknown service and refuses a leader', async () => {
    expect((await calls(as(owner, '/integrations/vibe/calls?errors_only=maybe'))).status).toBe(400);
    expect((await calls(as(owner, '/integrations/nope/calls'))).status).toBe(404);
    expect((await calls(as(leader, '/integrations/vibe/calls'))).status).toBe(403);
  });
});
