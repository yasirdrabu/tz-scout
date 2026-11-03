import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { POST as createRoute } from '@/http/routes/v1/accounts/[id]/enrichment-requests/route';
import { GET as estimateRoute } from '@/http/routes/v1/accounts/[id]/enrichment-estimate/route';
import { GET as listRoute } from '@/http/routes/v1/enrichment-requests/route';
import { POST as actionRoute } from '@/http/routes/v1/enrichment-requests/[id]/route';
import { SYSTEM_GRANTOR, addMember, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { request } from '@/modules/enrichment/db/schema';
import { newId } from '@/platform/ids';
import { adminDb, closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { personAndAgent } from '../intake/helpers';
import { accountFrom } from '../enrichment/helpers';

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;
let cookies: Record<'owner' | 'seller' | 'other' | 'restricted', string>;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(tenantId, owner.actor, fn);
const tenant = () => ({ tenantId, actor: owner.actor, run }) as never;

async function signIn(userId: string): Promise<string> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  return res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
}

const send = (headers: Record<string, string>, handler: (r: Request) => Promise<Response>, path: string, method: string, body?: unknown) =>
  handler(
    new Request(`http://localhost:4240/api/v1/${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const as = (who: keyof typeof cookies, handler: (r: Request) => Promise<Response>, path: string, method: string, body?: unknown) =>
  send({ cookie: cookies[who], 'x-scout-tenant': slug, origin: 'http://localhost:4240' }, handler, path, method, body);
const withKey = (secret: string, handler: (r: Request) => Promise<Response>, path: string, method: string, body?: unknown) =>
  send({ authorization: `Bearer ${secret}` }, handler, path, method, body);

const keyFor = async (sourceId: string, scopes: Permission[]) =>
  (await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes, sourceId }, SYSTEM_GRANTOR))).secret;

async function member(role: 'seller', dataLimit: { kind: 'all' } | null = { kind: 'all' }) {
  const u = await seedUser({ signedIn: true });
  await run((ctx) => addMember(ctx, { email: u.email, role, ...(dataLimit ? { dataLimit } : {}) }));
  return signIn(u.id);
}

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'Enrich Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  await runOutbox(tenantId);
  cookies = { owner: await signIn(owner.id), seller: await member('seller'), other: await member('seller'), restricted: await member('seller', null) };
  ash = await personAndAgent(tenant(), 'Ash');
  bo = await personAndAgent(tenant(), 'Bo');
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const firmo = { kind: 'company_firmographics', provider_key: 'apollo' };
const newAccount = (sourceId = ash.agentId) => accountFrom(tenant(), sourceId);

describe('create', () => {
  it('an owner gets 201 approved; a seller gets 201 flagged and needs a reason', async () => {
    const { accountId } = await newAccount();
    const res = await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', firmo);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      account_id: accountId,
      kind: 'company_firmographics',
      kind_label: 'Company facts',
      provider_key: 'apollo',
      provider_name: 'Apollo',
      status: 'approved',
      status_text: 'Starting',
      estimate: { credits: 1, cost_cents: 10, text: 'Up to 1 credit, about $0.10 · Sample' },
      sample: true,
      joined: false,
    });

    const other = await newAccount();
    const bare = await as('seller', createRoute, `accounts/${other.accountId}/enrichment-requests`, 'POST', firmo);
    expect(bare.status).toBe(400);
    const problem = await bare.json();
    expect(problem.title).toBe('Say why this is worth the spend.');
    expect(problem.errors).toEqual([{ path: 'reason', message: 'Say why this is worth the spend.' }]);

    const flagged = await as('seller', createRoute, `accounts/${other.accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'Need size' });
    expect(flagged.status).toBe(201);
    expect(await flagged.json()).toMatchObject({ status: 'flagged', status_text: 'Waiting for approval', reason: 'Need size', joined: false });
  });

  it('a second request for the same kind joins the open one with 200', async () => {
    const { accountId } = await newAccount();
    const first = await (await as('seller', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'Need size' })).json();
    const res = await as('other', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'Me too' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: first.id, status: 'flagged', joined: true });
  });

  it('refuses an unknown field, a bad kind and an unseen account', async () => {
    const { accountId } = await newAccount();
    expect((await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, nope: 1 })).status).toBe(400);
    expect((await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { kind: 'nope', provider_key: 'apollo' })).status).toBe(400);
    expect((await as('owner', createRoute, 'accounts/acc_missing/enrichment-requests', 'POST', firmo)).status).toBe(404);
    expect((await as('owner', createRoute, `accounts/${accountId}:x/enrichment-requests`, 'POST', firmo)).status).toBe(404);
  });
});

