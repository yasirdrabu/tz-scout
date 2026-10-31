import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DELETE as resourceDelete, GET as resourceGet, POST as resourceAction } from '@/http/routes/v1/[resource]/route';
import { GET as me } from '@/http/routes/v1/me/route';
import { GET as sessions } from '@/http/routes/v1/me/sessions/route';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

let owner: Person;
let t: { tenantId: string; slug: string };

beforeAll(async () => {
  const admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
});
beforeEach(() => setPrincipalCacheTtl(0));

/** Someone who may sign in: a member of the tenant. */
async function member(): Promise<Person> {
  const p = await seedUser({ signedIn: true });
  await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
  return p;
}

describe('GET /api/v1/me profile fields', () => {
  it('gives the role, how they sign in and the access in plain words', async () => {
    const body = await (await me(v1Req('/me', { cookies: await signedIn(owner.id), tenant: t.slug }))).json();
    expect(body).toMatchObject({
      user: { id: owner.id, sign_in_method: 'dev' },
      role: 'owner',
      access_summary: ['You can see every account in this workspace.'],
    });
  });
});

describe('GET /api/v1/me/sessions', () => {
  it("lists the caller's sessions, marks the current one and never returns the token", async () => {
    const p = await member();
    await signedIn(p.id, { 'user-agent': 'Laptop' });
    const phone = await signedIn(p.id, { 'user-agent': 'Phone' });
    const res = await sessions(v1Req('/me/sessions', { cookies: phone }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toHaveLength(2);
    expect(data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    for (const s of data) {
      expect(Object.keys(s).sort()).toEqual(['created_at', 'current', 'id', 'ip', 'last_active_at', 'user_agent']);
    }
    expect(data.map((s: { user_agent: string }) => s.user_agent).sort()).toEqual(['Laptop', 'Phone']);
  });

  it('refuses an API key and someone not signed in', async () => {
    const { secret } = await inTenant(t.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: [] }, SYSTEM_GRANTOR),
    );
    expect((await sessions(v1Req('/me/sessions', { headers: { authorization: `Bearer ${secret}` } }))).status).toBe(403);
    expect((await sessions(v1Req('/me/sessions'))).status).toBe(401);
  });
});

describe('POST /api/v1/me:sign-out-everywhere', () => {
  it('ends every session of the caller, this one included', async () => {
    const p = await member();
    const laptop = await signedIn(p.id);
    const phone = await signedIn(p.id);
    const res = await resourceAction(v1Req('/me:sign-out-everywhere', { cookies: phone, method: 'POST' }));
    expect(res.status).toBe(204);
    expect((await sessions(v1Req('/me/sessions', { cookies: laptop }))).status).toBe(401);
    expect((await sessions(v1Req('/me/sessions', { cookies: phone }))).status).toBe(401);
  });

  it('refuses a cross-site write and answers 404 for other actions', async () => {
    const p = await member();
    const cookies = await signedIn(p.id);
    const cross = await resourceAction(v1Req('/me:sign-out-everywhere', { cookies, method: 'POST', headers: { origin: 'https://evil.example' } }));
    expect(cross.status).toBe(403);
    expect((await resourceAction(v1Req('/me:explode', { cookies, method: 'POST' }))).status).toBe(404);
    expect((await resourceAction(v1Req('/accounts:sign-out-everywhere', { cookies, method: 'POST' }))).status).toBe(404);
    expect((await sessions(v1Req('/me/sessions', { cookies }))).status).toBe(200);
  });
});

describe('/api/v1/{unknown}', () => {
  it('answers other methods with the problem+json 404', async () => {
    for (const handler of [resourceGet, resourceDelete]) {
      const res = await handler(v1Req('/nope', { method: handler === resourceGet ? 'GET' : 'DELETE' }));
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(await res.json()).toMatchObject({ type: 'https://scout.taazaa.ai/problems/not-found', status: 404 });
    }
  });
});
