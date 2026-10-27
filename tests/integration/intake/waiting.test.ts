import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import {
  chooseDuplicate,
  getArrival,
  listWaiting,
  skipWaiting,
  submitArrival,
  submitBatch,
  supplyCompany,
  supplyWebsite,
  waitingExpireHandler,
} from '@/modules/intake';
import { arrival, batch } from '@/modules/intake/db/schema';
import type { Access } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { EnvelopeSchema } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let personId: string;
let agentId: string;
let zedAgentId: string;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ({ personId, agentId } = await personAndAgent(t));
  ({ agentId: zedAgentId } = await personAndAgent(t, 'Zed'));
});

let n = 0;
const uniqueDomain = () => `w${Date.now().toString(36)}${++n}.com`;
const asAgent = <T>(fn: Parameters<typeof asSource<T>>[2]) => asSource(t, agentId, fn);
const rowOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, id))))[0]!;
const batchOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(batch).where(eq(batch.id, id))))[0]!;
const sendFile = (body: unknown) => asAgent((ctx) => submitArrival(ctx, body, { channel: 'file' }));
const sendBatch = (items: unknown[]) => asAgent((ctx) => submitBatch(ctx, { name: `Run ${++n}`, items }, { channel: 'webhook' }));

async function events(type: string, key: string, value: string) {
  const rows = (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>${key} = ${value} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];
  return rows.map((r) => r.payload.data);
}
const audits = async (action: string, subjectId: string) =>
  (await adminDb.execute(
    sql`select action, after from platform.audit_log where tenant_id = ${t.tenantId} and action = ${action} and subject_id = ${subjectId}`,
  )) as unknown as { action: string; after: Record<string, unknown> }[];
const ageWaiting = (id: string, days: number) =>
  t.run((ctx) => ctx.tx.update(arrival).set({ waitingSince: new Date(Date.now() - days * 86_400_000) }).where(eq(arrival.id, id)));

/** Runs the daily expiry job the way the worker would. */
const runExpiry = () =>
  deliverOnce(
    waitingExpireHandler,
    EnvelopeSchema.parse({
      id: newId('evt'),
      type: 'jobs.intake.waiting.expire',
      schemaVersion: 1,
      tenantId: t.tenantId,
      occurredAt: new Date().toISOString(),
      actor: { kind: 'system', id: 'scheduler' },
      correlationId: newId('cor'),
      data: {},
    }),
  );

/** An existing Florida account, and the body of an arrival that is a possible duplicate of it. */
async function possibleDuplicate(label: string, chain: { personSourceId?: string; agentSourceId?: string } = { personSourceId: personId, agentSourceId: agentId }) {
  const suffix = `${label}${++n}x${Date.now().toString(36)}`;
  const existing = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId: newId('arr'),
      receivedAt: new Date(),
      sourceChain: chain,
      account: { name: `${suffix} Harborview Capital Partners`, hqCountry: 'US', hqState: 'FL', hqCity: 'Tampa' },
      people: [],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  const body = { account: { name: `${suffix} Harborview Capital Partner`, domain: uniqueDomain(), country: 'US', region: 'FL', city: 'Orlando' } };
  return { existing: existing.accountId, body };
}

describe('supplying what is missing (SRC-E3-S3-AC1, AC2)', () => {
  it('lists the waiting item, then a supplied website resumes it and completes its batch', async () => {
    const out = await sendBatch([{ account: { name: 'Needs A Site' } }]);
    await runOutbox(t.tenantId);
    const id = out.items[0]!.arrivalId;
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'processing' });
    expect((await t.run((ctx) => listWaiting(ctx, { reason: 'needs_website' }))).data.map((a) => a.id)).toContain(id);
    expect((await t.run((ctx) => listWaiting(ctx, { reason: 'needs_company' }))).data.map((a) => a.id)).not.toContain(id);

    await t.run((ctx) => supplyWebsite(ctx, id, `https://${uniqueDomain()}`));
    expect(await audits('intake.arrival.supply_website', id)).toHaveLength(1);
    await runOutbox(t.tenantId);

    expect(await rowOf(id)).toMatchObject({ status: 'resolved', waitingOn: null, resolution: 'created' });
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'completed', counts: { resolved: 1, newAccounts: 1 } });
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toHaveLength(1);
    expect((await t.run((ctx) => listWaiting(ctx))).data.map((a) => a.id)).not.toContain(id);
  });

  it('refuses a website that is not one, an arrival waiting for something else, and a missing arrival', async () => {
    const out = await sendFile({ account: { name: 'Bad Site Co' } });
    await runOutbox(t.tenantId);
    await expect(t.run((ctx) => supplyWebsite(ctx, out.arrivalId, 'not a site'))).rejects.toMatchObject({ status: 400 });
    await expect(t.run((ctx) => chooseDuplicate(ctx, out.arrivalId, { kind: 'new_company' }))).rejects.toMatchObject({ status: 409 });
    await expect(t.run((ctx) => supplyWebsite(ctx, 'arr_missing', 'acme.com'))).rejects.toMatchObject({ status: 404 });
  });

  it('lets a company name without a website wait again as needs_website, publishing it, then resolves with the website', async () => {
    const out = await sendFile({ people: [{ name: 'Pat Personal', email: 'pat.personal@gmail.com' }] });
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ waitingOn: 'needs_company' });

    await t.run((ctx) => supplyCompany(ctx, out.arrivalId, { name: 'Pat Studio' }));
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ status: 'resolving', waitingOn: 'needs_website' });
    expect((await events('intake.arrival.waiting', 'arrivalId', out.arrivalId)).map((e) => e.waitingOn)).toEqual(['needs_company', 'needs_website']);

    await t.run((ctx) => supplyWebsite(ctx, out.arrivalId, uniqueDomain()));
    await runOutbox(t.tenantId);
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'resolved', resolution: 'created' });
    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, row.accountId!)));
    expect(acc!.name).toBe('Pat Studio');
  });

  it('makes a shell account for a sole proprietor, given the person name the arrival lacked', async () => {
    const out = await sendFile({ people: [{ email: 'no.name.here@gmail.com' }] });
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ waitingOn: 'needs_company' });

    await t.run((ctx) => supplyCompany(ctx, out.arrivalId, { soleProprietor: true, personName: 'Nora Nameless' }));
    expect(await audits('intake.arrival.supply_company', out.arrivalId)).toHaveLength(1);
    await runOutbox(t.tenantId);
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'resolved', resolution: 'created' });
    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, row.accountId!)));
    expect(acc).toMatchObject({ domain: null });
    const people = (await t.run((ctx) =>
      ctx.tx.execute(sql`select first_name, last_name from accounts.person where account_id = ${row.accountId}`),
    )) as unknown as { first_name: string; last_name: string }[];
    expect(people).toEqual([{ first_name: 'Nora', last_name: 'Nameless' }]);
  });
});

