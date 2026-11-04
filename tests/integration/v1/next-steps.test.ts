import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as accountsRoute } from '@/http/routes/v1/accounts/route';
import { GET as assignmentsRoute } from '@/http/routes/v1/assignments/route';
import { GET as countsRoute } from '@/http/routes/v1/me/counts/route';
import { GET as getPlanRoute } from '@/http/routes/v1/accounts/[id]/plan/route';
import { PATCH as stepRoute } from '@/http/routes/v1/plans/[id]/steps/[stepId]/route';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { archiveTemplate, createTemplate, setOfferPlaybook } from '@/modules/playbooks';
import { localDate } from '@/modules/playbooks/domain/plan';
import { accept, assign } from '@/modules/routing';
import { ROLE_PERMISSIONS, setPrincipalCacheTtl, setRolePermissions } from '@/modules/tenancy';
import { tenant } from '@/modules/tenancy/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { eq } from 'drizzle-orm';
import { completeOffer } from '../offers/helpers';
import { asPerson, setSummary } from '../routing/helpers';
import { workspace, type Workspace } from './review-helpers';

// Count the calls to nextSteps that the lists make, to prove one call serves a whole page.
const calls = vi.hoisted(() => ({ nextSteps: 0 }));
vi.mock('@/modules/playbooks', async (orig) => {
  const m = await orig<typeof import('@/modules/playbooks')>();
  return {
    ...m,
    nextSteps: (...args: Parameters<typeof m.nextSteps>) => {
      calls.nextSteps += 1;
      return m.nextSteps(...args);
    },
  };
});

type Row = { account_id: string; status?: string; next_step: { title: string; due_date: string; overdue: boolean; due_today: boolean } | null; playbook_name: string | null };

let w: Workspace;
let leader: string;
let seller: string;
let offerId: string;
let accountA: string;
let accountE: string;
let planA: string;
let planE: string;

const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', subject: 'Hi', body: 'Hello' },
  { day: 30, channel: 'call' as const, ownerRole: 'seller' as const, title: 'Call' },
];

const json = async (res: Response) => {
  expect(res.status).toBe(200);
  return res.json();
};
const today = () => localDate(Date.now(), 'UTC');

