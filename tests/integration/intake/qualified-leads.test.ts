import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount } from '@/modules/accounts';
import { accountAlias, personAlias } from '@/modules/accounts/db/schema';
import { getLinks, leadQualified, seedMockCrm, syncOwners } from '@/modules/crm';
import { handoff, mockCompany, mockPerson } from '@/modules/crm/db/schema';
import { mockQualifyPerson } from '@/modules/crm/fixtures';
import { pollQualifiedLeads, simulateQualifiedLead } from '@/modules/intake';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { arrival, crmLeadPoll, source } from '@/modules/intake/db/schema';
import { SAMPLE_ONLY, connectionId } from '@/modules/integrations';
import { connection } from '@/modules/integrations/db/schema';
import { assign } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, member, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
let conn: string;
let hubspotSource: string;

const PAT = 'pat.lee@qualified.example';

beforeAll(async () => {
  t = await routingTenant();
  await t.run((ctx) => seedMockCrm(ctx));
  conn = await t.run((ctx) => connectionId(ctx, 'hubspot'));
  [{ id: hubspotSource }] = (await t.run((ctx) =>
    ctx.tx.select({ id: source.id }).from(source).where(sql`${source.settings}->>'key' = 'hubspot_qualified'`),
  )) as [{ id: string }];
});
afterAll(closeDbs);

const poll = async () => {
  await t.run((ctx) => pollQualifiedLeads(ctx));
  await runOutbox(t.tenantId);
};
const mockContact = async (email: string) =>
  (await t.run((ctx) => ctx.tx.select().from(mockPerson).where(eq(mockPerson.email, email))))[0]!;
const arrivalsFor = (contactId: string) =>
  t.run((ctx) =>
    ctx.tx
      .select()
      .from(arrival)
      .where(and(eq(arrival.closestSourceId, hubspotSource), sql`${arrival.externalRef} like ${`hubspot:${contactId}:%`}`)),
  );
