import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { GET as getHandoffs } from '@/http/routes/v1/accounts/[id]/handoffs/route';
import { GET as listBatches } from '@/http/routes/v1/handoff-batches/route';
import { GET as getBatch } from '@/http/routes/v1/handoff-batches/[id]/route';
import { POST as messageAction } from '@/http/routes/v1/handoff-messages/[id]/route';
import { GET as crmGet, POST as crmPost } from '@/http/routes/v1/crm/[resource]/route';
import { GET as getSettings, PUT as putSettings } from '@/http/routes/v1/settings/crm/route';
import { seedMockCrm } from '@/modules/crm';
import { handoff } from '@/modules/crm/db/schema';
import { membership } from '@/modules/tenancy/db/schema';
import { SYSTEM_GRANTOR, addMember, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount } from '../routing/helpers';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { personAndAgent } from './intake-helpers';

type Who = 'owner' | 'leader' | 'seller' | 'limited';
let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;
let cookies: Record<Who, string>;
let ids: Record<Who, string>;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(tenantId, owner.actor, fn);
const tenant = () => ({ tenantId, actor: owner.actor, run }) as never;

async function signIn(userId: string): Promise<string> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) }),
    { enabled: true },
  );
  return res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
}

const as = (who: Who, handler: (r: Request) => Promise<Response>, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request(`http://localhost:4240/v1/${path}`, {
      method,
      headers: { cookie: cookies[who], 'x-scout-tenant': slug, origin: 'http://localhost:4240', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function person(role: 'leader' | 'seller'): Promise<{ id: string; cookie: string }> {
  const u = await seedUser({ signedIn: true });
  await run((ctx) => addMember(ctx, { email: u.email, role, ...(role === 'seller' ? { crmOwnerIds: { hubspot: `mock-${u.id}` } } : {}) }));
  return { id: u.id, cookie: await signIn(u.id) };
}

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'Crm Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  await runOutbox(tenantId);
  await run((ctx) => seedMockCrm(ctx));
  ash = await personAndAgent(tenant(), 'Ash');
  bo = await personAndAgent(tenant(), 'Bo');
  const [leader, seller, limited] = [await person('leader'), await person('seller'), await person('leader')];
  cookies = { owner: await signIn(owner.id), leader: leader.cookie, seller: seller.cookie, limited: limited.cookie };
  await adminDb.update(membership).set({ dataLimit: { kind: 'sources', ids: [bo.agentId] } }).where(and(eq(membership.tenantId, tenantId), eq(membership.userId, limited.id)));
  ids = { owner: owner.id, leader: leader.id, seller: seller.id, limited: limited.id };
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const keyIn = async (scopes: Permission[]) => (await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes, dataLimit: { kind: 'all' } }, SYSTEM_GRANTOR))).secret;
const viaKey = (key: string, handler: (r: Request) => Promise<Response>, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request(`http://x/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** An account assigned to the seller, with its queued handoff delivered. */
async function assigned(name = 'Push Co'): Promise<string> {
  const id = await arrivedAccount(tenant(), { name, sourceChain: { agentSourceId: ash.agentId } });
  const res = await as('leader', accountAction, `accounts/${id}:assign`, 'POST', { seller_user_id: ids.seller });
  if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
  await runOutbox(tenantId);
  return id;
}

describe('push and follow-through', () => {
  it('push is 403 without crm:push and 404 for an account outside the data limit', async () => {
    const id = await assigned();
    expect((await as('seller', accountAction, `accounts/${id}:push`, 'POST')).status).toBe(403);
    expect((await viaKey(await keyIn(['accounts:read']), accountAction, `accounts/${id}:push`, 'POST')).status).toBe(403);
    expect((await as('limited', accountAction, `accounts/${id}:push`, 'POST')).status).toBe(404);
    expect((await as('limited', accountAction, `accounts/${id}:check-follow-through`, 'POST')).status).toBe(404);
    expect((await as('seller', accountAction, `accounts/${id}:check-follow-through`, 'POST')).status).toBe(403);
  });

  it('push is 202 with a handoff id, idempotent with the same Idempotency-Key, and open to a key with the scope', async () => {
    const id = await assigned('Idem Co');
    const first = await as('leader', accountAction, `accounts/${id}:push`, 'POST', { keep_current_owner: true }, { 'idempotency-key': 'push-1' });
    expect(first.status).toBe(202);
    const a = (await first.json()) as { handoff_id: string };
    expect(a.handoff_id).toMatch(/^hof_/);
    const again = await as('leader', accountAction, `accounts/${id}:push`, 'POST', { keep_current_owner: true }, { 'idempotency-key': 'push-1' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toEqual(a);
    expect(await adminDb.select().from(handoff).where(eq(handoff.accountId, id))).toHaveLength(2); // the assignment's own, plus one re-push
    const viaApi = await viaKey(await keyIn(['crm:push']), accountAction, `accounts/${id}:push`, 'POST');
    expect(viaApi.status).toBe(202);
    expect((await as('leader', accountAction, `accounts/${id}:push`, 'POST', { nope: 1 })).status).toBe(400);
  });

  it('an account that was never assigned gets 409 Assign it before pushing.', async () => {
    const id = await arrivedAccount(tenant(), { name: 'Unassigned Co', sourceChain: { agentSourceId: ash.agentId } });
    const res = await as('leader', accountAction, `accounts/${id}:push`, 'POST');
    expect(res.status).toBe(409);
    expect((await res.json()).title).toBe('Assign it before pushing.');
  });

  it('check-follow-through is 202; handoffs need accounts:read, are open to a key, and 404 outside the data limit', async () => {
    const id = await assigned('Follow Co');
    expect((await as('leader', accountAction, `accounts/${id}:check-follow-through`, 'POST')).status).toBe(202);
    expect((await as('leader', getHandoffs, `accounts/${id}/handoffs`)).status).toBe(200);
    expect((await viaKey(await keyIn(['accounts:read']), getHandoffs, `accounts/${id}/handoffs`)).status).toBe(200);
    expect((await viaKey(await keyIn(['arrivals:read']), getHandoffs, `accounts/${id}/handoffs`)).status).toBe(403);
    expect((await as('limited', getHandoffs, `accounts/${id}/handoffs`)).status).toBe(404);
  });
});

describe('handoff batches and messages', () => {
  it('need crm:push, page with next_cursor and read one batch', async () => {
    await assigned('Batch A');
    await assigned('Batch B');
    expect((await as('seller', listBatches, 'handoff-batches')).status).toBe(403);
    expect((await viaKey(await keyIn(['crm:push']), listBatches, 'handoff-batches')).status).toBe(403);
    const p1 = await (await as('leader', listBatches, 'handoff-batches?limit=1')).json();
    expect(p1.data).toHaveLength(1);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await (await as('leader', listBatches, `handoff-batches?limit=1&cursor=${p1.next_cursor}`)).json();
    expect(p2.data).toHaveLength(1);
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
    expect((await as('leader', listBatches, 'handoff-batches?limit=0')).status).toBe(400);
    const one = await as('leader', getBatch, `handoff-batches/${p1.data[0].id}`);
    expect(one.status).toBe(200);
    expect((await one.json()).id).toBe(p1.data[0].id);
    expect((await as('leader', getBatch, 'handoff-batches/hbt_missing')).status).toBe(404);
    expect((await as('seller', getBatch, `handoff-batches/${p1.data[0].id}`)).status).toBe(403);
  });

  it(':copied needs crm:push; an unknown message is 404', async () => {
    expect((await as('seller', messageAction, 'handoff-messages/hmg_x:copied', 'POST')).status).toBe(403);
    expect((await as('leader', messageAction, 'handoff-messages/hmg_x:copied', 'POST')).status).toBe(404);
  });
});

describe('owners, fields, settings and simulate', () => {
  it('owners and owner matches need members:manage; sync reads the roster', async () => {
    for (const [h, p, m] of [[crmGet, 'crm/owners', 'GET'], [crmGet, 'crm/owner-matches', 'GET'], [crmPost, 'crm/owners:sync', 'POST'], [crmPost, 'crm/owner-matches:confirm', 'POST']] as const) {
      expect((await as('leader', h, p, m, m === 'POST' ? {} : undefined)).status).toBe(403);
    }
    const sync = await as('owner', crmPost, 'crm/owners:sync', 'POST');
    expect(sync.status).toBe(200);
    expect((await sync.json()).count).toBeGreaterThan(0);
    const owners = await (await as('owner', crmGet, 'crm/owners')).json();
    expect(owners.data[0]).toHaveProperty('external_owner_id');
    expect((await as('owner', crmGet, 'crm/owner-matches')).status).toBe(200);
    expect((await as('owner', crmPost, 'crm/owner-matches:confirm', 'POST', { user_id: ids.leader, external_owner_id: 'nobody' })).status).toBe(409);
    expect((await as('owner', crmPost, 'crm/owner-matches:confirm', 'POST', { user_id: ids.leader })).status).toBe(400);
    expect((await as('owner', crmGet, 'crm/nothing')).status).toBe(404);
    expect((await as('owner', crmGet, 'crm/owners:sync')).status).toBe(404);
  });

  it('fields:set-up and qualified-leads:simulate need integrations:manage', async () => {
    expect((await as('leader', crmPost, 'crm/fields:set-up', 'POST')).status).toBe(403);
    expect((await as('leader', crmPost, 'crm/qualified-leads:simulate', 'POST')).status).toBe(403);
    expect((await viaKey(await keyIn(['integrations:manage']), crmPost, 'crm/fields:set-up', 'POST')).status).toBe(403);
    const res = await as('owner', crmPost, 'crm/fields:set-up', 'POST');
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).created)).toBe(true);
    const sim = await as('owner', crmPost, 'crm/qualified-leads:simulate', 'POST');
    expect(sim.status).toBe(200);
    expect((await sim.json()).arrival_id).toEqual(expect.any(String));
  });

  it('settings need settings:manage and validation errors carry paths', async () => {
    expect((await as('leader', getSettings, 'settings/crm')).status).toBe(403);
    expect((await as('leader', putSettings, 'settings/crm', 'PUT', {})).status).toBe(403);
    const got = await (await as('owner', getSettings, 'settings/crm')).json();
    expect(got).toMatchObject({ system: 'hubspot', take_over_stale_ownership: true, push_new_people: true, follow_up_days: [3, 7, 14] });
    const bad = await as('owner', putSettings, 'settings/crm', 'PUT', { follow_up_days: [7, 3], push_new_people: 'yes' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors.map((e: { path: string }) => e.path).sort()).toEqual(['follow_up_days', 'push_new_people']);
    const ok = await as('owner', putSettings, 'settings/crm', 'PUT', { follow_up_days: [2, 5], qualified_lead_rule: { property: 'lifecyclestage', value: 'salesqualifiedlead' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ follow_up_days: [2, 5], qualified_lead_rule: { property: 'lifecyclestage', value: 'salesqualifiedlead' } });
  });
});