/** A new account assigned to the seller; accepted when asked. */
async function assigned(name: string, opts: { accepted: boolean; noPlaybook?: boolean }) {
  const id = await w.account(name);
  await setSummary(w.tenant, id, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(w.tenant, (ctx) => assign(ctx, id, { sellerUserId: seller, ...(opts.noPlaybook ? { noPlaybook: true } : {}) }), { userId: leader });
  if (opts.accepted) await asPerson(w.tenant, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  return id;
}

const planOf = async (accountId: string) => json(await w.as(leader, getPlanRoute, `accounts/${accountId}/plan`));
const patch = async (planId: string, stepId: string, body: object) => expect((await w.as(seller, stepRoute, `plans/${planId}/steps/${stepId}`, 'PATCH', body)).status).toBe(200);

beforeAll(async () => {
  w = await workspace('Next Steps Co');
  leader = await w.person('leader');
  seller = await w.person('seller', { name: 'Sam Seller' });
  const practice = await w.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await w.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  const template = await w.run((ctx) => createTemplate(ctx, { name: 'Lists flow', status: 'active', steps }));
  await w.run((ctx) => setOfferPlaybook(ctx, offerId, 'act_now', template.id));

  accountA = await assigned('Overdue Co', { accepted: true });
  accountE = await assigned('Today Co', { accepted: true });
  await w.deliver();
  const a = await planOf(accountA);
  planA = a.id;
  // A: the intro is a long time overdue. E: the intro is due today.
  await patch(planA, a.steps[0].id, { due_date: '2020-01-01' });
  const e = await planOf(accountE);
  planE = e.id;
  await patch(planE, e.steps[0].id, { due_date: today() });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('next step in the lists', () => {
  it('My assignments show the next step and playbook, null without a plan', async () => {
    const pending = await assigned('Pending Co', { accepted: false });
    const none = await assigned('Skipped Co', { accepted: false, noPlaybook: true });
    await w.deliver();
    const rows = (await json(await w.as(seller, assignmentsRoute, 'assignments?mine=true'))).data as Row[];
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));

    expect(byAccount.get(accountA)).toMatchObject({ playbook_name: 'Lists flow', next_step: { title: 'Intro', due_date: '2020-01-01', overdue: true, due_today: false } });
    expect(byAccount.get(accountE)).toMatchObject({ next_step: { title: 'Intro', due_date: today(), overdue: false, due_today: true } });
    // Not accepted yet: no plan, but the playbook that will start (the offer's playbook for the tier) is named.
    expect(byAccount.get(pending)).toMatchObject({ next_step: null, playbook_name: 'Lists flow' });
    // The assigner chose to send none.
    expect(byAccount.get(none)).toMatchObject({ next_step: null, playbook_name: null });
  });

  it("a pending row names the assigner's own pick over the offer's mapping", async () => {
    const other = await w.run((ctx) => createTemplate(ctx, { name: 'Picked flow', status: 'active', steps }));
    const id = await w.account('Picked Co');
    await setSummary(w.tenant, id, { tier: 'act_now', bestOfferId: offerId });
    await asPerson(w.tenant, (ctx) => assign(ctx, id, { sellerUserId: seller, templateId: other.id }), { userId: leader });
    const rows = (await json(await w.as(seller, assignmentsRoute, 'assignments?mine=true&status=pending'))).data as Row[];
    expect(rows.find((r) => r.account_id === id)).toMatchObject({ next_step: null, playbook_name: 'Picked flow' });
  });

  it('the accounts list shows next_step and playbook_name, null for an account with no plan', async () => {
    const bare = await w.account('Bare Co');
    const rows = (await json(await w.as(leader, accountsRoute, 'accounts'))).data as Row[];
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(byAccount.get(accountA)).toMatchObject({ playbook_name: 'Lists flow', next_step: { title: 'Intro', due_date: '2020-01-01', overdue: true, due_today: false } });
    expect(byAccount.get(accountE)?.next_step).toMatchObject({ overdue: false, due_today: true });
    expect(byAccount.get(bare)).toMatchObject({ next_step: null, playbook_name: null });
  });

  it('picks the earliest open step; a done step moves it on, and a paused or finished plan keeps its name with no next step', async () => {
    const a = await planOf(accountA);
    await patch(planA, a.steps[0].id, { status: 'done' });
    let row = ((await json(await w.as(leader, accountsRoute, 'accounts'))).data as Row[]).find((r) => r.account_id === accountA)!;
    expect(row.next_step).toMatchObject({ title: 'Call', overdue: false, due_today: false });

    expect((await w.as(leader, (await import('@/http/routes/v1/plans/[id]/route')).POST, `plans/${planA}:pause`, 'POST')).status).toBe(200);
    row = ((await json(await w.as(leader, accountsRoute, 'accounts'))).data as Row[]).find((r) => r.account_id === accountA)!;
    expect(row).toMatchObject({ next_step: null, playbook_name: 'Lists flow' });
    expect((await w.as(leader, (await import('@/http/routes/v1/plans/[id]/route')).POST, `plans/${planA}:resume`, 'POST')).status).toBe(200);

    // Every step done: nothing left to do, but the plan is still running and named.
    await patch(planA, a.steps[1].id, { status: 'done' });
    row = ((await json(await w.as(leader, accountsRoute, 'accounts'))).data as Row[]).find((r) => r.account_id === accountA)!;
    expect(row).toMatchObject({ next_step: null, playbook_name: 'Lists flow' });
    const mine = (await json(await w.as(seller, assignmentsRoute, 'assignments?mine=true'))).data as Row[];
    expect(mine.find((r) => r.account_id === accountA)).toMatchObject({ next_step: null, playbook_name: 'Lists flow' });
  });

  it('a list of 50 accounts makes one nextSteps call', async () => {
    for (let i = 0; i < 48; i++) await w.account(`Bulk ${i}`);
    calls.nextSteps = 0;
    const rows = (await json(await w.as(leader, accountsRoute, 'accounts?limit=100'))).data as Row[];
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(calls.nextSteps).toBe(1);
  });
});

describe('GET /api/v1/me/counts', () => {
  it('counts only the caller\'s own steps that are due today or overdue', async () => {
    // A's intro is done and its call is 30 days out: nothing due. E: one due today. Give the seller one overdue step.
    const e = await planOf(accountE);
    await patch(planE, e.steps[1].id, { due_date: '2020-02-02' });
    const counts = await json(await w.as(seller, countsRoute, 'me/counts'));
    expect(counts).toMatchObject({ next_steps_due_today: 1, next_steps_overdue: 1 });

    // Hand the overdue step to the leader: the seller's overdue count drops, the leader's rises.
    await patch(planE, e.steps[1].id, { owner_user_id: leader });
    expect(await json(await w.as(seller, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: 1, next_steps_overdue: 0 });
    expect(await json(await w.as(leader, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: 0, next_steps_overdue: 1 });
  });

  it('does not count done steps or paused plans', async () => {
    const e = await planOf(accountE);
    await patch(planE, e.steps[0].id, { status: 'done' });
    expect(await json(await w.as(seller, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: 0, next_steps_overdue: 0 });
  });
});

describe('archived templates on pending rows', () => {
  it('name neither an archived pick nor an archived offer mapping', async () => {
    const pickedTpl = await w.run((ctx) => createTemplate(ctx, { name: 'Old pick', status: 'active', steps }));
    const picked = await w.account('Archived Pick Co');
    await setSummary(w.tenant, picked, { tier: 'act_now', bestOfferId: offerId });
    await asPerson(w.tenant, (ctx) => assign(ctx, picked, { sellerUserId: seller, templateId: pickedTpl.id }), { userId: leader });

    // A second offer whose good_fit playbook gets archived after it was mapped.
    const practice = await w.run((ctx) => createPractice(ctx, { name: 'Other' }));
    const offer2 = (await w.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot 2', practiceId: practice.id, ...completeOffer })).id))).id;
    const mappedTpl = await w.run((ctx) => createTemplate(ctx, { name: 'Old mapping', status: 'active', steps }));
    await w.run((ctx) => setOfferPlaybook(ctx, offer2, 'good_fit', mappedTpl.id));
    const mapped = await w.account('Archived Mapping Co');
    await setSummary(w.tenant, mapped, { tier: 'good_fit', bestOfferId: offer2 });
    await asPerson(w.tenant, (ctx) => assign(ctx, mapped, { sellerUserId: seller }), { userId: leader });

    await w.deliver();
    const before = (await json(await w.as(seller, assignmentsRoute, 'assignments?mine=true&status=pending'))).data as Row[];
    expect(before.find((r) => r.account_id === picked)?.playbook_name).toBe('Old pick');
    expect(before.find((r) => r.account_id === mapped)?.playbook_name).toBe('Old mapping');

    await w.run((ctx) => archiveTemplate(ctx, pickedTpl.id));
    await w.run((ctx) => archiveTemplate(ctx, mappedTpl.id));
    const after = (await json(await w.as(seller, assignmentsRoute, 'assignments?mine=true&status=pending'))).data as Row[];
    expect(after.find((r) => r.account_id === picked)).toMatchObject({ playbook_name: null, next_step: null });
    expect(after.find((r) => r.account_id === mapped)).toMatchObject({ playbook_name: null, next_step: null });
  });
});

describe('another timezone, and without playbooks:read', () => {
  let w2: Workspace;
  let leader2: string;
  let seller2: string;
  let viewer: string;
  let account2: string;
  let plan2: string;

  beforeAll(async () => {
    w2 = await workspace('New York Co');
    await adminDb.update(tenant).set({ timezone: 'America/New_York' }).where(eq(tenant.id, w2.tenantId));
    leader2 = await w2.person('leader');
    seller2 = await w2.person('seller');
    viewer = await w2.person('viewer' as never);
    const practice = await w2.run((ctx) => createPractice(ctx, { name: 'Main' }));
    const offer = (await w2.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
    const template = await w2.run((ctx) => createTemplate(ctx, { name: 'NY flow', status: 'active', steps }));
    await w2.run((ctx) => setOfferPlaybook(ctx, offer, 'act_now', template.id));
    account2 = await w2.account('NY Co');
    await setSummary(w2.tenant, account2, { tier: 'act_now', bestOfferId: offer });
    const made = await asPerson(w2.tenant, (ctx) => assign(ctx, account2, { sellerUserId: seller2 }), { userId: leader2 });
    await asPerson(w2.tenant, (ctx) => accept(ctx, made.id), { userId: seller2, dataLimit: { kind: 'own_accounts' } });
    await w2.deliver();
    plan2 = (await json(await w2.as(leader2, getPlanRoute, `accounts/${account2}/plan`))).id;
  });

  const stepsOf = async () => (await json(await w2.as(leader2, getPlanRoute, `accounts/${account2}/plan`))).steps as { id: string }[];
  const setDue = async (due: string) => expect((await w2.as(seller2, stepRoute, `plans/${plan2}/steps/${(await stepsOf())[0]!.id}`, 'PATCH', { due_date: due })).status).toBe(200);
  const rowFor = async (as: string, route: typeof accountsRoute, path: string) => ((await json(await w2.as(as, route, path))).data as Row[]).find((r) => r.account_id === account2)!;

  it('judges due today and overdue in the workspace timezone', async () => {
    // 02:00 UTC on 5 November is 21:00 on 4 November in New York.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-05T02:00:00Z'));
      await setDue('2026-11-04');
      expect((await rowFor(leader2, accountsRoute, 'accounts')).next_step).toMatchObject({ due_date: '2026-11-04', due_today: true, overdue: false });
      expect(await json(await w2.as(seller2, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: 1, next_steps_overdue: 0 });

      await setDue('2026-11-03');
      expect((await rowFor(leader2, accountsRoute, 'accounts')).next_step).toMatchObject({ due_today: false, overdue: true });
      expect(await json(await w2.as(seller2, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: 0, next_steps_overdue: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves next_step and playbook_name null for a caller without playbooks:read', async () => {
    expect(await rowFor(leader2, accountsRoute, 'accounts')).toMatchObject({ playbook_name: 'NY flow' });
    expect(await rowFor(viewer, accountsRoute, 'accounts')).toMatchObject({ next_step: null, playbook_name: null });
    expect(await json(await w2.as(viewer, countsRoute, 'me/counts'))).toMatchObject({ next_steps_due_today: null, next_steps_overdue: null });

    // A seller whose role loses playbooks:read sees the same on My assignments, pending rows included.
    const pending = await w2.account('NY Pending Co');
    await setSummary(w2.tenant, pending, { tier: 'act_now' });
    await asPerson(w2.tenant, (ctx) => assign(ctx, pending, { sellerUserId: seller2 }), { userId: leader2 });
    const withRead = (await json(await w2.as(seller2, assignmentsRoute, 'assignments?mine=true'))).data as Row[];
    expect(withRead.find((r) => r.account_id === account2)?.playbook_name).toBe('NY flow');
    const without = ROLE_PERMISSIONS.seller.filter((p) => p !== 'playbooks:read' && p !== 'playbooks:write');
    await w2.run((ctx) => setRolePermissions(ctx, 'seller', without));
    setPrincipalCacheTtl(0);
    const rows = (await json(await w2.as(seller2, assignmentsRoute, 'assignments?mine=true'))).data as Row[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r).toMatchObject({ next_step: null, playbook_name: null });
  });
});
