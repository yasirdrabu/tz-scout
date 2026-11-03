// The run job (Rulings 8 and 9): approved requests carried out against the sample adapters, driven with runOutbox.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount, getFacts, listConflicts, listPeople } from '@/modules/accounts';
import {
  cancelRequest,
  createRequest,
  getRequest,
  registerApolloAdapter,
  runRequestJob,
  setMockFailure,
  type EnrichmentAdapter,
  type RequestInput,
} from '@/modules/enrichment';
import { apolloMock } from '@/modules/enrichment/adapters/apollo/mock';
import { request } from '@/modules/enrichment/db/schema';
import { listCaps, registerAdapter, setCapLimit } from '@/modules/integrations';
import { callLog, connection, usageCap } from '@/modules/integrations/db/schema';
import { ensureVendorSource, submitArrival } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import type { Principal } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { enqueueJob } from '@/platform/events/outbox';
import { runOutbox } from '../helpers/run-outbox';
import { accountFrom, as, enrichmentTenant, messagesFor, type Tenant } from './helpers';

let t: Tenant;
let owner: Principal;
let agentSourceId: string;
let apolloSourceId: string;

afterAll(closeDbs);
beforeAll(async () => {
  const e = await enrichmentTenant();
  t = e.t;
  owner = e.owner;
  agentSourceId = e.agentId;
  apolloSourceId = await t.run((ctx) => ensureVendorSource(ctx, 'apollo', 'Apollo'));
});
afterEach(() => {
  setMockFailure(null);
  registerApolloAdapter();
});

const technical: RequestInput = { kind: 'people_for_roles', providerKey: 'apollo', roles: ['technical_buyer'] };

/** An owner's request: created approved, with its run job queued. */
const approved = async (tenant: Tenant, by: Principal, accountId: string, input: RequestInput) =>
  (await as(tenant, by, (ctx) => createRequest(ctx, by, accountId, input))).request.id;
const rowOf = (tenant: Tenant, id: string) => tenant.run(async (ctx) => (await ctx.tx.select().from(request).where(eq(request.id, id)))[0]!);
const viewOf = (tenant: Tenant, id: string) => tenant.run((ctx) => getRequest(ctx, id));
const apolloUsed = async (tenant: Tenant) => (await tenant.run((ctx) => listCaps(ctx))).find((c) => c.providerKey === 'apollo')?.used ?? 0;
const arrivalsOf = (tenant: Tenant, requestId: string) =>
  adminDb.select().from(arrival).where(and(eq(arrival.tenantId, tenant.tenantId), eq(arrival.externalRef, requestId)));
type Result = { arrival_ids: string[]; credits_used: number; cost_cents: number; found: number; message?: string; read_by?: string };
const resultOf = async (tenant: Tenant, id: string) => (await rowOf(tenant, id)).result as Result;

/** The sample Apollo, except that its free search finds these three people. */
function threeFound(over: Partial<EnrichmentAdapter> = {}): void {
  const mock = apolloMock();
  const people = ['Avery Abbott', 'Blake Banks', 'Casey Carver'].map((name, i) => ({ name, title: 'CTO', seniority: 'c_suite', provider_ref: `stub-${i}` }));
  registerAdapter('apollo', { mock: () => ({ ...mock, peopleSearch: async () => ({ value: people, creditsUsed: 0 }), ...over }) });
}