describe('possible duplicates (SRC-E3-S2-AC4)', () => {
  it('attaches to the chosen account for same_as, and audits it', async () => {
    const { existing, body } = await possibleDuplicate('SameAs');
    const { arrivalId: id } = await sendFile(body);
    await runOutbox(t.tenantId);
    expect(await rowOf(id)).toMatchObject({ waitingOn: 'possible_duplicate' });

    await t.run((ctx) => chooseDuplicate(ctx, id, { kind: 'same_as', accountId: existing }));
    await runOutbox(t.tenantId);
    expect(await rowOf(id)).toMatchObject({ status: 'resolved', resolution: 'attached', accountId: existing });
    const [entry] = await audits('intake.arrival.choose_duplicate', id);
    expect(entry!.after).toEqual({ duplicate: { kind: 'same_as', accountId: existing } });
  });

  it('creates a new account for new_company, and audits it', async () => {
    const { existing, body } = await possibleDuplicate('NewCo');
    const { arrivalId: id } = await sendFile(body);
    await runOutbox(t.tenantId);

    await t.run((ctx) => chooseDuplicate(ctx, id, { kind: 'new_company' }));
    await runOutbox(t.tenantId);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'resolved', resolution: 'created' });
    expect(row.accountId).not.toBe(existing);
    expect(await audits('intake.arrival.choose_duplicate', id)).toHaveLength(1);
  });

  it('refuses an account that was not one of the candidates, leaving the arrival waiting', async () => {
    const { body } = await possibleDuplicate('NotCand');
    const { arrivalId: id } = await sendFile(body);
    await runOutbox(t.tenantId);
    await expect(t.run((ctx) => chooseDuplicate(ctx, id, { kind: 'same_as', accountId: 'acc_other' }))).rejects.toMatchObject({ status: 400 });
    expect(await rowOf(id)).toMatchObject({ status: 'resolving', waitingOn: 'possible_duplicate' });
  });
});

describe('expiry after 30 days (SRC-E3-S3-AC3)', () => {
  it('rejects each reason with its copy, counts them in the batch, and completes it once', async () => {
    const { body } = await possibleDuplicate('Expiry');
    const out = await sendBatch([
      { account: { name: 'Expiring No Site' } },
      { people: [{ name: 'Gina Gmail', email: 'gina.expiring@gmail.com' }] },
      body,
      { account: { name: 'Fresh No Site' } },
    ]);
    await runOutbox(t.tenantId);
    const [site, company, dup, fresh] = out.items.map((i) => i.arrivalId) as [string, string, string, string];
    expect(await rowOf(site)).toMatchObject({ waitingOn: 'needs_website' });
    expect(await rowOf(company)).toMatchObject({ waitingOn: 'needs_company' });
    expect(await rowOf(dup)).toMatchObject({ waitingOn: 'possible_duplicate' });

    for (const id of [site, company, dup]) await ageWaiting(id, 31);
    await ageWaiting(fresh, 29);
    await runExpiry();

    expect(await rowOf(site)).toMatchObject({
      status: 'rejected',
      rejectReason: 'invalid',
      rejectDetail: 'Nobody supplied the missing website within 30 days',
      waitingOn: null,
    });
    expect(await rowOf(company)).toMatchObject({ status: 'rejected', rejectDetail: 'Nobody supplied the company within 30 days' });
    expect(await rowOf(dup)).toMatchObject({ status: 'rejected', rejectDetail: 'Nobody decided whether this was a duplicate within 30 days' });
    expect(await rowOf(fresh)).toMatchObject({ status: 'resolving', waitingOn: 'needs_website' });
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'processing', counts: { rejected: 3 } });
    expect(await events('intake.arrival.rejected', 'arrivalId', site)).toHaveLength(1);

    await ageWaiting(fresh, 31);
    await runExpiry();
    await runExpiry(); // a second run finds nothing more to reject
    expect(await events('intake.arrival.rejected', 'arrivalId', fresh)).toHaveLength(1);
    expect(await events('intake.arrival.rejected', 'arrivalId', site)).toHaveLength(1);
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'completed', counts: { rejected: 4 } });
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toHaveLength(1);
  });
});

