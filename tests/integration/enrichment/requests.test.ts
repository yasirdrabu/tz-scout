import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveRequest,
  cancelRequest,
  createRequest,
  declineRequest,
  estimateFor,
  getRequest,
  listRequests,
} from '@/modules/enrichment';
import { request } from '@/modules/enrichment/db/schema';
import { setConnectionSettings } from '@/modules/integrations';
import { connection } from '@/modules/integrations/db/schema';
import { sourceFeedback } from '@/modules/intake/db/schema';
import type { Principal } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog, schedule } from '@/platform/db/schema';
import { accountFrom, agentKey, as, enrichmentTenant, messagesFor, person, type Tenant } from './helpers';

let t: Tenant;
let owner: Principal;
let leader: Principal;
let seller: Principal;
let otherSeller: Principal;
let agentSourceId: string;
let looseAgentId: string;
let personSourceId: string;

afterAll(closeDbs);
beforeAll(async () => {
  const e = await enrichmentTenant();
  t = e.t;
  owner = e.owner;
  agentSourceId = e.agentId;
  looseAgentId = e.looseAgentId;
  personSourceId = e.personId;
  leader = await person(t, 'leader', 'Lee Leader');
  seller = await person(t, 'seller', 'Dana Ruiz');
  otherSeller = await person(t, 'seller', 'Other Seller');
});

const people = (roles: string[]) => ({ kind: 'people_for_roles' as const, providerKey: 'apollo', roles });
const firmo = { kind: 'company_firmographics' as const, providerKey: 'apollo' };
const create = (p: Principal, accountId: string, input: Parameters<typeof createRequest>[3]) => as(t, p, (ctx) => createRequest(ctx, p, accountId, input));
const rowOf = (id: string) => t.run(async (ctx) => (await ctx.tx.select().from(request).where(eq(request.id, id)))[0]!);
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; message: string; detail?: string; errors?: { path: string; message: string }[] };
  }
  throw new Error('expected a rejection');
};