describe('people for buying roles (ENR-E3-S1-AC1)', () => {
  it('adds people from Apollo with their email status; credits used is the apollo limit’s increase', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const before = await apolloUsed(t);
    const peopleBefore = (await t.run((ctx) => listPeople(ctx, accountId))).length;
    const id = await approved(t, owner, accountId, technical);
    await runOutbox(t.tenantId);

    const row = await rowOf(t, id);
    expect(row).toMatchObject({ status: 'completed', waitingReason: null, connectionMode: 'mock', error: null });
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
    const result = row.result as Result;
    const people = await t.run((ctx) => listPeople(ctx, accountId));
    const added = people.slice(peopleBefore);
    expect(added.length).toBeGreaterThan(0);
    expect(result.found).toBe(added.length);
    expect(result.credits_used).toBe((await apolloUsed(t)) - before);
    expect(result.credits_used).toBe(added.length);
    expect(result.cost_cents).toBe(0);
    for (const p of added) {
      expect(p.emailStatus).toBe('verified');
      expect(p.email).toMatch(/@/);
      expect(p.roles.map((r) => r.key)).toContain('technical_buyer');
    }
    // The Apollo source: the facts carry the vendor in their chain.
    const facts = await t.run((ctx) => getFacts(ctx, accountId));
    const emailFact = facts.find((f) => f.personId === added[0]!.id && f.key === 'email_status')!;
    expect(emailFact.sourceChain).toEqual({ vendorSourceId: apolloSourceId });

    // One arrival, from Apollo, keyed by the request and noting the requester.
    const [a, ...more] = await arrivalsOf(t, id);
    expect(more).toHaveLength(0);
    expect(result.arrival_ids).toEqual([a!.id]);
    expect(a).toMatchObject({ closestSourceId: apolloSourceId, channel: 'enrichment', targetAccountId: accountId });
    const body = (a!.payload as { raw: { account: { notes: string }; people: Record<string, unknown>[] } }).raw;
    expect(body.account.notes).toBe('Requested by Yasir Drabu');
    for (const p of body.people) expect(p).not.toHaveProperty('provider_ref');

    const completed = await messagesFor(t, 'enrichment.request.completed', id);
    expect(completed.map((m) => m.data)).toEqual([
      {
        requestId: id,
        accountId,
        kind: 'people_for_roles',
        providerKey: 'apollo',
        arrivalIds: [a!.id],
        found: added.length,
        creditsUsed: added.length,
        costCents: 0,
        currency: 'USD',
        requestedBy: owner.id,
      },
    ]);
    expect((await viewOf(t, id))!.statusText).toBe(`Found ${added.length}`);
  });

  it('says who it found no one for when the search is empty', async () => {
    registerAdapter('apollo', { mock: () => ({ ...apolloMock(), peopleSearch: async () => ({ value: [], creditsUsed: 0 }) }) });
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await runOutbox(t.tenantId);
    expect(await resultOf(t, id)).toEqual({ arrival_ids: [], credits_used: 0, cost_cents: 0, found: 0, message: 'Apollo found no one for Technical buyer' });
    expect((await viewOf(t, id))!.statusText).toBe('Apollo found no one for Technical buyer');
  });

  it('out of credits after 2 people keeps them and is partial', async () => {
    threeFound();
    setMockFailure('out_of_credits', 2);
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await runOutbox(t.tenantId);
    const row = await rowOf(t, id);
    expect(row.status).toBe('partial');
    expect(row.result).toMatchObject({ found: 2, credits_used: 2, message: 'Apollo is out of credits.' });
    const names = (await t.run((ctx) => listPeople(ctx, accountId))).map((p) => `${p.firstName} ${p.lastName}`);
    expect(names).toEqual(expect.arrayContaining(['Avery Abbott', 'Blake Banks']));
    expect(names).not.toContain('Casey Carver');
    expect((await viewOf(t, id))!.statusText).toBe('Found 2. Apollo is out of credits.');
    expect(await messagesFor(t, 'enrichment.request.completed', id)).toHaveLength(1);
  });
});

