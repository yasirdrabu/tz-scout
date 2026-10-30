import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { backfillR1c } from '@/entry/seed';
import { upsertFromArrival } from '@/modules/accounts';
import { accountAlias } from '@/modules/accounts/db/schema';
import { activityPollJob, companyCheckJob, getBatch, getLinks, pollActivity, pollDeals, seedMockCrm, syncOwners } from '@/modules/crm';
import { handoff, link, mockCompany, mockNote, mockTask } from '@/modules/crm/db/schema';
import { mockAddActivity, mockAddDeal, mockSetDeal } from '@/modules/crm/fixtures';
import { pollQualifiedLeads, qualifiedLeadsPollJob, submitArrival } from '@/modules/intake';
import { assign, decline, getAccountStatus } from '@/modules/routing';
import { assignment } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant as bareTenant } from '../integrations/helpers';
import { asSource, personAndAgent } from '../intake/helpers';
import { asPerson, domain, member, routingTenant, summaryOf } from '../routing/helpers';

afterAll(closeDbs);

let n = 0;
const uniqueDomain = () => `${Date.now().toString(36)}${++n}-example.com`;

describe('R1c exit path (on the mock CRM)', () => {
  let t: Awaited<ReturnType<typeof routingTenant>>;
  let seller: string;
  let agentId: string;
  let vijay: string;

  beforeAll(async () => {
    t = await routingTenant();
    seller = await member(t, 'seller');
    ({ agentId } = await personAndAgent(t, 'Exit'));
    ({ vijay } = await t.run((ctx) => seedMockCrm(ctx)));
    await t.run((ctx) => syncOwners(ctx));
  });

  const sellerOwner = () => `mock-${seller}`;
  const send = async (name: string, d: string) => {
    const sent = await asSource(t, agentId, (ctx) =>
      submitArrival(
        ctx,
        { account: { name, domain: d, industry: 'logistics', employees: 2400 }, people: [{ name: 'Pat Lee', title: 'CTO', email: `pat.${++n}@${d}` }] },
        { channel: 'api', canDeclareWarmIntro: false },
      ),
    );
    await runOutbox(t.tenantId);
    return (await asSource(t, agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId)))!.accountId!;
  };
  const handoffOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, accountId))))[0]!;
  const assignmentOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.accountId, accountId))))[0]!;

  it('goes from an agent arrival to a won deal, a decline and a qualified lead', async () => {
    // 1. An agent sends an account; a leader assigns it; it lands in the mock CRM owned by the seller.
    const d = uniqueDomain();
    const accountId = await send('Exit Logistics', d);
    const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, notes: 'Warm lead' }));
    await runOutbox(t.tenantId);
    const h = await handoffOf(accountId);
    expect(h.status).toBe('completed');
    const [company] = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, d)));
    expect(company!.ownerExternalId).toBe(sellerOwner());
    const notes = await t.run((ctx) => ctx.tx.select().from(mockNote).where(eq(mockNote.companyExternalId, company!.externalId)));
    expect(notes).toHaveLength(1);
    const tasks = await t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, company!.externalId)));
    expect(tasks).toHaveLength(4);
    expect(tasks.every((x) => x.ownerExternalId === sellerOwner())).toBe(true);

    // 2. One message per seller in the batch.
    const batch = (await t.run((ctx) => getBatch(ctx, h.handoffBatchId!)))!;
    expect(batch.messages.map((m) => m.sellerUserId)).toEqual([seller]);

    // 3. A reply by the seller in the mock: the next activity poll accepts the assignment and the stage is engaged.
    expect((await assignmentOf(accountId)).status).toBe('pending');
    await t.run((ctx) => mockAddActivity(ctx, { companyExternalId: company!.externalId, kind: 'reply', actorOwnerExternalId: sellerOwner() }));
    await t.run((ctx) => pollActivity(ctx, new Date()));
    await runOutbox(t.tenantId);
    expect(await assignmentOf(accountId)).toMatchObject({ id: made.id, status: 'accepted', acceptedHow: 'crm_activity' });
    expect(await summaryOf(t, accountId)).toMatchObject({ stage: 'engaged' });

    // 4. A new deal moves the stage to opportunity; closing it won moves it to won.
    const dealId = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company!.externalId, name: 'Exit deal', amountCents: 100_000 }));
    await t.run((ctx) => pollDeals(ctx, new Date()));
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, accountId)).toMatchObject({ stage: 'opportunity' });
    await t.run((ctx) => mockSetDeal(ctx, dealId, { status: 'won' }));
    await t.run((ctx) => pollDeals(ctx, new Date()));
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, accountId)).toMatchObject({ stage: 'won' });

    // 5. A second account is assigned and declined: its tasks close and its owner goes back.
    const second = await send('Exit Second', 'owned-elsewhere.example');
    const secondAsg = await asPerson(t, (ctx) => assign(ctx, second, { sellerUserId: seller }));
    await runOutbox(t.tenantId);
    const [elsewhere] = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, 'owned-elsewhere.example')));
    expect(elsewhere!.ownerExternalId).toBe(sellerOwner());
    await asPerson(t, (ctx) => decline(ctx, secondAsg.id, { reasonKey: 'not_my_territory' }), { userId: seller });
    await runOutbox(t.tenantId);
    const closed = await t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, elsewhere!.externalId)));
    expect(closed).toHaveLength(4);
    expect(closed.every((x) => x.status === 'completed')).toBe(true);
    const [back] = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.externalId, elsewhere!.externalId)));
    expect(back!.ownerExternalId).toBe(vijay);

    // 6. A qualified contact polled from the mock reaches the queue as needs_review, linked.
    await t.run((ctx) => pollQualifiedLeads(ctx));
    await runOutbox(t.tenantId);
    const [qualified] = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, 'qualified.example')));
    const [alias] = await adminDb
      .select()
      .from(accountAlias)
      .where(and(eq(accountAlias.tenantId, t.tenantId), eq(accountAlias.kind, 'external_id'), eq(accountAlias.value, qualified!.externalId)));
    expect(await summaryOf(t, alias!.accountId)).toMatchObject({ reviewStatusKey: 'needs_review' });
    expect((await t.run((ctx) => getLinks(ctx, alias!.accountId))).company?.externalId).toBe(qualified!.externalId);
  }, 120_000);
});