describe('createRequest (Ruling 1)', () => {
  it('an owner creates it approved, queues the run and upserts the expiry schedule', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const { request: r, joined } = await create(owner, accountId, people(['technical_buyer']));
    expect(joined).toBe(false);
    expect(r).toMatchObject({
      accountId,
      kind: 'people_for_roles',
      kindLabel: 'People for buying roles',
      providerKey: 'apollo',
      providerName: 'Apollo',
      status: 'approved',
      statusText: 'Starting',
      requestedByLabel: 'Yasir Drabu',
      decidedByLabel: 'Yasir Drabu',
      estimate: { credits: 3, costCents: 30, text: 'Up to 3 credits, about $0.30 · Sample' },
      sample: true,
    });
    expect(r.decidedAt).toBeInstanceOf(Date);
    expect(await messagesFor(t, 'jobs.enrichment.request.run', r.id)).toHaveLength(1);
    const approved = await messagesFor(t, 'enrichment.request.approved', r.id);
    expect(approved.map((m) => m.data)).toEqual([
      { requestId: r.id, accountId, kind: 'people_for_roles', providerKey: 'apollo', decidedBy: owner.id, requestedByLabel: 'Yasir Drabu' },
    ]);
    expect(await messagesFor(t, 'enrichment.request.flagged', r.id)).toHaveLength(0);
    const row = await rowOf(r.id);
    expect(row.estimate).toEqual({ credits: 3, cost_cents: 30, sample: true });
    expect(row.params).toEqual({ roles: ['technical_buyer'] });
    const sch = await adminDb.select().from(schedule).where(and(eq(schedule.tenantId, t.tenantId), eq(schedule.jobName, 'enrichment.request.expire')));
    expect(sch).toHaveLength(1);
    expect(sch[0]).toMatchObject({ cron: '0 4 * * *', timezone: 'UTC' });

    // A second create finds the schedule: no second row, no new audit row.
    const audits = () => adminDb.select().from(auditLog).where(and(eq(auditLog.subjectId, sch[0]!.id), eq(auditLog.action, 'platform.schedule.upserted')));
    const auditsBefore = (await audits()).length;
    const other = await accountFrom(t, agentSourceId);
    await create(owner, other.accountId, firmo);
    const after = await adminDb.select().from(schedule).where(and(eq(schedule.tenantId, t.tenantId), eq(schedule.jobName, 'enrichment.request.expire')));
    expect(after.map((s) => s.id)).toEqual([sch[0]!.id]);
    expect(await audits()).toHaveLength(auditsBefore);
  });

  it('a seller needs a reason, then creates it flagged with no run', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const e = await reject(create(seller, accountId, firmo));
    expect(e.status).toBe(400);
    expect(e.message).toBe('Say why this is worth the spend.');
    expect(e.errors).toEqual([{ path: 'reason', message: 'Say why this is worth the spend.' }]);
    const { request: r } = await create(seller, accountId, { ...firmo, reason: 'Need their size' });
    expect(r).toMatchObject({ status: 'flagged', statusText: 'Waiting for approval', requestedByLabel: 'Dana Ruiz', reason: 'Need their size', decidedByLabel: null });
    expect(await messagesFor(t, 'jobs.enrichment.request.run', r.id)).toHaveLength(0);
    const flagged = await messagesFor(t, 'enrichment.request.flagged', r.id);
    expect(flagged[0]!.data).toMatchObject({ requestedBy: seller.id, requestedByLabel: 'Dana Ruiz', reason: 'Need their size', estimate: { credits: 1, costCents: 10 } });
  });

  it("an agent's key always creates it flagged, labelled with its owner", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const key = agentKey(t, agentSourceId, { permissions: ['enrichment:request', 'enrichment:approve'] });
    const { request: r } = await create(key, accountId, { ...firmo, reason: 'Missing size' });
    expect(r).toMatchObject({ status: 'flagged', requestedByLabel: "Yasir's agent" });
    const row = await rowOf(r.id);
    expect(row).toMatchObject({ requestedBy: `key:${key.id}`, requestingSourceId: agentSourceId });
    expect((await messagesFor(t, 'enrichment.request.flagged', r.id))[0]!.data).toMatchObject({ requestingSourceId: agentSourceId });
  });

  it('a key whose source has no owner is labelled with the source name', async () => {
    const { accountId } = await accountFrom(t, looseAgentId);
    const key = agentKey(t, looseAgentId);
    const { request: r } = await create(key, accountId, { ...firmo, reason: 'Missing size' });
    expect(r.requestedByLabel).toBe('Loose agent');
  });

  it("refuses an account the principal can't see, a role or person that doesn't belong, and a provider that can't do it", async () => {
    const { accountId, personIds } = await accountFrom(t, agentSourceId);
    const other = await accountFrom(t, looseAgentId);
    expect((await reject(create(agentKey(t, agentSourceId), other.accountId, { ...firmo, reason: 'x' }))).status).toBe(404);
    const role = await reject(create(owner, accountId, people(['technical_buyer', 'astronaut'])));
    expect(role).toMatchObject({ status: 400, message: '"astronaut" isn\'t a buying role.' });
    expect(await reject(create(owner, accountId, people([])))).toMatchObject({ status: 400, message: 'Pick at least one buying role.' });
    const stranger = await reject(create(owner, accountId, { kind: 'email_reveal', providerKey: 'apollo', personIds: [personIds[0]!, other.personIds[0]!] }));
    expect(stranger).toMatchObject({ status: 400, message: "That person isn't on this account." });
    // One arrival takes at most 25 people (review I2).
    const many = Array.from({ length: 26 }, (_, i) => `per_${i}`);
    expect(await reject(create(owner, accountId, { kind: 'email_reveal', providerKey: 'apollo', personIds: many }))).toMatchObject({ status: 400, message: 'Pick up to 25 people.' });
    expect(await reject(create(owner, accountId, { kind: 'website_read', providerKey: 'apollo' }))).toMatchObject({ status: 400, message: "Apollo can't do that." });
    expect(await reject(create(owner, accountId, { kind: 'nope' as never, providerKey: 'apollo' }))).toMatchObject({ status: 400 });
    const tooLong = await reject(create(seller, accountId, { ...firmo, reason: 'x'.repeat(501) }));
    expect(tooLong).toMatchObject({ status: 400 });
  });

  it('needs enrichment:request', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const viewer = { ...seller, permissions: [] };
    expect((await reject(create(viewer, accountId, { ...firmo, reason: 'x' }))).status).toBe(403);
  });
});

