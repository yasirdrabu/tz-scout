import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { POST as accountAction } from '@/app/v1/accounts/[id]/route';
import { GET as listAccountAssignments } from '@/app/v1/accounts/[id]/assignments/route';
import { PUT as putInsights } from '@/app/v1/accounts/[id]/insights/route';
import { PATCH as patchReviewStatus } from '@/app/v1/accounts/[id]/review-status/route';
import { GET as getStatus } from '@/app/v1/accounts/[id]/status/route';
import { POST as assignmentAction } from '@/app/v1/assignments/[id]/route';
import { GET as listAssignmentsRoute } from '@/app/v1/assignments/route';
import { POST as postArrival } from '@/app/v1/arrivals/route';
import { POST as bulkRoute } from '@/app/v1/review-queue/bulk/route';
import { GET as countRoute } from '@/app/v1/review-queue/count/route';
import { GET as queueRoute } from '@/app/v1/review-queue/route';
import { GET as getSettings, PUT as putSettings } from '@/app/v1/settings/review/route';
import { assignmentCreated } from '@/modules/routing';
import { membership } from '@/modules/tenancy/db/schema';
import { SYSTEM_GRANTOR, addMember, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog, outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, setSummary } from '../routing/helpers';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { call, freshTenant, keyFor, personAndAgent, SEND } from './intake-helpers';

type Who = 'owner' | 'leader' | 'leader2' | 'seller' | 'seller2' | 'operator';
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

