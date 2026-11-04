import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getPlanRoute } from '@/http/routes/v1/accounts/[id]/plan/route';
import { POST as actionRoute } from '@/http/routes/v1/plans/[id]/route';
import { PATCH as stepRoute } from '@/http/routes/v1/plans/[id]/steps/[stepId]/route';
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
let stepIds: string[];

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
  const offerId = (await w.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
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

  it('an operator, who holds no playbooks:write, cannot write (403)', async () => {
    const operator = await w.person('operator');
    expect((await w.as(operator, stepRoute, `plans/${planId}/steps/${stepIds[1]}`, 'PATCH', { note: 'x' })).status).toBe(403);
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
