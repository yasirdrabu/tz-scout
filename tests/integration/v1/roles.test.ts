import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as me } from '@/http/routes/v1/me/route';
import { GET as roles } from '@/http/routes/v1/roles/route';
import { PUT as putRole } from '@/http/routes/v1/roles/[role]/route';
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_GRANTOR, addMember, changeMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from './session-helpers';

let owner: Person;
let leader: Person;
let seller: Person;
let t: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};

beforeAll(async () => {
  const admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  leader = await seedUser({ signedIn: true });
  seller = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
  await inTenant(t.tenantId, owner.actor, async (ctx) => {
    await addMember(ctx, { email: leader.email, role: 'leader' });
    await addMember(ctx, { email: seller.email, role: 'seller' });
  });
  for (const p of [owner, leader, seller]) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
  v1Req(path, { ...opts, cookies: cookies[p.id], tenant: t.slug });
const put = (p: Person, role: string, permissions: unknown) =>
  putRole(as(p, `/roles/${role}`, { method: 'PUT', body: { permissions } }));

describe('GET /api/v1/roles', () => {
  it('lists each role with its current and default permissions, Viewer included, and the permissions with labels and groups', async () => {
    const res = await roles(as(leader, '/roles'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles.map((r: { role: string }) => r.role)).toEqual(['owner', 'leader', 'seller', 'operator', 'viewer']);
    expect(body.roles.find((r: { role: string }) => r.role === 'seller')).toEqual({
      role: 'seller',
      permissions: ROLE_PERMISSIONS.seller,
      default_permissions: ROLE_PERMISSIONS.seller,
      customised: false,
      locked: false,
    });
    expect(body.roles[0]).toMatchObject({ role: 'owner', locked: true, permissions: [...PERMISSIONS] });
    expect(body.roles[4]).toMatchObject({ role: 'viewer', permissions: ROLE_PERMISSIONS.viewer });
    expect(body.permissions).toContainEqual({ key: 'members:read', label: 'See members', group: 'Workspace' });
    expect((await roles(as(seller, '/roles'))).status).toBe(403);
  });
});

describe('PUT /api/v1/roles/{role}', () => {
  it('saves a role and returns its view; the list then shows it customised', async () => {
    const res = await put(owner, 'seller', ['status:read', 'accounts:read']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: 'seller',
      permissions: ['accounts:read', 'status:read'],
      default_permissions: ROLE_PERMISSIONS.seller,
      customised: true,
      locked: false,
    });
    const listed = (await (await roles(as(owner, '/roles'))).json()).roles.find((r: { role: string }) => r.role === 'seller');
    expect(listed).toMatchObject({ customised: true, permissions: ['accounts:read', 'status:read'] });
    // Restore defaults is a PUT of default_permissions.
    const back = await put(owner, 'seller', ROLE_PERMISSIONS.seller);
    expect(await back.json()).toMatchObject({ customised: false });
  });

  it('allows an empty list for any role but Owner', async () => {
    const res = await put(owner, 'viewer', []);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'viewer', permissions: [], customised: true });
    await put(owner, 'viewer', ROLE_PERMISSIONS.viewer);
  });

  it('refuses Owner (409 role-locked), an unknown role (404), an unknown permission (400) and a bad body (400)', async () => {
    const locked = await put(owner, 'owner', ['accounts:read']);
    expect(locked.status).toBe(409);
    expect((await locked.json()).type).toMatch(/\/role-locked$/);
    const missing = await put(owner, 'boss', ['accounts:read']);
    expect(missing.status).toBe(404);
    expect((await missing.json()).type).toMatch(/\/role-not-found$/);
    const bad = await put(owner, 'seller', ['accounts:read', 'nope:nope']);
    expect(bad.status).toBe(400);
    expect((await bad.json()).type).toMatch(/\/invalid-permission$/);
    expect((await put(owner, 'seller', 'accounts:read')).status).toBe(400);
  });

  it('needs members:manage and a person', async () => {
    expect((await put(leader, 'seller', ['accounts:read'])).status).toBe(403);
    expect((await put(seller, 'seller', ['accounts:read'])).status).toBe(403);
    const { secret } = await inTenant(t.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['members:manage'] }, SYSTEM_GRANTOR),
    );
    const res = await putRole(
      new Request('http://localhost:4240/api/v1/roles/seller', {
        method: 'PUT',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: ['accounts:read'] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses adding or removing a permission the editor lacks', async () => {
    // A leader holding members:manage as an extra permission still cannot add keys:manage.
    const manager = await seedUser({ signedIn: true });
    await inTenant(t.tenantId, owner.actor, async (ctx) => {
      const id = await addMember(ctx, { email: manager.email, role: 'leader' });
      await changeMember(ctx, id, { extraPermissions: ['members:manage'] });
    });
    cookies[manager.id] = await signedIn(manager.id);
    const res = await put(manager, 'seller', [...ROLE_PERMISSIONS.seller, 'keys:manage']);
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/permission-not-yours$/);
    expect((await put(manager, 'leader', [...ROLE_PERMISSIONS.leader, 'keys:manage'])).status).toBe(403);
    expect((await put(manager, 'seller', ['accounts:read'])).status).toBe(200);
    await put(owner, 'seller', ROLE_PERMISSIONS.seller);
  });

  it('applies on the very next request, with the principal cache at its real TTL', async () => {
    setPrincipalCacheTtl(60_000);
    const scopes = async () => (await (await me(as(seller, '/me'))).json()).scopes as string[];
    expect(await scopes()).toContain('accounts:read');
    expect((await put(owner, 'seller', ['status:read'])).status).toBe(200);
    expect(await scopes()).toEqual(['status:read']);
    expect((await put(owner, 'seller', ROLE_PERMISSIONS.seller)).status).toBe(200);
    expect(await scopes()).toContain('accounts:read');
  });
});