describe('duplicates (Ruling 6, Review Focus 3)', () => {
  it("a seller's flagged request is joined and approved by the owner: one request, the run queued once", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const first = await create(seller, accountId, { ...people(['champion']), reason: 'Need a champion' });
    const second = await create(owner, accountId, people(['technical_buyer']));
    expect(second.joined).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request).toMatchObject({ status: 'approved', requestedByLabel: 'Dana Ruiz', decidedByLabel: 'Yasir Drabu' });
    const rows = await t.run((ctx) => ctx.tx.select().from(request).where(eq(request.accountId, accountId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.watchers).toEqual([owner.id]);
    expect(await messagesFor(t, 'jobs.enrichment.request.run', first.request.id)).toHaveLength(1);
    expect(await messagesFor(t, 'enrichment.request.approved', first.request.id)).toHaveLength(1);
  });

  it("the owner's approved request is joined by the seller as a watcher, with no second run", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const first = await create(owner, accountId, people(['champion']));
    const second = await create(seller, accountId, people(['champion']));
    expect(second).toMatchObject({ joined: true, request: { id: first.request.id, status: 'approved' } });
    expect((await rowOf(first.request.id)).watchers).toEqual([seller.id]);
    expect(await messagesFor(t, 'jobs.enrichment.request.run', first.request.id)).toHaveLength(1);
    // Asking again adds no second watcher entry.
    await create(seller, accountId, people(['champion']));
    expect((await rowOf(first.request.id)).watchers).toEqual([seller.id]);
  });

  it('a seller joining a flagged request leaves it flagged; another kind is its own request', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const first = await create(seller, accountId, { ...firmo, reason: 'Size' });
    const joined = await create(otherSeller, accountId, firmo);
    expect(joined).toMatchObject({ joined: true, request: { id: first.request.id, status: 'flagged' } });
    const other = await create(seller, accountId, { kind: 'signals_refresh', providerKey: 'apollo', reason: 'News' });
    expect(other.joined).toBe(false);
    expect(other.request.id).not.toBe(first.request.id);
  });
});