const resolvedEvent = async (arrivalId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .find((e) => e.type === arrivalResolved.type && e.data.arrivalId === arrivalId)?.data;

/** A qualified HubSpot contact with no company. */
async function noCompanyContact(email: string): Promise<string> {
  const externalId = `mock-ct-x${newId('acc').slice(-8).toLowerCase()}`;
  await withTenant(t.tenantId, (tx) =>
    tx.insert(mockPerson).values({ tenantId: t.tenantId, externalId, name: 'Sam Rivera', title: 'CTO', email, lifecycle: 'marketingqualifiedlead', qualifiedAt: new Date() }),
  );
  return externalId;
}

describe('HubSpot qualified leads in (SRC-E6-S1, CRM-E6)', () => {
  it('a polled qualified contact arrives from hubspot_qualified, resolves to its company and person, with hubspot aliases (SRC-E6-S1-AC1)', async () => {
    await poll();
    const pat = await mockContact(PAT);
    const [a] = await arrivalsFor(pat.externalId);
    expect(a).toMatchObject({ channel: 'webhook', status: 'resolved', externalRef: `hubspot:${pat.externalId}:${pat.qualifiedAt!.toISOString().slice(0, 10)}` });
    expect(await resolvedEvent(a!.id)).toMatchObject({ initialReviewStatusKey: 'needs_review' });

    const account = (await t.run((ctx) => getAccount(ctx, a!.accountId!)))!;
    expect(account.domain).toBe('qualified.example');
    const person = account.people.find((p) => p.email === PAT)!;
    expect(person).toBeDefined();

    const accountAliases = await t.run((ctx) => ctx.tx.select().from(accountAlias).where(and(eq(accountAlias.accountId, account.id), eq(accountAlias.kind, 'external_id'))));
    expect(accountAliases.map((x) => [x.system, x.value])).toEqual([['hubspot', pat.companyExternalId]]);
    const personAliases = await t.run((ctx) => ctx.tx.select().from(personAlias).where(and(eq(personAlias.personId, person.id), eq(personAlias.kind, 'external_id'))));
    expect(personAliases.map((x) => [x.system, x.value])).toEqual([['hubspot', pat.externalId]]);
  });

  it('getLinks returns the CRM company and contact (CRM-E6-S2-AC1)', async () => {
    const pat = await mockContact(PAT);
    const [a] = await arrivalsFor(pat.externalId);
    const links = await t.run((ctx) => getLinks(ctx, a!.accountId!));
    expect(links.company?.externalId).toBe(pat.companyExternalId);
    expect(links.people.map((l) => l.externalId)).toEqual([pat.externalId]);
  });

  it('a later handoff updates the linked company, creating no company or contact (CRM-E6-S2-AC2)', async () => {
    const pat = await mockContact(PAT);
    const [a] = await arrivalsFor(pat.externalId);
    const seller = await member(t, 'seller');
    // The new seller gets a mock owner, so the push can assign the company to them.
    await t.run((ctx) => seedMockCrm(ctx));
    await t.run((ctx) => syncOwners(ctx));
    await asPerson(t, (ctx) => assign(ctx, a!.accountId!, { sellerUserId: seller }));
    await runOutbox(t.tenantId);

    const [h] = await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a!.accountId!)));
    expect(h).toMatchObject({ status: 'completed', companyExternalId: pat.companyExternalId });
    expect(await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, 'qualified.example')))).toHaveLength(1);
    expect(await t.run((ctx) => ctx.tx.select().from(mockPerson).where(eq(mockPerson.email, PAT)))).toHaveLength(1);
  });

  it('polling twice and a crm.lead.qualified for the same contact give one arrival (Review Focus 5, SRC-E6-S1-AC3)', async () => {
    const pat = await mockContact(PAT);
    await poll();
    await publishTestEvent(t.tenantId, leadQualified, { connectionId: conn, contactId: pat.externalId });
    await runOutbox(t.tenantId);
    expect(await arrivalsFor(pat.externalId)).toHaveLength(1);
  });

  it('a crm.lead.qualified alone brings the contact in', async () => {
    const d = `hooked-${newId('acc').slice(-8).toLowerCase()}.com`;
    const contactId = await noCompanyContact(`lee@${d}`);
    await publishTestEvent(t.tenantId, leadQualified, { connectionId: conn, contactId });
    await runOutbox(t.tenantId);
    const [a] = await arrivalsFor(contactId);
    expect(a?.status).toBe('resolved');
  });

  it('a contact with no company arrives through the normal rules, with its email domain as the website, and is linked', async () => {
    const d = `nocompany-${newId('acc').slice(-8).toLowerCase()}.com`;
    const contactId = await noCompanyContact(`sam@${d}`);
    await poll();
    const [a] = await arrivalsFor(contactId);
    expect(a?.status).toBe('resolved');
    const account = (await t.run((ctx) => getAccount(ctx, a!.accountId!)))!;
    expect(account.domain).toBe(d);
    expect(account.people.map((p) => p.email)).toEqual([`sam@${d}`]);
    const links = await t.run((ctx) => getLinks(ctx, account.id));
    expect(links.people.map((l) => l.externalId)).toEqual([contactId]);
  });

  it('a free-mail contact with no company becomes a shell account', async () => {
    const email = `kim.${newId('acc').slice(-8).toLowerCase()}@gmail.com`;
    const contactId = await noCompanyContact(email);
    await poll();
    const [a] = await arrivalsFor(contactId);
    expect(a?.status).toBe('resolved');
    const account = (await t.run((ctx) => getAccount(ctx, a!.accountId!)))!;
    expect(account.isShell).toBe(true);
    expect(account.people.map((p) => p.email)).toEqual([email]);
  });

  it('polled_until advances to the latest qualified time', async () => {
    const later = new Date(Date.now() + 24 * 60 * 60_000);
    await t.run((ctx) => mockQualifyPerson(ctx, PAT, later));
    await poll();
    const [row] = await t.run((ctx) => ctx.tx.select().from(crmLeadPoll).where(eq(crmLeadPoll.connectionId, conn)));
    expect(row!.polledUntil.toISOString()).toBe(later.toISOString());
    // A new qualified date is a new arrival.
    expect(await arrivalsFor((await mockContact(PAT)).externalId)).toHaveLength(2);
  });
});

describe('simulate a qualified lead (SRC-E6-S1-AC4)', () => {
  it('sends the sample contact through the same path on the mock', async () => {
    const s = await routingTenant();
    const r = await s.run((ctx) => simulateQualifiedLead(ctx));
    expect(r.duplicateOfRequest).toBe(false);
    await runOutbox(s.tenantId);
    const [a] = await s.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, r.arrivalId)));
    expect(a).toMatchObject({ channel: 'webhook', status: 'resolved' });
    expect((await s.run((ctx) => getAccount(ctx, a!.accountId!)))!.domain).toBe('qualified.example');
  });

  it('gives 409 outside the mock', async () => {
    const s = await routingTenant();
    const id = await s.run((ctx) => connectionId(ctx, 'hubspot'));
    await adminDb.update(connection).set({ mode: 'live' }).where(eq(connection.id, id));
    await expect(s.run((ctx) => simulateQualifiedLead(ctx))).rejects.toMatchObject({ status: 409, message: SAMPLE_ONLY });
  });
});