describe('skipWaiting', () => {
  it('rejects every waiting item of the batch invalid, naming who skipped, and completes it', async () => {
    const out = await sendBatch([
      { account: { name: 'Skip One' } },
      { account: { name: 'Skip Two' } },
      { account: { name: 'Resolves', domain: uniqueDomain() } },
    ]);
    await runOutbox(t.tenantId);
    expect(await t.run((ctx) => skipWaiting(ctx, out.batchId, 'Ash'))).toBe(2);
    for (const i of out.items.slice(0, 2)) {
      expect(await rowOf(i.arrivalId)).toMatchObject({ status: 'rejected', rejectReason: 'invalid', rejectDetail: 'Skipped by Ash.' });
      expect(await audits('intake.arrival.skip', i.arrivalId)).toHaveLength(1);
    }
    expect(await rowOf(out.items[2]!.arrivalId)).toMatchObject({ status: 'resolved' });
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'completed', counts: { resolved: 1, rejected: 2 } });
  });
});

const limited = <T>(access: Access, fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access }));

describe('waiting actions under data limits', () => {
  it('answer 404 for an arrival the principal cannot see, and skip nothing', async () => {
    const out = await sendBatch([{ account: { name: 'Hidden Wait' } }]);
    await runOutbox(t.tenantId);
    const id = out.items[0]!.arrivalId;
    for (const access of [
      { sourceId: zedAgentId, dataLimit: { kind: 'own_source' } },
      { dataLimit: { kind: 'sources', ids: [zedAgentId] } },
    ] satisfies Access[]) {
      await expect(limited(access, (ctx) => supplyWebsite(ctx, id, 'acme.com'))).rejects.toMatchObject({ status: 404 });
      await expect(limited(access, (ctx) => supplyCompany(ctx, id, { name: 'Nope' }))).rejects.toMatchObject({ status: 404 });
      await expect(limited(access, (ctx) => chooseDuplicate(ctx, id, { kind: 'new_company' }))).rejects.toMatchObject({ status: 404 });
      expect(await limited(access, (ctx) => skipWaiting(ctx, out.batchId, 'Zed'))).toBe(0);
      expect((await limited(access, (ctx) => listWaiting(ctx, { limit: 200 }))).data.map((a) => a.id)).not.toContain(id);
    }
    expect(await rowOf(id)).toMatchObject({ status: 'resolving', waitingOn: 'needs_website', resolutionInput: null });
  });

  it('keeps hidden candidate accounts out of reads and refuses to attach to one', async () => {
    const { existing, body } = await possibleDuplicate('Hidden', { agentSourceId: 'src_elsewhere' });
    const { arrivalId: id } = await sendFile(body);
    await runOutbox(t.tenantId);
    const access: Access = { dataLimit: { kind: 'sources', ids: [agentId] } };

    expect((await t.run((ctx) => getArrival(ctx, id)))!.duplicateCandidates).toHaveLength(1);
    expect((await limited(access, (ctx) => getArrival(ctx, id)))!.duplicateCandidates).toEqual([]);
    const listed = (await limited(access, (ctx) => listWaiting(ctx, { limit: 200 }))).data.find((a) => a.id === id);
    expect(listed!.duplicateCandidates).toEqual([]);
    await expect(limited(access, (ctx) => chooseDuplicate(ctx, id, { kind: 'same_as', accountId: existing }))).rejects.toMatchObject({
      status: 404,
      message: 'That account was not found.',
    });
    expect(await rowOf(id)).toMatchObject({ resolutionInput: null });
  });
});

describe('concurrent answers', () => {
  it('keeps both of two answers given at the same time', async () => {
    const { arrivalId: id } = await sendFile({ people: [{ name: 'Cy Current', email: 'cy.current@gmail.com' }] });
    await runOutbox(t.tenantId);
    await Promise.all([
      t.run((ctx) => supplyCompany(ctx, id, { name: 'Cy Studio' })),
      t.run((ctx) => supplyWebsite(ctx, id, uniqueDomain())),
    ]);
    expect((await rowOf(id)).resolutionInput).toMatchObject({ company: { name: 'Cy Studio' }, website: expect.any(String) });
  });
});