describe('approve, decline, cancel (Ruling 7)', () => {
  it('only a person with enrichment:approve approves; a second approve is a 409', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const { request: r } = await create(seller, accountId, { ...firmo, reason: 'Size' });
    const key = agentKey(t, agentSourceId, { permissions: ['enrichment:request', 'enrichment:approve'] });
    const byKey = await reject(as(t, key, (ctx) => approveRequest(ctx, key, r.id)));
    expect(byKey).toMatchObject({ status: 403, detail: 'Only a person can approve spend.' });
    expect((await reject(as(t, seller, (ctx) => approveRequest(ctx, seller, r.id)))).status).toBe(403);
    const approved = await as(t, leader, (ctx) => approveRequest(ctx, leader, r.id));
    expect(approved).toMatchObject({ status: 'approved', decidedByLabel: 'Lee Leader' });
    expect(await messagesFor(t, 'jobs.enrichment.request.run', r.id)).toHaveLength(1);
    expect((await messagesFor(t, 'enrichment.request.approved', r.id))[0]!.data).toMatchObject({ decidedBy: leader.id, requestedByLabel: 'Dana Ruiz' });
    const again = await reject(as(t, owner, (ctx) => approveRequest(ctx, owner, r.id)));
    expect(again).toMatchObject({ status: 409, message: 'This request is already approved.' });
  });

  it('an unknown id is a 404', async () => {
    expect((await reject(as(t, owner, (ctx) => approveRequest(ctx, owner, 'enr_nope')))).status).toBe(404);
    expect(await t.run((ctx) => getRequest(ctx, 'enr_nope'))).toBeNull();
  });

  it("decline needs a reason and tells only the requesting source, not the rest of its chain", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const key = agentKey(t, agentSourceId);
    const { request: r } = await create(key, accountId, { ...firmo, reason: 'Size' });
    const noReason = await reject(as(t, owner, (ctx) => declineRequest(ctx, owner, r.id, '  ')));
    expect(noReason).toMatchObject({ status: 400, message: "Say why you're declining." });
    const declined = await as(t, owner, (ctx) => declineRequest(ctx, owner, r.id, 'We know their size'));
    expect(declined).toMatchObject({ status: 'declined', statusText: 'Declined: We know their size', declineReason: 'We know their size', decidedByLabel: 'Yasir Drabu' });
    const events = await messagesFor(t, 'enrichment.request.declined', r.id);
    expect(events.map((m) => m.data)).toEqual([{ requestId: r.id, accountId, decidedBy: owner.id, reason: 'We know their size' }]);
    const fb = await t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, accountId)));
    expect(fb.map((f) => [f.sourceId, f.kind, f.note, f.causeEventId])).toEqual([[agentSourceId, 'enrichment_declined', 'We know their size', events[0]!.id]]);
    expect(fb[0]!.arrivalId).not.toBeNull();
    expect(fb.some((f) => f.sourceId === personSourceId)).toBe(false);
    expect(await reject(as(t, owner, (ctx) => declineRequest(ctx, owner, r.id, 'again')))).toMatchObject({ status: 409, message: 'This request is already declined.' });
  });

  it("an agent's request for an account it sent nothing for still records the feedback, with no arrival", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const key = agentKey(t, looseAgentId, { dataLimit: { kind: 'all' } });
    const { request: r } = await create(key, accountId, { ...firmo, reason: 'Size' });
    await as(t, owner, (ctx) => declineRequest(ctx, owner, r.id, 'No'));
    const fb = await t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, accountId)));
    expect(fb.map((f) => [f.sourceId, f.arrivalId, f.kind])).toEqual([[looseAgentId, null, 'enrichment_declined']]);
  });

  it('the requester or an approver may cancel a flagged or approved request; no one else', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const { request: r } = await create(seller, accountId, { ...firmo, reason: 'Size' });
    expect((await reject(as(t, otherSeller, (ctx) => cancelRequest(ctx, otherSeller, r.id)))).status).toBe(403);
    const cancelled = await as(t, seller, (ctx) => cancelRequest(ctx, seller, r.id));
    expect(cancelled).toMatchObject({ status: 'cancelled', statusText: 'Cancelled' });
    expect((await messagesFor(t, 'enrichment.request.cancelled', r.id)).map((m) => m.data)).toEqual([{ requestId: r.id, accountId, reason: 'cancelled' }]);
    expect(await reject(as(t, seller, (ctx) => cancelRequest(ctx, seller, r.id)))).toMatchObject({ status: 409, message: 'This request is already cancelled.' });

    const { request: approved } = await create(owner, accountId, firmo);
    expect((await as(t, leader, (ctx) => cancelRequest(ctx, leader, approved.id))).status).toBe('cancelled');
  });
});