describe('estimate', () => {
  it('returns the dialog line, parsing comma lists', async () => {
    const { accountId } = await newAccount();
    const res = await as('seller', estimateRoute, `accounts/${accountId}/enrichment-estimate?kind=people_for_roles&provider_key=apollo&roles=technical_buyer,champion`, 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credits: 6, cost_cents: 60, currency: 'USD', sample: true, text: 'Up to 6 credits, about $0.60 · Sample' });
  });

  it('reveals emails for a person list', async () => {
    const { accountId, personIds } = await newAccount();
    const res = await as('seller', estimateRoute, `accounts/${accountId}/enrichment-estimate?kind=email_reveal&provider_key=apollo&person_ids=${personIds.join(',')}`, 'GET');
    expect(await res.json()).toMatchObject({ credits: personIds.length });
  });

  it('needs kind and provider_key', async () => {
    const { accountId } = await newAccount();
    const noKind = await as('seller', estimateRoute, `accounts/${accountId}/enrichment-estimate?provider_key=apollo`, 'GET');
    expect(noKind.status).toBe(400);
    expect((await noKind.json()).errors.map((e: { path: string }) => e.path)).toEqual(['kind']);
    const noProvider = await as('seller', estimateRoute, `accounts/${accountId}/enrichment-estimate?kind=company_firmographics`, 'GET');
    expect(noProvider.status).toBe(400);
    expect((await noProvider.json()).errors.map((e: { path: string }) => e.path)).toEqual(['provider_key']);
  });
});

describe('approve, decline and cancel', () => {
  const flag = async () => {
    const { accountId } = await newAccount();
    const r = await (await as('seller', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'Need size' })).json();
    return r.id as string;
  };

  it('an owner approves with 202; a second approve is a 409 with the status word', async () => {
    const id = await flag();
    const res = await as('owner', actionRoute, `enrichment-requests/${id}:approve`, 'POST');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id, status: 'approved', decided_by_label: expect.any(String) });
    const again = await as('owner', actionRoute, `enrichment-requests/${id}:approve`, 'POST');
    expect(again.status).toBe(409);
    expect((await again.json()).title).toBe('This request is already approved.');
  });

  it('a key cannot approve or decline (ENR-E1-S2-AC2); a seller gets 403; an unknown id is 404', async () => {
    const id = await flag();
    const key = await keyFor(ash.agentId, ['enrichment:request', 'enrichment:approve', 'accounts:read']);
    for (const action of ['approve', 'decline']) {
      const res = await withKey(key, actionRoute, `enrichment-requests/${id}:${action}`, 'POST', { reason: 'no' });
      expect(res.status).toBe(403);
      expect((await res.json()).detail).toBe('Only a person can approve spend.');
    }
    expect((await as('seller', actionRoute, `enrichment-requests/${id}:approve`, 'POST')).status).toBe(403);
    expect((await as('seller', actionRoute, `enrichment-requests/${id}:decline`, 'POST', { reason: 'no' })).status).toBe(403);
    expect((await as('owner', actionRoute, 'enrichment-requests/enr_missing:approve', 'POST')).status).toBe(404);
    expect((await as('owner', actionRoute, `enrichment-requests/${id}:nope`, 'POST')).status).toBe(404);
  });

  it('decline needs a reason, then records it; a declined request cannot be cancelled', async () => {
    const id = await flag();
    const bare = await as('owner', actionRoute, `enrichment-requests/${id}:decline`, 'POST', {});
    expect(bare.status).toBe(400);
    expect((await bare.json()).title).toBe("Say why you're declining.");
    const res = await as('owner', actionRoute, `enrichment-requests/${id}:decline`, 'POST', { reason: 'Too costly' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'declined', decline_reason: 'Too costly', status_text: 'Declined: Too costly' });
    const cancel = await as('owner', actionRoute, `enrichment-requests/${id}:cancel`, 'POST');
    expect(cancel.status).toBe(409);
    expect((await cancel.json()).title).toBe('This request is already declined.');
  });

  it('the requester cancels their own; another seller cannot', async () => {
    const id = await flag();
    expect((await as('other', actionRoute, `enrichment-requests/${id}:cancel`, 'POST')).status).toBe(403);
    const res = await as('seller', actionRoute, `enrichment-requests/${id}:cancel`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: 'cancelled', status_text: 'Cancelled' });
  });
});