/** A cookie-signed-in request with the same-site headers the web app sends. */
const as = (who: Who, handler: (r: Request) => Promise<Response>, path: string, method = 'GET', body?: unknown) =>
  handler(
    new Request(`http://localhost:4240/v1/${path}`, {
      method,
      headers: { cookie: cookies[who], 'x-scout-tenant': slug, origin: 'http://localhost:4240', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function person(role: 'leader' | 'seller' | 'operator'): Promise<{ id: string; cookie: string }> {
  const u = await seedUser({ signedIn: true });
  await run((ctx) => addMember(ctx, { email: u.email, role }));
  return { id: u.id, cookie: await signIn(u.id) };
}

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'Routing Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  await runOutbox(tenantId);
  const [leader, leader2, seller, seller2, operator] = [await person('leader'), await person('leader'), await person('seller'), await person('seller'), await person('operator')];
  cookies = { owner: await signIn(owner.id), leader: leader.cookie, leader2: leader2.cookie, seller: seller.cookie, seller2: seller2.cookie, operator: operator.cookie };
  // The operator holds review:act (a grantable extra) but not assign:act.
  await adminDb.update(membership).set({ extraPermissions: ['review:act'] }).where(and(eq(membership.tenantId, tenantId), eq(membership.userId, operator.id)));
  ids = { owner: owner.id, leader: leader.id, leader2: leader2.id, seller: seller.id, seller2: seller2.id, operator: operator.id };
  ash = await personAndAgent(tenant(), 'Ash');
  bo = await personAndAgent(tenant(), 'Bo');
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const keyIn = async (scopes: Permission[], extra: Parameters<typeof createApiKey>[1]['dataLimit'] extends infer D ? { sourceId?: string; dataLimit?: D } : never = {}) =>
  (await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes, ...extra }, SYSTEM_GRANTOR))).secret;
const viaKey = (key: string, handler: (r: Request) => Promise<Response>, path: string, method = 'GET', body?: unknown) =>
  handler(
    new Request(`http://x/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const account = (name = 'Route Co', source = ash.agentId) => arrivedAccount(tenant(), { name, sourceChain: { agentSourceId: source } });
const assignTo = async (who: Who, accountId: string, as_: Who = 'leader') => {
  const res = await as(as_, accountAction, `accounts/${accountId}:assign`, 'POST', { seller_user_id: ids[who] });
  if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
  return (await res.json()) as { id: string };
};

describe('review queue', () => {
  it('REV-E1-S1-AC3: a seller gets 403 on the queue, the count and the bulk action', async () => {
    expect((await as('seller', queueRoute, 'review-queue')).status).toBe(403);
    expect((await as('seller', countRoute, 'review-queue/count')).status).toBe(403);
    expect((await as('seller', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: ['acc_x'], action: 'status', to: 'reviewed' })).status).toBe(403);
    expect((await viaKey(await keyIn(['accounts:read']), queueRoute, 'review-queue')).status).toBe(403);
  });

  it('lists by priority with the review fields, pages with next_cursor and counts the same set', async () => {
    const src = await personAndAgent(tenant(), 'Queue');
    const [a, b, c] = [await account('Alpha Co', src.agentId), await account('Beta Co', src.agentId), await account('Gamma Co', src.agentId)];
    for (const [id, priority] of [[a, 10], [b, 90], [c, 50]] as const) await setSummary(tenant(), id, { priority });
    const path = `review-queue?source_id=${src.agentId}`;
    const first = await as('leader', queueRoute, `${path}&limit=2`);
    expect(first.status).toBe(200);
    const p1 = await first.json();
    expect(p1.data.map((r: { account_id: string }) => r.account_id)).toEqual([b, c]);
    expect(p1.data[0]).toMatchObject({ name: 'Beta Co', priority: 90, review_status_key: 'unvetted', review_status_label: 'Unvetted', insights: null, flags: {} });
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await (await as('leader', queueRoute, `${path}&limit=2&cursor=${p1.next_cursor}`)).json();
    expect(p2.data.map((r: { account_id: string }) => r.account_id)).toEqual([a]);
    expect(p2.next_cursor).toBeNull();
    expect(await (await as('leader', countRoute, `review-queue/count?source_id=${src.agentId}`)).json()).toEqual({ count: 3 });
    const filtered = await (await as('leader', queueRoute, `${path}&status=reviewed`)).json();
    expect(filtered.data).toEqual([]);
    expect((await as('leader', queueRoute, `${path}&limit=0`)).status).toBe(400);
    expect((await as('leader', queueRoute, `${path}&cursor=!!`)).status).toBeGreaterThanOrEqual(400);
  });

  it('shows a seller decline with its reason on the queue', async () => {
    const src = await personAndAgent(tenant(), 'Declined');
    const a = await account('Declined Co', src.agentId);
    const { id } = await assignTo('seller', a);
    expect((await as('seller', assignmentAction, `assignments/${id}:decline`, 'POST', { reason_key: 'not_my_territory' })).status).toBe(200);
    await runOutbox(tenantId);
    const rows = (await (await as('leader', queueRoute, `review-queue?source_id=${src.agentId}&flag=declined_by_seller`)).json()).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].flags.declined_by_seller).toMatchObject({ reason_key: 'not_my_territory', reason_label: 'Not my territory' });
  });
});

describe('review status and insights', () => {
  it('changes the status, and answers copy as 400s with snake_case paths', async () => {
    const a = await account();
    const patch = (body: unknown, who: Who = 'leader') => as(who, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', body);
    const bad = await patch({ to: 'bogus' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ title: 'Pick a review status from your list.', errors: [{ path: 'to', message: 'Pick a review status from your list.' }] });
    const noReason = await patch({ to: 'declined' });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).errors).toEqual(expect.arrayContaining([{ path: 'reason_key', message: 'Pick a reason' }]));
    const other = await patch({ to: 'declined', reason_key: 'other' });
    expect((await other.json()).errors).toEqual([{ path: 'note', message: 'Add a note for Other.' }]);
    expect((await patch({ to: 'reviewed', nope: 1 })).status).toBe(400);

    const ok = await patch({ to: 'declined', reason_key: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ review_status_key: 'declined', stage: 'declined' });
    const reopen = await patch({ to: 'needs_review' });
    expect((await reopen.json()).title).toBe("Add a note saying why you're reopening it.");
    expect((await patch({ to: 'needs_review', note: 'New facts came in.' })).status).toBe(200);

    expect((await patch({ to: 'reviewed' }, 'seller')).status).toBe(403);
    expect((await viaKey(await keyIn(['review:act']), patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'reviewed' })).status).toBe(403);
  });

  it('sets insights for a leader only', async () => {
    const a = await account();
    const res = await as('leader', putInsights, `accounts/${a}/insights`, 'PUT', { insights: 'Call the CIO first.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ insights: 'Call the CIO first.', insights_by: ids.leader, insights_at: expect.any(String) });
    const long = await as('leader', putInsights, `accounts/${a}/insights`, 'PUT', { insights: 'x'.repeat(4001) });
    expect(long.status).toBe(400);
    expect((await as('seller', putInsights, `accounts/${a}/insights`, 'PUT', { insights: 'hi' })).status).toBe(403);
    expect((await as('leader', putInsights, 'accounts/acc_missing/insights', 'PUT', { insights: 'hi' })).status).toBe(404);
    expect((await as('leader', putInsights, `accounts/${a}/insights`, 'PUT', {})).status).toBe(400);
  });
});

describe('assign, respond and withdraw', () => {
  it('REV-E2-S1: assign answers 202 and publishes the event; the seller accepts; the wrong seller gets 404', async () => {
    const a = await account();
    const res = await as('leader', accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: ids.seller, notes: 'Call the CIO' });
    expect(res.status).toBe(202);
    const made = await res.json();
    expect(made).toMatchObject({ account_id: a, seller_user_id: ids.seller, assigned_by: ids.leader, status: 'pending', notes: 'Call the CIO', ownership_decision: 'assign' });
    const sent = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).map((r) => r.payload as { type: string; data: { assignmentId?: string } });
    expect(sent.some((e) => e.type === assignmentCreated.type && e.data.assignmentId === made.id)).toBe(true);

    expect((await as('seller2', assignmentAction, `assignments/${made.id}:accept`, 'POST', {})).status).toBe(404);
    expect((await as('leader', assignmentAction, `assignments/${made.id}:accept`, 'POST', {})).status).toBe(404);
    // A seller limited to their own accounts sees the account's name once the summary has caught up.
    await runOutbox(tenantId);
    const ok = await as('seller', assignmentAction, `assignments/${made.id}:accept`, 'POST', {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: made.id, status: 'accepted', accepted_how: 'seller', account_name: 'Route Co' });
    expect((await as('seller', assignmentAction, `assignments/${made.id}:accept`, 'POST', {})).status).toBe(409);
  });

  it('refuses a seller who cannot take it, a bad body, an unknown account and the wrong role', async () => {
    const a = await account();
    const post = (who: Who, body: unknown, id = a) => as(who, accountAction, `accounts/${id}:assign`, 'POST', body);
    const notSeller = await post('leader', { seller_user_id: ids.operator });
    expect(notSeller.status).toBe(400);
    expect((await notSeller.json()).errors).toEqual([{ path: 'seller_user_id', message: 'Pick a seller who can take assignments.' }]);
    expect((await post('leader', { seller_user_id: ids.seller, nope: 1 })).status).toBe(400);
    expect((await post('leader', {})).status).toBe(400);
    expect((await post('leader', { seller_user_id: ids.seller }, 'acc_missing')).status).toBe(404);
    expect((await post('seller', { seller_user_id: ids.seller })).status).toBe(403);
    expect((await viaKey(await keyIn(['assign:act']), accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: ids.seller })).status).toBe(403);
    expect((await as('leader', accountAction, `accounts/${a}:nope`, 'POST', {})).status).toBe(404);
  });

  it('previews an assignment for assign:act only', async () => {
    const a = await account();
    const res = await as('leader', accountAction, `accounts/${a}:assign-preview`, 'POST', { seller_user_id: ids.seller });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ preflight: { result: 'new' }, approves_to: { key: 'reviewed', label: 'Reviewed' }, replaces: null });
    expect((await as('seller', accountAction, `accounts/${a}:assign-preview`, 'POST', { seller_user_id: ids.seller })).status).toBe(403);
    expect((await as('leader', accountAction, `accounts/${a}:assign-preview`, 'POST', {})).status).toBe(400);
  });

  it('the seller declines with a reason, accepted or not; the copy comes back as 400s', async () => {
    const a = await account();
    const { id } = await assignTo('seller', a);
    const decline = (body: unknown, who: Who = 'seller') => as(who, assignmentAction, `assignments/${id}:decline`, 'POST', body);
    const none = await decline({});
    expect(none.status).toBe(400);
    expect((await none.json()).errors).toEqual([{ path: 'reason_key', message: 'Pick a reason' }]);
    const other = await decline({ reason_key: 'other' });
    expect((await other.json()).errors).toEqual([{ path: 'note', message: 'Add a note for Other.' }]);
    expect((await decline({ reason_key: 'not_my_territory' }, 'seller2')).status).toBe(404);
    expect((await decline({ reason_key: 'not_my_territory' }, 'leader')).status).toBe(404);
    await as('seller', assignmentAction, `assignments/${id}:accept`, 'POST', {});
    const ok = await decline({ reason_key: 'other', note: 'Out of region.' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id, status: 'declined', decline_reason_key: 'other' });
  });

  it('withdraw is for the assigner or an owner; it needs assign:act; the seller is refused', async () => {
    const a = await account();
    const { id } = await assignTo('seller', a);
    const withdraw = (who: Who, body: unknown = {}) => as(who, assignmentAction, `assignments/${id}:withdraw`, 'POST', body);
    expect((await withdraw('seller')).status).toBe(403);
    expect((await withdraw('leader2')).status).toBe(403);
    const ok = await withdraw('leader');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id, status: 'withdrawn' });
    expect((await withdraw('leader')).status).toBe(409);

    const b = await account();
    const second = await assignTo('seller', b);
    const re = await as('owner', assignmentAction, `assignments/${second.id}:withdraw`, 'POST', { reassign_to: ids.seller2 });
    expect(re.status).toBe(200);
    expect(await re.json()).toMatchObject({ id: second.id, status: 'replaced', reassigned: { seller_user_id: ids.seller2, status: 'pending' } });
    expect((await as('leader', assignmentAction, 'assignments/asg_missing:withdraw', 'POST', {})).status).toBe(404);
    expect((await as('leader', assignmentAction, `assignments/${second.id}:nope`, 'POST', {})).status).toBe(404);
  });

  it(':seen is for the assigned seller, a person, with assignments:respond', async () => {
    const a = await account();
    await assignTo('seller', a);
    expect((await as('seller2', accountAction, `accounts/${a}:seen`, 'POST', {})).status).toBe(404);
    expect((await as('leader', accountAction, `accounts/${a}:seen`, 'POST', {})).status).toBe(404);
    expect((await viaKey(await keyIn(['assignments:respond']), accountAction, `accounts/${a}:seen`, 'POST', {})).status).toBe(403);
    const ok = await as('seller', accountAction, `accounts/${a}:seen`, 'POST', {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ has_open_assignment: true, owner_user_id: ids.seller });
  });
});

describe('assignment lists', () => {
  it('mine needs assignments:respond; the cross-account list needs assign:act or review:act', async () => {
    const src = await personAndAgent(tenant(), 'Lists');
    const a = await account('List Co', src.agentId);
    const { id } = await assignTo('seller', a);
    await runOutbox(tenantId);
    const mine = await as('seller', listAssignmentsRoute, 'assignments?mine=true&status=pending');
    expect(mine.status).toBe(200);
    const body = await mine.json();
    expect(body.data.map((r: { id: string }) => r.id)).toContain(id);
    expect(body.data.find((r: { id: string }) => r.id === id)).toMatchObject({ account_id: a, account_name: 'List Co', seller_user_id: ids.seller, status: 'pending' });
    expect(body).toHaveProperty('next_cursor');
    expect((await as('seller2', listAssignmentsRoute, 'assignments?mine=true')).status).toBe(200);
    expect((await (await as('seller2', listAssignmentsRoute, 'assignments?mine=true')).json()).data.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await as('leader', listAssignmentsRoute, 'assignments?mine=true')).status).toBe(200);

    // A seller may not see the cross-account list: it shows leaders' notes and decline reasons.
    expect((await as('seller', listAssignmentsRoute, 'assignments')).status).toBe(403);
    expect((await as('seller', listAssignmentsRoute, 'assignments?mine=false')).status).toBe(403);
    const all = await as('leader', listAssignmentsRoute, 'assignments?status=pending');
    expect(all.status).toBe(200);
    expect((await all.json()).data.map((r: { id: string }) => r.id)).toContain(id);
    // review:act without assign:act is enough for the cross-account list; the services are for people, so a key is refused.
    expect((await as('operator', listAssignmentsRoute, 'assignments')).status).toBe(200);
    expect((await as('operator', listAssignmentsRoute, 'assignments?mine=true')).status).toBe(403);
    expect((await viaKey(await keyIn(['review:act']), listAssignmentsRoute, 'assignments')).status).toBe(403);
    expect((await viaKey(await keyIn(['accounts:read']), listAssignmentsRoute, 'assignments')).status).toBe(403);
    expect((await as('leader', listAssignmentsRoute, 'assignments?limit=0')).status).toBe(400);
    expect((await as('leader', listAssignmentsRoute, 'assignments?cursor=zzz')).status).toBe(400);
  });

  it('lists the assignments of one account for assign:act; hidden or missing is 404', async () => {
    const a = await account();
    const { id } = await assignTo('seller', a);
    const res = await as('leader', listAccountAssignments, `accounts/${a}/assignments`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([expect.objectContaining({ id, account_id: a, seller_name: expect.any(String) })]);
    expect((await as('seller', listAccountAssignments, `accounts/${a}/assignments`)).status).toBe(403);
    expect((await as('leader', listAccountAssignments, 'accounts/acc_missing/assignments')).status).toBe(404);
  });
});

describe('bulk', () => {
  it('applies one action to many accounts with a result each, and checks assign:act for assign', async () => {
    const [a, b] = [await account(), await account()];
    const res = await as('leader', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b, 'acc_missing'], action: 'status', to: 'needs_review' });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { account_id: a, ok: true },
      { account_id: b, ok: true },
      { account_id: 'acc_missing', ok: false, status: 404, message: 'That account was not found.' },
    ]);
    const assigned = await as('leader', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b], action: 'assign', seller_user_id: ids.seller });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);

    // An operator holding review:act but not assign:act can set statuses, not assign.
    const c = await account();
    const body = { account_ids: [c], action: 'assign', seller_user_id: ids.seller };
    expect((await as('operator', bulkRoute, 'review-queue/bulk', 'POST', body)).status).toBe(403);
    expect((await as('operator', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [c], action: 'status', to: 'reviewed' })).status).toBe(200);

    for (const bad of [{ account_ids: [], action: 'status', to: 'reviewed' }, { account_ids: Array.from({ length: 51 }, (_, i) => `acc_${i}`), action: 'status', to: 'reviewed' }]) {
      const r = await as('leader', bulkRoute, 'review-queue/bulk', 'POST', bad);
      expect(r.status).toBe(400);
      expect((await r.json()).title).toBe('Pick 1 to 50 accounts.');
    }
    expect((await as('leader', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [c], action: 'nope' })).status).toBe(400);
    expect((await as('leader', bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [c], action: 'status' })).status).toBe(400);
  });
});

describe('account status', () => {
  it('answers by account id and by arrival id, in snake_case', async () => {
    const src = await personAndAgent(tenant(), 'Status');
    const key = await keyFor(tenant(), [...SEND, 'status:read'], { sourceId: src.agentId, dataLimit: { kind: 'own_source' } });
    const sent = await call(postArrival, key, 'arrivals', { body: { account: { name: 'Status Co', domain: `${newId('acc').slice(-10).toLowerCase()}-example.com` } } });
    expect(sent.status).toBe(202);
    const arrivalId = (await sent.json()).arrival_id as string;
    const waiting = await call(getStatus, key, `accounts/${arrivalId}/status`);
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ account_id: null, name: null, stage: 'arrived', summary: 'Received. Matching it to an account.' });

    await runOutbox(tenantId);
    const byArrival = await (await call(getStatus, key, `accounts/${arrivalId}/status`)).json();
    expect(byArrival).toMatchObject({
      account_id: expect.stringMatching(/^acc_/),
      name: 'Status Co',
      stage: 'arrived',
      review_status: 'unvetted',
      owner_name: null,
      last_activity_at: null,
      summary: 'Waiting for review.',
    });
    expect(await (await call(getStatus, key, `accounts/${byArrival.account_id}/status`)).json()).toEqual(byArrival);

    await assignTo('seller', byArrival.account_id);
    const assigned = await (await call(getStatus, key, `accounts/${byArrival.account_id}/status`)).json();
    expect(assigned).toMatchObject({ stage: 'reviewed', review_status: 'reviewed', owner_name: expect.any(String), summary: expect.stringMatching(/^Assigned to .+ on [A-Z][a-z]{2} \d+\.$/) });
    expect((await viaKey(await keyIn(['accounts:read']), getStatus, `accounts/${byArrival.account_id}/status`)).status).toBe(403);
    expect((await call(getStatus, key, 'accounts/acc_missing/status')).status).toBe(404);
    expect((await call(getStatus, key, 'accounts/arr_missing/status')).status).toBe(404);
  });

  it('Review Focus 5: another source account or arrival is 404, never 403', async () => {
    const mineKey = await keyFor(tenant(), [...SEND, 'status:read'], { sourceId: ash.agentId, dataLimit: { kind: 'own_source' } });
    const theirKey = await keyFor(tenant(), [...SEND, 'status:read'], { sourceId: bo.agentId, dataLimit: { kind: 'own_source' } });
    const theirs = await call(postArrival, theirKey, 'arrivals', { body: { account: { name: 'Bo Co', domain: `${newId('acc').slice(-10).toLowerCase()}-example.com` } } });
    const arrivalId = (await theirs.json()).arrival_id as string;
    await runOutbox(tenantId);
    const accountId = (await (await call(getStatus, theirKey, `accounts/${arrivalId}/status`)).json()).account_id as string;
    expect(accountId).toMatch(/^acc_/);
    for (const id of [arrivalId, accountId]) {
      const res = await call(getStatus, mineKey, `accounts/${id}/status`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
  });
});

describe('TEN-E3-S1-AC2: each data limit kind on the queue, count and status', () => {
  it('shows only what the limit allows', async () => {
    const t = await freshTenant();
    await runOutbox(t.tenantId);
    const [x, y] = [await personAndAgent(t, 'Xi'), await personAndAgent(t, 'Yu')];
    const mine = await arrivedAccount(t, { name: 'Xi Co', sourceChain: { agentSourceId: x.agentId } });
    const theirs = await arrivedAccount(t, { name: 'Yu Co', sourceChain: { agentSourceId: y.agentId } });
    const kinds: { name: string; limit: unknown; source?: string; x: boolean; y: boolean }[] = [
      { name: 'all', limit: { kind: 'all' }, x: true, y: true },
      { name: 'own_source', limit: { kind: 'own_source' }, source: x.agentId, x: true, y: false },
      { name: 'sources', limit: { kind: 'sources', ids: [y.agentId] }, x: false, y: true },
      { name: 'practices (out)', limit: { kind: 'practices', ids: ['prc_none'] }, x: false, y: false },
      { name: 'own_accounts', limit: { kind: 'own_accounts' }, x: false, y: false },
      { name: 'any_of', limit: { kind: 'any_of', limits: [{ kind: 'own_source' }, { kind: 'sources', ids: [y.agentId] }] }, source: x.agentId, x: true, y: true },
    ];
    for (const k of kinds) {
      const key = await keyFor(t, ['review:act', 'status:read'], { dataLimit: k.limit as never, ...(k.source ? { sourceId: k.source } : {}) });
      const queue = (await (await call(queueRoute, key, 'review-queue')).json()).data.map((r: { account_id: string }) => r.account_id).sort();
      const expected = [...(k.x ? [mine] : []), ...(k.y ? [theirs] : [])].sort();
      expect([k.name, queue]).toEqual([k.name, expected]);
      expect([k.name, await (await call(countRoute, key, 'review-queue/count')).json()]).toEqual([k.name, { count: expected.length }]);
      for (const [id, sees] of [[mine, k.x], [theirs, k.y]] as const) {
        expect([k.name, id, (await call(getStatus, key, `accounts/${id}/status`)).status]).toEqual([k.name, id, sees ? 200 : 404]);
      }
    }
  });
});

describe('review settings', () => {
  it('GET shows statuses, decline reasons and auto-accept; it needs settings:manage', async () => {
    const res = await as('owner', getSettings, 'settings/review');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auto_accept_working_days).toBe(2);
    expect(body.statuses.map((s: { key: string }) => s.key)).toEqual(['unvetted', 'needs_review', 'reviewed', 'declined']);
    expect(body.statuses[3]).toMatchObject({ key: 'declined', label: 'Declined', counts_as_reviewed: true, is_declined: true, is_initial: false, returns_to_source: false, archived: false });
    expect(body.decline_reasons.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['not_a_fit', 'other', 'not_my_territory']));
    expect(body.decline_reasons.find((r: { key: string }) => r.key === 'other')).toMatchObject({ label: 'Other', applies_to: 'both', note_required: true });
    expect((await as('leader', getSettings, 'settings/review')).status).toBe(403);
    expect((await viaKey(await keyIn(['accounts:read']), getSettings, 'settings/review')).status).toBe(403);
  });

  it('PUT changes only auto_accept_working_days (1 to 10, or null), audits it, and refuses the rest', async () => {
    const put = (body: unknown, who: Who = 'owner') => as(who, putSettings, 'settings/review', 'PUT', body);
    const ok = await put({ auto_accept_working_days: 5 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).auto_accept_working_days).toBe(5);
    expect((await (await as('owner', getSettings, 'settings/review')).json()).auto_accept_working_days).toBe(5);
    const off = await put({ auto_accept_working_days: null });
    expect((await off.json()).auto_accept_working_days).toBeNull();
    const audited = await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'routing.settings.updated')));
    expect(audited.length).toBe(2);
    expect(audited[0]).toMatchObject({ before: { autoAcceptWorkingDays: 2 }, after: { autoAcceptWorkingDays: 5 } });

    for (const bad of [0, 11, 2.5, 'x']) {
      const res = await put({ auto_accept_working_days: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    const range = await put({ auto_accept_working_days: 11 });
    expect((await range.json()).errors).toEqual([{ path: 'auto_accept_working_days', message: 'Pick 1 to 10 working days, or turn it off.' }]);
    expect((await put({})).status).toBe(400);
    expect((await put({ auto_accept_working_days: 3, statuses: [] })).status).toBe(400);
    expect((await put({ auto_accept_working_days: 3 }, 'leader')).status).toBe(403);
    expect((await viaKey(await keyIn(['settings:manage']), putSettings, 'settings/review', 'PUT', { auto_accept_working_days: 3 })).status).toBe(403);
    expect((await (await as('owner', getSettings, 'settings/review')).json()).auto_accept_working_days).toBeNull();
  });
});