describe('listRequests and getRequest', () => {
  it('filters by status and account, pages by cursor, and keeps to data limits', async () => {
    // A tenant of its own, so the counts don't depend on the other tests' requests.
    const e = await enrichmentTenant();
    const sel = await person(e.t, 'seller', 'List Seller');
    const make = (accountId: string, input: Parameters<typeof createRequest>[3]) => as(e.t, sel, (ctx) => createRequest(ctx, sel, accountId, input));
    const mine = await accountFrom(e.t, e.agentId);
    const theirs = await accountFrom(e.t, e.looseAgentId);
    const a = await make(mine.accountId, { ...firmo, reason: 'a' });
    const b = await make(mine.accountId, { kind: 'signals_refresh', providerKey: 'apollo', reason: 'b' });
    const c = await make(theirs.accountId, { ...firmo, reason: 'c' });
    await as(e.t, e.owner, (ctx) => approveRequest(ctx, e.owner, b.request.id));

    const byAccount = await e.t.run((ctx) => listRequests(ctx, { accountId: mine.accountId }));
    expect(byAccount.data.map((r) => r.id)).toEqual([b.request.id, a.request.id]);
    expect(byAccount.data[0]).toMatchObject({ accountName: expect.stringMatching(/^Enrich /), kindLabel: 'Fresh signals' });
    expect((await e.t.run((ctx) => listRequests(ctx, { status: 'flagged' }))).data.map((r) => r.id)).toEqual([c.request.id, a.request.id]);

    const page1 = await e.t.run((ctx) => listRequests(ctx, { limit: 1 }));
    expect(page1.data.map((r) => r.id)).toEqual([c.request.id]);
    const page2 = await e.t.run((ctx) => listRequests(ctx, { limit: 1, cursor: page1.nextCursor! }));
    expect(page2.data.map((r) => r.id)).toEqual([b.request.id]);
    const page3 = await e.t.run((ctx) => listRequests(ctx, { limit: 1, cursor: page2.nextCursor! }));
    expect(page3).toMatchObject({ data: [{ id: a.request.id }], nextCursor: null });

    const key = agentKey(e.t, e.agentId);
    const seen = await as(e.t, key, (ctx) => listRequests(ctx, {}));
    expect(seen).toMatchObject({ data: [{ id: b.request.id }, { id: a.request.id }], nextCursor: null });
    // Its first page skips the request it can't see and is still full.
    expect((await as(e.t, key, (ctx) => listRequests(ctx, { limit: 1 }))).data.map((r) => r.id)).toEqual([b.request.id]);
    expect(await as(e.t, key, (ctx) => getRequest(ctx, c.request.id))).toBeNull();
    expect(await as(e.t, key, (ctx) => listRequests(ctx, { accountId: theirs.accountId }))).toEqual({ data: [], nextCursor: null });
    expect((await e.t.run((ctx) => getRequest(ctx, c.request.id)))!.id).toBe(c.request.id);
  });

  it('an unknown or malformed cursor is a 400', async () => {
    for (const cursor of ['enr_NOPE', 'not a cursor']) {
      const e = await reject(t.run((ctx) => listRequests(ctx, { cursor })));
      expect(e).toMatchObject({ status: 400, message: 'That page link is out of date. Start from the first page.' });
    }
  });
});

describe('estimateFor (Ruling 5)', () => {
  it("uses the connection's cents_per_credit, and is a sample on mock", async () => {
    const e = await enrichmentTenant();
    const { accountId } = await accountFrom(e.t, e.agentId);
    const run = <T>(fn: Parameters<typeof e.t.run<T>>[0]) => as(e.t, e.owner, fn);
    expect(await run((ctx) => estimateFor(ctx, accountId, people(['champion', 'technical_buyer'])))).toEqual({
      credits: 6,
      costCents: 60,
      currency: 'USD',
      sample: true,
      text: 'Up to 6 credits, about $0.60 · Sample',
    });
    await run((ctx) => setConnectionSettings(ctx, 'apollo', { cents_per_credit: 25 }));
    expect(await run((ctx) => estimateFor(ctx, accountId, people(['champion', 'technical_buyer'])))).toMatchObject({ credits: 6, costCents: 150 });
    await e.t.run((ctx) => ctx.tx.update(connection).set({ mode: 'live' }).where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.provider, 'apollo'))));
    expect(await run((ctx) => estimateFor(ctx, accountId, firmo))).toEqual({ credits: 1, costCents: 25, currency: 'USD', sample: false, text: 'Up to 1 credit, about $0.25' });
  });

  it("a website read is free but for Claude's worst case", async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    expect(await as(t, owner, (ctx) => estimateFor(ctx, accountId, { kind: 'website_read', providerKey: 'website' }))).toEqual({
      credits: 0,
      costCents: 5,
      currency: 'USD',
      sample: true,
      text: 'Free. Claude usage up to $0.05 · Sample',
    });
  });

  it("is a 404 for an account the principal can't see", async () => {
    const other = await accountFrom(t, looseAgentId);
    const key = agentKey(t, agentSourceId);
    expect((await reject(as(t, key, (ctx) => estimateFor(ctx, other.accountId, firmo)))).status).toBe(404);
  });
});