describe('the other kinds', () => {
  it('firmographics that disagree with an existing fact open a conflict (ENR-E4-S1-AC2)', async () => {
    const d = `firmo-${Date.now()}.example.com`;
    const sent = await t.run((ctx) =>
      submitArrival(
        { ...ctx, access: { sourceId: agentSourceId, dataLimit: { kind: 'all' } } },
        { account: { name: 'Firmo Co', domain: d, employees: 5 } },
        { channel: 'api' },
      ),
    );
    await runOutbox(t.tenantId);
    const accountId = (await adminDb.select().from(arrival).where(eq(arrival.id, sent.arrivalId)))[0]!.accountId!;
    const id = await approved(t, owner, accountId, { kind: 'company_firmographics', providerKey: 'apollo' });
    await runOutbox(t.tenantId);
    const row = await rowOf(t, id);
    expect(row.status).toBe('completed');
    expect((row.result as Result).credits_used).toBe(1);
    expect((row.result as Result).found).toBeGreaterThan(0);
    const conflicts = await as(t, owner, (ctx) => listConflicts(ctx, accountId));
    expect(conflicts.some((c) => c.key === 'employees' && c.status === 'open')).toBe(true);
    // A field the account had no value for is filled.
    expect((await t.run((ctx) => getAccount(ctx, accountId)))!.industry).toBeTruthy();
  });

  it('email reveal adds the email to the same person, not a new one', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const before = await t.run((ctx) => listPeople(ctx, accountId));
    const sam = before.find((p) => p.firstName === 'Sam')!;
    expect(sam.email).toBeNull();
    const id = await approved(t, owner, accountId, { kind: 'email_reveal', providerKey: 'apollo', personIds: [sam.id] });
    await runOutbox(t.tenantId);
    expect(await resultOf(t, id)).toMatchObject({ found: 1, credits_used: 1 });
    const after = await t.run((ctx) => listPeople(ctx, accountId));
    expect(after).toHaveLength(before.length);
    expect(after.find((p) => p.id === sam.id)).toMatchObject({ email: expect.stringMatching(/^sam\.roe@/), emailStatus: 'verified' });
  });

  it('a signals refresh looks the company up once: 3 credits', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, { kind: 'signals_refresh', providerKey: 'apollo' });
    await runOutbox(t.tenantId);
    const row = await rowOf(t, id);
    expect(row.status).toBe('completed');
    expect((row.result as Result).credits_used).toBe(3);
    expect((row.result as Result).found).toBeGreaterThan(0); // the sample company always has at least one job posting
  });

  it('a website read on mock adds a description with its page and reads "Read by rules"', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const domain = (await t.run((ctx) => getAccount(ctx, accountId)))!.domain!;
    const id = await approved(t, owner, accountId, { kind: 'website_read', providerKey: 'website' });
    await runOutbox(t.tenantId);
    const row = await rowOf(t, id);
    expect(row.status).toBe('completed');
    expect(row.result).toMatchObject({ credits_used: 0, read_by: 'rules', message: 'Read by rules' });
    const [description] = await t.run((ctx) => getFacts(ctx, accountId, { key: 'description' }));
    expect(description).toMatchObject({ url: `https://${domain}/`, value: expect.stringContaining('runs back-office operations') });
  });

  it('a cancelled request’s job does nothing', async () => {
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await as(t, owner, (ctx) => cancelRequest(ctx, owner, id));
    await runOutbox(t.tenantId);
    expect((await rowOf(t, id)).status).toBe('cancelled');
    expect(await arrivalsOf(t, id)).toHaveLength(0);
  });
});

describe('errors (Ruling 9)', () => {
  it('auth fails at once, marks the connection failing and publishes failed', async () => {
    setMockFailure('401');
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await runOutbox(t.tenantId);
    const message = 'Apollo rejected the key. An owner needs to update it in Integrations.';
    const row = await rowOf(t, id);
    expect(row).toMatchObject({ status: 'failed', error: { kind: 'auth', message } });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect((await viewOf(t, id))!.statusText).toBe(message);
    const [conn] = await adminDb.select().from(connection).where(and(eq(connection.tenantId, t.tenantId), eq(connection.provider, 'apollo')));
    expect(conn).toMatchObject({ status: 'failing', lastError: message });
    const failed = await messagesFor(t, 'enrichment.request.failed', id);
    expect(failed.map((m) => m.data)).toEqual([
      { requestId: id, accountId, providerKey: 'apollo', errorKind: 'auth', message, creditsUsed: 0, costCents: 0 },
    ]);
    await adminDb.update(connection).set({ status: 'not_set_up', lastError: null }).where(eq(connection.id, conn!.id));
  });

  it('bad_request fails with the provider’s message and no retry', async () => {
    setMockFailure('403');
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await runOutbox(t.tenantId);
    expect(await rowOf(t, id)).toMatchObject({ status: 'failed', error: { kind: 'bad_request', message: "Apollo says this key can't use that (sample data)." } });
    expect(await messagesFor(t, 'enrichment.request.failed', id)).toHaveLength(1);
  });

  it('rate_limited is retried, and the retry completes', async () => {
    setMockFailure('429');
    const { accountId } = await accountFrom(t, agentSourceId);
    const id = await approved(t, owner, accountId, technical);
    await expect(runOutbox(t.tenantId)).rejects.toMatchObject({ name: 'RateLimitedError' });
    expect(await rowOf(t, id)).toMatchObject({ status: 'running', error: { kind: 'rate_limited' } });
    setMockFailure(null);
    await runOutbox(t.tenantId);
    expect(await rowOf(t, id)).toMatchObject({ status: 'completed', error: null });
  });
});

