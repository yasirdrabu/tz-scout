import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getPlanRoute } from '@/http/routes/v1/accounts/[id]/plan/route';
import { POST as actionRoute } from '@/http/routes/v1/plans/[id]/route';
import { POST as addRoute } from '@/http/routes/v1/plans/[id]/steps/route';
import { DELETE as removeRoute, PATCH as stepRoute } from '@/http/routes/v1/plans/[id]/steps/[stepId]/route';
import { GET as reviewRoute } from '@/http/routes/v1/accounts/[id]/review/route';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { createTemplate, setOfferPlaybook } from '@/modules/playbooks';
import { accept, assign } from '@/modules/routing';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { completeOffer } from '../offers/helpers';
import { asPerson, setSummary } from '../routing/helpers';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let leader: string;
let seller: string;
let outsider: string;
let accountId: string;
let planId: string;
let offerId: string;
let stepIds: string[];
let extraStepId: string;

const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', subject: 'Hi {person.first_name}', body: 'Hello from {seller.first_name}' },
  { day: 2, channel: 'call' as const, ownerRole: 'seller' as const, title: 'Call' },
];

beforeAll(async () => {
  w = await workspace('Plans Co');
  leader = await w.person('leader');
  seller = await w.person('seller', { name: 'Sam Seller' });
  // A seller who sees only one source, which is not this account's.
  outsider = await w.person('seller', { dataLimit: { kind: 'sources', ids: ['src_elsewhere'] } });
  const practice = await w.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await w.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  const template = await w.run((ctx) => createTemplate(ctx, { name: 'HTTP flow', status: 'active', steps }));
  await w.run((ctx) => setOfferPlaybook(ctx, offerId, 'act_now', template.id));

  accountId = await w.account('Plan Route Co');
  await setSummary(w.tenant, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(w.tenant, (ctx) => assign(ctx, accountId, { sellerUserId: seller }), { userId: leader });
  await asPerson(w.tenant, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  // Every consumer: the plan starts, and the account summary learns its owner (a seller sees only their own accounts).
  await w.deliver();
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('GET /api/v1/accounts/{id}/plan', () => {
  it('returns the open plan with steps and history, snake_case', async () => {
    const res = await w.as(leader, getPlanRoute, `accounts/${accountId}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    planId = body.id;
    stepIds = body.steps.map((s: { id: string }) => s.id);
    expect(body).toMatchObject({
      status: 'active',
      playbook: { name: 'HTTP flow', version: 1 },
      newer_version: false,
      stop_when: 'reply_or_meeting',
      day: 0,
      days: 2,
      seller_user_id: seller,
    });
    expect(body.steps[0]).toMatchObject({ order: 1, day: 0, channel: 'email', owner_role: 'seller', owner_user_id: seller, owner_name: 'Sam Seller', status: 'todo', origin: 'template', crm_task: true });
    expect(body.steps[0].subject).toBe('Hi there');
    expect(body.steps[0].body).toBe('Hello from Sam');
    expect(body.history.map((h: { kind: string }) => h.kind)).toEqual(['created']);
    expect(body.tenant_id).toBeUndefined();
  });

  it('is a 404 for an account with no plan, and for a seller outside the data limit', async () => {
    const bare = await w.account('Bare Co');
    expect((await w.as(leader, getPlanRoute, `accounts/${bare}/plan`)).status).toBe(404);
    expect((await w.as(outsider, getPlanRoute, `accounts/${accountId}/plan`)).status).toBe(404);
    expect((await w.as(outsider, actionRoute, `plans/${planId}:pause`, 'POST')).status).toBe(404);
    expect((await w.as(outsider, stepRoute, `plans/${planId}/steps/${stepIds[0]}`, 'PATCH', { note: 'x' })).status).toBe(404);
  });

  it('refuses an agent key on writes (403) but reads with playbooks:read', async () => {
    // A key limited to its own source sees no plan on an account from elsewhere: 404, as for a hidden account.
    const limited = await keyFor(w.tenant, ['playbooks:read', 'playbooks:write']);
    expect((await call(getPlanRoute, limited, `accounts/${accountId}/plan`)).status).toBe(404);
    expect((await call(actionRoute, limited, `plans/${planId}:pause`, { method: 'POST' })).status).toBe(403);
    const key = await keyFor(w.tenant, ['playbooks:read', 'playbooks:write'], { dataLimit: { kind: 'all' } });
    expect((await call(getPlanRoute, key, `accounts/${accountId}/plan`)).status).toBe(200);
    expect((await call(stepRoute, key, `plans/${planId}/steps/${stepIds[0]}`, { method: 'PATCH', body: { note: 'agent' } })).status).toBe(403);
    expect((await call(actionRoute, key, `plans/${planId}:pause`, { method: 'POST' })).status).toBe(403);
  });
});

describe('PATCH /api/v1/plans/{id}/steps/{stepId}', () => {
  it('updates status, note, owner and due date; validates the body', async () => {
    const path = `plans/${planId}/steps/${stepIds[0]}`;
    const ok = await w.as(seller, stepRoute, path, 'PATCH', { status: 'done', note: 'Sent', due_date: '2030-02-01', owner_user_id: leader });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.steps[0]).toMatchObject({ status: 'done', note: 'Sent', due_date: '2030-02-01', owner_user_id: leader, done_by: seller });
    expect(body.history.map((h: { kind: string }) => h.kind)).toEqual(expect.arrayContaining(['step_status', 'note', 'owner', 'due_date']));

    expect((await w.as(seller, stepRoute, path, 'PATCH', { status: 'finished' })).status).toBe(400);
    const long = await w.as(seller, stepRoute, path, 'PATCH', { note: 'x'.repeat(2001) });
    expect(long.status).toBe(400);
    expect((await long.json()).errors[0].message).toBe('Keep this under 2,000 characters.');
    expect((await w.as(seller, stepRoute, path, 'PATCH', { owner_user_id: 'usr_nobody' })).status).toBe(400);
    expect((await w.as(seller, stepRoute, path, 'PATCH', { surprise: 1 })).status).toBe(400);
    expect((await w.as(seller, stepRoute, `plans/${planId}/steps/stp_missing`, 'PATCH', { note: 'x' })).status).toBe(404);
  });

  it('an operator holds playbooks:write and can update a step; a viewer cannot (403)', async () => {
    const operator = await w.person('operator');
    expect((await w.as(operator, stepRoute, `plans/${planId}/steps/${stepIds[1]}`, 'PATCH', { note: 'x' })).status).toBe(200);
    const viewer = await w.person('viewer');
    expect((await w.as(viewer, stepRoute, `plans/${planId}/steps/${stepIds[1]}`, 'PATCH', { note: 'y' })).status).toBe(403);
  });
});

describe('customising a plan over HTTP', () => {
  it('GET plan carries customised, and people, missing_roles and target_buying_roles on steps', async () => {
    const body = await (await w.as(leader, getPlanRoute, `accounts/${accountId}/plan`)).json();
    expect(body.customised).toBe(false);
    expect(body.steps[0]).toMatchObject({ target_buying_roles: [], people: [], missing_roles: [] });
  });

  it('POST /plans/{id}/steps adds a step (201, the whole plan); the body is checked', async () => {
    const path = `plans/${planId}/steps`;
    const res = await w.as(seller, addRoute, path, 'POST', {
      day: 1,
      channel: 'email',
      owner_role: 'seller',
      title: 'Extra touch',
      detail: 'Detail',
      subject: 'Hello',
      body: 'Body',
      target_buying_roles: ['champion'],
      crm_task: false,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.customised).toBe(true);
    const added = body.steps.find((s: { title: string }) => s.title === 'Extra touch');
    expect(added).toMatchObject({
      origin: 'added',
      template_step_id: null,
      day: 1,
      channel: 'email',
      owner_role: 'seller',
      owner_user_id: seller,
      owner_name: 'Sam Seller',
      subject: 'Hello',
      crm_task: false,
      target_buying_roles: ['champion'],
      people: [],
      missing_roles: ['champion'],
      status: 'todo',
    });
    expect(body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
    extraStepId = added.id;
    expect(body.history[0]).toMatchObject({ kind: 'step_added', step_id: added.id });

    const bad = async (payload: unknown) => w.as(seller, addRoute, path, 'POST', payload);
    const ok = { day: 1, channel: 'call', owner_role: 'seller', title: 'T' };
    expect((await bad({ ...ok, surprise: 1 })).status).toBe(400);
    expect((await bad({ ...ok, title: '' })).status).toBe(400);
    expect((await bad({ ...ok, day: -1 })).status).toBe(400);
    expect((await bad({ ...ok, channel: 'fax' })).status).toBe(400);
    expect((await bad({ ...ok, owner_role: 'ceo' })).status).toBe(400);
    expect((await bad({ day: 1 })).status).toBe(400);
    const role = await bad({ ...ok, target_buying_roles: ['wizard'] });
    expect(role.status).toBe(400);
    expect((await role.json()).errors[0]).toMatchObject({ path: 'target_buying_roles', message: 'Unknown buying role: wizard' });
    expect((await w.as(seller, addRoute, 'plans/pln_missing/steps', 'POST', ok)).status).toBe(404);
    expect((await w.as(outsider, addRoute, path, 'POST', ok)).status).toBe(404);
  });

  it('PATCH takes the content fields; a new day recomputes the due date', async () => {
    const path = `plans/${planId}/steps/${extraStepId}`;
    const res = await w.as(seller, stepRoute, path, 'PATCH', { title: 'Renamed', day: 2, target_buying_roles: ['champion', 'business_owner'], detail: null, crm_task: true });
    expect(res.status).toBe(200);
    const step = (await res.json()).steps.find((s: { id: string }) => s.id === extraStepId);
    expect(step).toMatchObject({ title: 'Renamed', day: 2, origin: 'added', detail: null, crm_task: true, target_buying_roles: ['champion', 'business_owner'] });
    expect(step.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await w.as(seller, stepRoute, path, 'PATCH', { day: 366 })).status).toBe(400);
    expect((await w.as(seller, stepRoute, path, 'PATCH', { title: '' })).status).toBe(400);
    expect((await w.as(seller, stepRoute, path, 'PATCH', { channel: 'fax' })).status).toBe(400);
  });

  it('DELETE removes a step; a done step is a 409; a viewer and an agent key are refused', async () => {
    const done = await w.as(seller, removeRoute, `plans/${planId}/steps/${stepIds[0]}`, 'DELETE');
    expect(done.status).toBe(409);
    expect((await done.json()).title).toBe("A done step can't be removed. Skip it instead.");

    const viewer = await w.person('viewer');
    expect((await w.as(viewer, removeRoute, `plans/${planId}/steps/${extraStepId}`, 'DELETE')).status).toBe(403);
    expect((await w.as(viewer, addRoute, `plans/${planId}/steps`, 'POST', { day: 1, channel: 'call', owner_role: 'seller', title: 'T' })).status).toBe(403);
    const key = await keyFor(w.tenant, ['playbooks:read', 'playbooks:write'], { dataLimit: { kind: 'all' } });
    expect((await call(removeRoute, key, `plans/${planId}/steps/${extraStepId}`, { method: 'DELETE' })).status).toBe(403);
    expect((await call(addRoute, key, `plans/${planId}/steps`, { body: { day: 1, channel: 'call', owner_role: 'seller', title: 'T' } })).status).toBe(403);

    const res = await w.as(seller, removeRoute, `plans/${planId}/steps/${extraStepId}`, 'DELETE');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual(stepIds);
    expect(body.customised).toBe(true);
    expect(body.history.map((h: { kind: string }) => h.kind)).toEqual(expect.arrayContaining(['step_added', 'step_edited', 'step_removed']));
    expect((await w.as(seller, removeRoute, `plans/${planId}/steps/${extraStepId}`, 'DELETE')).status).toBe(404);
  });
});

describe('GET /api/v1/accounts/{id}/review current assignment playbook', () => {
  it('names the playbook the assignment chose or its tier maps to, with playbooks:read', async () => {
    const res = await w.as(leader, reviewRoute, `accounts/${accountId}/review`);
    expect(res.status).toBe(200);
    expect((await res.json()).current_assignment).toMatchObject({ seller_user_id: seller, playbook_name: 'HTTP flow', no_playbook: false, template_id: null, plan_resumes: true });
  });

  it('without playbooks:read the playbook fields are null', async () => {
    const viewer = await w.person('viewer');
    const res = await w.as(viewer, reviewRoute, `accounts/${accountId}/review`);
    expect(res.status).toBe(200);
    expect((await res.json()).current_assignment).toMatchObject({ seller_user_id: seller, template_id: null, no_playbook: null, playbook_name: null, plan_resumes: null });
  });
});

describe('GET /api/v1/accounts/{id}/review with an open plan', () => {
  it('names the open plan playbook and says it resumes, paused or active; false when there is no open plan', async () => {
    // The tier now maps to another playbook; the account's plan keeps the one it started with.
    const other = await w.run((ctx) => createTemplate(ctx, { name: 'Other flow', status: 'active', steps }));
    await w.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', other.id));
    const own = await w.account('Resume Co');
    await setSummary(w.tenant, own, { tier: 'good_fit', bestOfferId: offerId });
    const made = await asPerson(w.tenant, (ctx) => assign(ctx, own, { sellerUserId: seller }), { userId: leader });

    const before = await (await w.as(leader, reviewRoute, `accounts/${own}/review`)).json();
    expect(before.current_assignment).toMatchObject({ playbook_name: 'Other flow', plan_resumes: false });

    await asPerson(w.tenant, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await w.deliver();
    const planOf = await (await w.as(leader, getPlanRoute, `accounts/${own}/plan`)).json();
    expect(planOf.playbook.name).toBe('Other flow');
    // Repoint the tier, then pause: the plan's own playbook is still the one named.
    const next = await w.run((ctx) => createTemplate(ctx, { name: 'Later flow', status: 'active', steps }));
    await w.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', next.id));
    expect((await w.as(leader, actionRoute, `plans/${planOf.id}:pause`, 'POST')).status).toBe(200);
    const paused = await (await w.as(leader, reviewRoute, `accounts/${own}/review`)).json();
    expect(paused.current_assignment).toMatchObject({ playbook_name: 'Other flow', plan_resumes: true });

    const viewer = await w.person('viewer');
    expect((await (await w.as(viewer, reviewRoute, `accounts/${own}/review`)).json()).current_assignment).toMatchObject({ playbook_name: null, plan_resumes: null });

    // A closed plan no longer resumes.
    await w.as(leader, actionRoute, `plans/${planOf.id}:abandon`, 'POST', { reason: 'Test' });
    const closed = await (await w.as(leader, reviewRoute, `accounts/${own}/review`)).json();
    expect(closed.current_assignment.plan_resumes).toBe(false);
  });
});

describe('POST /api/v1/plans/{id}:action', () => {
  it('complete before every step is finished is a 409; abandon without a reason is a 400', async () => {
    const early = await w.as(leader, actionRoute, `plans/${planId}:complete`, 'POST');
    expect(early.status).toBe(409);
    expect((await early.json()).title).toBe('Finish or skip every step first.');
    const none = await w.as(leader, actionRoute, `plans/${planId}:abandon`, 'POST', {});
    expect(none.status).toBe(400);
    expect((await none.json()).title).toBe("Say why you're abandoning it.");
    expect((await w.as(leader, actionRoute, `plans/${planId}:nope`, 'POST')).status).toBe(404);
  });

  it('pause, resume, complete, then a closed plan refuses changes with 409', async () => {
    expect((await (await w.as(leader, actionRoute, `plans/${planId}:pause`, 'POST')).json()).status).toBe('paused');
    expect((await (await w.as(leader, actionRoute, `plans/${planId}:resume`, 'POST')).json()).status).toBe('active');
    await w.as(seller, stepRoute, `plans/${planId}/steps/${stepIds[1]}`, 'PATCH', { status: 'skipped' });
    const done = await w.as(leader, actionRoute, `plans/${planId}:complete`, 'POST');
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe('completed');

    const ended = await w.as(seller, stepRoute, `plans/${planId}/steps/${stepIds[0]}`, 'PATCH', { note: 'late' });
    expect(ended.status).toBe(409);
    expect((await ended.json()).title).toBe('This plan has ended.');
    expect((await w.as(leader, actionRoute, `plans/${planId}:abandon`, 'POST', { reason: 'too late' })).status).toBe(409);
    // The latest plan still reads after it ended.
    expect((await (await w.as(leader, getPlanRoute, `accounts/${accountId}/plan`)).json()).status).toBe('completed');
  });
});