describe('backfillR1c', () => {
  /** A tenant as R1b left it: accounts with and without domains, one with a HubSpot alias, and no CRM defaults. */
  async function r1bTenant() {
    const t = await bareTenant();
    const make = (name: string, d: string | undefined, externalIds: { system: string; id: string }[] = []) =>
      t.run((ctx) =>
        upsertFromArrival(ctx, {
          arrivalId: newId('evt').replace('evt_', 'arr_'),
          receivedAt: new Date(),
          sourceChain: {},
          account: { name, ...(d ? { domain: d } : {}) },
          people: [],
          signals: [],
          facts: [],
          research: {},
          soleProprietor: false,
          externalIds,
        }),
      );
    const withIds = await make('Linked Co', domain(), [{ system: 'hubspot', id: 'mock-co-900' }]);
    await make('Plain Co', domain());
    const noDomain = await make('No Domain Co', undefined);
    // The events of R1c would already have checked and linked them, so forget all of that, as an R1b tenant would.
    await runOutbox(t.tenantId);
    for (const table of ['crm.company_check', 'crm.link', 'crm.field_mapping', 'crm.setting']) {
      await adminDb.execute(sql`delete from ${sql.raw(table)} where tenant_id = ${t.tenantId}`);
    }
    await adminDb.execute(sql`delete from platform.schedule where tenant_id = ${t.tenantId} and job_name like 'crm.%'`);
    return { t, withIds: withIds.accountId, noDomain: noDomain.accountId };
  }

  const count = async (text: ReturnType<typeof sql>) => Number(((await adminDb.execute(text)) as unknown as { n: string }[])[0]!.n);
  const counts = async (tenantId: string) => {
    const jobs = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).map((r) => (r.payload as { type: string }).type);
    return {
      settings: await count(sql`select count(*) n from crm.setting where tenant_id = ${tenantId}`),
      mappings: await count(sql`select count(*) n from crm.field_mapping where tenant_id = ${tenantId}`),
      schedules: await count(sql`select count(*) n from platform.schedule where tenant_id = ${tenantId}`),
      links: await count(sql`select count(*) n from crm.link where tenant_id = ${tenantId}`),
      checks: await count(sql`select count(*) n from crm.company_check where tenant_id = ${tenantId} and account_id not like 'domain:%'`),
      checkJobs: jobs.filter((x) => x === `jobs.${companyCheckJob.name}`).length,
    };
  };

  it('gives R1b accounts checks and links, schedules the CRM polls, and a second run changes nothing', async () => {
    const { t, withIds, noDomain } = await r1bTenant();
    const before = await counts(t.tenantId);
    expect(before).toMatchObject({ settings: 0, mappings: 0, links: 0, checks: 0 });

    await t.run((ctx) => backfillR1c(ctx));
    const first = await counts(t.tenantId);
    expect(first).toMatchObject({ settings: 1, mappings: 11, links: 1 });
    expect(first.checkJobs - before.checkJobs).toBe(2);
    const linked = await t.run((ctx) => ctx.tx.select().from(link).where(eq(link.scoutId, withIds)));
    expect(linked.map((l) => [l.scoutType, l.system, l.externalId])).toEqual([['account', 'hubspot', 'mock-co-900']]);

    await runOutbox(t.tenantId);
    const checked = await counts(t.tenantId);
    expect(checked.checks).toBe(2);
    expect(await adminDb.execute(sql`select 1 from crm.company_check where account_id = ${noDomain}`)).toHaveLength(0);

    await t.run((ctx) => backfillR1c(ctx));
    await runOutbox(t.tenantId);
    expect(await counts(t.tenantId)).toEqual(checked);
  }, 60_000);

  it('schedules the activity poll and the qualified-lead poll', async () => {
    const { t } = await r1bTenant();
    await t.run((ctx) => backfillR1c(ctx));
    const rows = (await adminDb.execute(sql`select job_name from platform.schedule where tenant_id = ${t.tenantId}`)) as unknown as { job_name: string }[];
    expect(rows.map((j) => j.job_name)).toEqual(expect.arrayContaining([activityPollJob.name, qualifiedLeadsPollJob.name]));
  }, 60_000);
});