describe('list (Review Focus 4)', () => {
  it("an agent's key sees only requests for accounts its source sent; the cursor pages", async () => {
    const mine = await newAccount(bo.agentId);
    const theirs = await newAccount(ash.agentId);
    const key = await keyFor(bo.agentId, ['enrichment:request', 'accounts:read']);
    const a = await (await as('owner', createRoute, `accounts/${mine.accountId}/enrichment-requests`, 'POST', firmo)).json();
    const b = await (await as('owner', createRoute, `accounts/${theirs.accountId}/enrichment-requests`, 'POST', firmo)).json();

    const seen = await withKey(key, listRoute, 'enrichment-requests', 'GET');
    expect(seen.status).toBe(200);
    const ids = (await seen.json()).data.map((r: { id: string }) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);

  });

  it('pages with next_cursor, filters by status and account, and refuses bad input', async () => {
    const { accountId } = await newAccount();
    const first = await (await as('seller', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'a' })).json();
    await as('owner', actionRoute, `enrichment-requests/${first.id}:decline`, 'POST', { reason: 'no' });
    const second = await (await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', firmo)).json();

    const page1 = await (await as('owner', listRoute, `enrichment-requests?account_id=${accountId}&limit=1`, 'GET')).json();
    expect(page1.data.map((r: { id: string }) => r.id)).toEqual([second.id]);
    expect(page1.next_cursor).toBe(second.id);
    const page2 = await (await as('owner', listRoute, `enrichment-requests?account_id=${accountId}&limit=1&cursor=${page1.next_cursor}`, 'GET')).json();
    expect(page2.data.map((r: { id: string }) => r.id)).toEqual([first.id]);
    expect(page2.next_cursor).toBeNull();

    const declined = await (await as('owner', listRoute, `enrichment-requests?account_id=${accountId}&status=declined`, 'GET')).json();
    expect(declined.data.map((r: { id: string }) => r.id)).toEqual([first.id]);

    const badStatus = await as('owner', listRoute, 'enrichment-requests?status=nope', 'GET');
    expect(badStatus.status).toBe(400);
    expect((await badStatus.json()).errors[0].path).toBe('status');
    const badCursor = await as('owner', listRoute, 'enrichment-requests?cursor=enr_missing', 'GET');
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json()).title).toBe('That page link is out of date. Start from the first page.');
  });
});

describe('visibility and shape', () => {
  it('a seller on the default data limit gets 404 for an account they cannot see, and an empty list', async () => {
    const { accountId } = await newAccount();
    const r = await (await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', firmo)).json();
    expect((await as('restricted', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', { ...firmo, reason: 'x' })).status).toBe(404);
    expect((await as('restricted', estimateRoute, `accounts/${accountId}/enrichment-estimate` + '?kind=company_firmographics&provider_key=apollo', 'GET')).status).toBe(404);
    expect((await as('restricted', actionRoute, `enrichment-requests/${r.id}:cancel`, 'POST')).status).toBe(404);
    const list = await (await as('restricted', listRoute, 'enrichment-requests', 'GET')).json();
    expect(list).toEqual({ data: [], next_cursor: null });
  });

  it('a request has exactly the documented fields, plus joined', async () => {
    const { accountId } = await newAccount();
    const r = await (await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', firmo)).json();
    expect(Object.keys(r).sort()).toEqual(
      [
        'id', 'account_id', 'account_name', 'kind', 'kind_label', 'provider_key', 'provider_name', 'status', 'status_text',
        'requested_by_label', 'reason', 'estimate', 'created_at', 'decided_by_label', 'decided_at', 'decline_reason',
        'result', 'error', 'waiting_reason', 'sample', 'joined',
      ].sort(),
    );
    expect(Object.keys(r.estimate).sort()).toEqual(['cost_cents', 'credits', 'text']);
  });

  it('the list page size goes up to 200', async () => {
    const { accountId } = await newAccount();
    const seed = await (await as('owner', createRoute, `accounts/${accountId}/enrichment-requests`, 'POST', firmo)).json();
    const [row] = await adminDb.select().from(request).where(eq(request.id, seed.id));
    const rows = Array.from({ length: 119 }, () => ({ ...row!, id: newId('enr'), status: 'declined', createdAt: new Date() }));
    await adminDb.insert(request).values(rows);
    const page = await (await as('owner', listRoute, `enrichment-requests?account_id=${accountId}&limit=200`, 'GET')).json();
    expect(page.data).toHaveLength(120);
    expect(page.next_cursor).toBeNull();
  });
});