describe('usage limits and redelivery', () => {
  let t2: Tenant;
  let owner2: Principal;
  let agent2: string;
  beforeAll(async () => {
    const e = await enrichmentTenant();
    t2 = e.t;
    owner2 = e.owner;
    agent2 = e.agentId;
  });

  it('an estimate over the limit makes no call, waits with a reason, and runs once the limit is raised (ENR-E3-S2-AC1)', async () => {
    await t2.run((ctx) => setCapLimit(ctx, 'apollo', 2));
    const { accountId } = await accountFrom(t2, agent2);
    const id = await approved(t2, owner2, accountId, technical);
    await expect(runOutbox(t2.tenantId)).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    const row = await rowOf(t2, id);
    // Written in its own transaction, so it survives the job's rollback.
    expect(row).toMatchObject({ status: 'approved', waitingReason: 'Waiting for budget: Apollo monthly limit reached' });
    expect((await viewOf(t2, id))!.statusText).toBe('Waiting for budget: Apollo monthly limit reached');
    const calls = await adminDb.select().from(callLog).where(and(eq(callLog.tenantId, t2.tenantId), eq(callLog.provider, 'apollo')));
    expect(calls).toHaveLength(0);

    await t2.run((ctx) => setCapLimit(ctx, 'apollo', 100));
    await runOutbox(t2.tenantId);
    expect(await rowOf(t2, id)).toMatchObject({ status: 'completed', waitingReason: null });
  });

  it('a limit hit after some people keeps them as one arrival, is partial, and a redelivery adds nothing (Review Focus 1)', async () => {
    const mock = apolloMock();
    let reveals = 0;
    threeFound({
      revealEmail: async (input) => {
        const r = await mock.revealEmail(input);
        // Another request spends the rest of the limit while this one runs.
        if (++reveals === 1) await adminDb.update(usageCap).set({ limit: 1 }).where(and(eq(usageCap.tenantId, t2.tenantId), eq(usageCap.providerKey, 'apollo')));
        return r;
      },
    });
    await t2.run((ctx) => setCapLimit(ctx, 'apollo', 1000));
    const { accountId } = await accountFrom(t2, agent2);
    const id = await approved(t2, owner2, accountId, technical);
    await runOutbox(t2.tenantId);
    const row = await rowOf(t2, id);
    expect(row.status).toBe('partial');
    expect(row.result).toMatchObject({ found: 1, credits_used: 1, message: 'Stopped at the Apollo monthly limit.' });
    expect((await viewOf(t2, id))!.statusText).toBe('Found 1. Stopped at the Apollo monthly limit.');
    expect(await arrivalsOf(t2, id)).toHaveLength(1);

    await t2.run((ctx) => enqueueJob(ctx, runRequestJob, { requestId: id }));
    await runOutbox(t2.tenantId);
    expect(await arrivalsOf(t2, id)).toHaveLength(1);
    expect((await rowOf(t2, id)).status).toBe('partial');
    expect(await messagesFor(t2, 'enrichment.request.completed', id)).toHaveLength(1);
    await t2.run((ctx) => setCapLimit(ctx, 'apollo', 1000));
  });

  it('a redelivery after the arrival was submitted adds no second arrival and completes once (Review Focus 2)', async () => {
    const { accountId } = await accountFrom(t2, agent2);
    const id = await approved(t2, owner2, accountId, technical);
    // The first delivery got as far as submitting its arrival, then the worker crashed before finishing.
    const apollo = await t2.run((ctx) => ensureVendorSource(ctx, 'apollo', 'Apollo'));
    await adminDb.update(request).set({ status: 'running', startedAt: new Date() }).where(eq(request.id, id));
    const earlier = await t2.run((ctx) =>
      submitArrival(
        { ...ctx, actor: { kind: 'system', id: 'enrichment' }, access: { sourceId: apollo, dataLimit: { kind: 'all' } } },
        { target_account_id: accountId, account: { external_ref: id }, people: [{ name: 'Earlier Person', title: 'CTO' }] },
        { channel: 'enrichment', inline: true },
      ),
    );
    await runOutbox(t2.tenantId);
    const arrivals = await arrivalsOf(t2, id);
    expect(arrivals.map((a) => a.id)).toEqual([earlier.arrivalId]);
    const row = await rowOf(t2, id);
    expect(row.status).toBe('completed');
    expect((row.result as Result).arrival_ids).toEqual([earlier.arrivalId]);

    await t2.run((ctx) => enqueueJob(ctx, runRequestJob, { requestId: id }));
    await runOutbox(t2.tenantId);
    expect(await arrivalsOf(t2, id)).toHaveLength(1);
    expect(await messagesFor(t2, 'enrichment.request.completed', id)).toHaveLength(1);
  });
});
