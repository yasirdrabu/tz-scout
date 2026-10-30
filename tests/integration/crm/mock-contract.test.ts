import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import '@/entry/registry';
import { hubspotMock, noteFingerprint, seedMockCrm, type CrmAdapter } from '@/modules/crm';
import { mockCompany, mockOwner } from '@/modules/crm/db/schema';
import { mockAddActivity, mockAddDeal, mockCompleteTask, mockEditNote, mockQualifyPerson, mockSetDeal, setMockFailure } from '@/modules/crm/fixtures';
import { gateway, RateLimitedError } from '@/modules/integrations';
import { callLog } from '@/modules/integrations/db/schema';
import { addMember } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runAdapterContract } from '../../contract/crm/adapter.contract';
import { freshTenant } from '../intake/helpers';
import { seedUser } from '../tenancy/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let seed: Awaited<ReturnType<typeof seedMockCrm>>;
const sellerOwner = '7001';
const EARLY = '2000-01-01T00:00:00Z';

/** A context the mock can use with no open transaction: it commits on its own. */
const detached = (): ModuleContext => ({ tenantId: t.tenantId, actor: t.actor, correlationId: newId('cor'), tx: null as never, environment: 'test' });
const mock = (): CrmAdapter => hubspotMock(detached());
const viaGateway = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => t.run((ctx) => gateway.call(ctx, 'hubspot', op, (a) => fn(a as CrmAdapter)));

beforeAll(async () => {
  t = await freshTenant();
  const u = await seedUser({ signedIn: true });
  await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller', crmOwnerIds: { hubspot: sellerOwner } }));
  seed = await t.run((ctx) => seedMockCrm(ctx));
});
afterAll(closeDbs);

runAdapterContract(() => mock(), { name: 'mock HubSpot' });
// The live run needs a real token. The live adapter arrives with Task 3, which replaces this factory.
runAdapterContract(
  () => {
    throw new Error('The live HubSpot adapter is not built yet.');
  },
  { name: 'live HubSpot', skip: !process.env.SCOUT_LIVE_HUBSPOT_TOKEN },
);

describe('seedMockCrm', () => {
  it('adds an owner for each member and the named owners, and is idempotent', async () => {
    await t.run((ctx) => seedMockCrm(ctx));
    const owners = await t.run((ctx) => ctx.tx.select().from(mockOwner));
    expect(owners.find((o) => o.externalId === sellerOwner)).toBeTruthy();
    expect(owners.filter((o) => o.name === 'Vijay Kumar')).toHaveLength(1);
    expect(owners.find((o) => o.name === 'Vijay Kumar')?.active).toBe(true);
    expect(owners.find((o) => o.name === 'Rahul Mehta')?.active).toBe(false);
    const customer = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, 'customer.example')));
    expect(customer).toHaveLength(1);
    expect(customer[0]?.lifecycle).toBe('customer');
  });
});

describe('mock HubSpot rules (CRM-E1-S3-AC2)', () => {
  const company = (domain: string, over: Record<string, unknown> = {}) => ({
    domain,
    name: domain,
    ownerExternalId: sellerOwner,
    replaceableOwner: false,
    properties: {},
    ...over,
  });

  it('reports owned elsewhere, open deal, customer and an inactive owner', async () => {
    const a = mock();
    expect((await a.findCompany({ domain: 'owned-elsewhere.example' }))?.ownerExternalId).toBe(seed.vijay);
    const open = await a.findCompany({ domain: 'open-deal.example' });
    expect(open?.openDeals).toBe(1);
    expect(open?.deals[0]?.status).toBe('open');
    expect((await a.findCompany({ domain: 'customer.example' }))?.lifecycle).toBe('customer');
    expect((await a.findCompany({ domain: 'inactive-owner.example' }))?.ownerExternalId).toBe(seed.rahul);
  });

  it('never replaces an owner unless the handoff says it may', async () => {
    const a = mock();
    expect((await a.upsertCompany(company('owned-elsewhere.example'))).ownerExternalId).toBe(seed.vijay);
    expect((await a.upsertCompany(company('inactive-owner.example', { replaceableOwner: true }))).ownerExternalId).toBe(sellerOwner);
    expect((await a.upsertCompany(company('qualified.example'))).ownerExternalId).toBe(sellerOwner);
  });

  it('adds a new note and keeps the edited one when a person edited it', async () => {
    const a = mock();
    const co = await a.upsertCompany(company(`note-${Date.now()}.example`));
    const n1 = await a.upsertNote({ companyExternalId: co.externalId, html: '<p>One</p>', ownerExternalId: null });
    expect(n1.fingerprint).toBe(noteFingerprint('<p>One</p>'));
    await mockEditNote(detached(), n1.externalId);
    const n2 = await a.upsertNote({ externalId: n1.externalId, expectedFingerprint: n1.fingerprint, companyExternalId: co.externalId, html: '<p>Two</p>', ownerExternalId: null });
    expect(n2.kept).toBe(true);
    expect(n2.externalId).not.toBe(n1.externalId);
  });

  it('does not reopen a completed task', async () => {
    const a = mock();
    const co = await a.upsertCompany(company(`task-${Date.now()}.example`));
    const tk = await a.upsertTask({ companyExternalId: co.externalId, subject: 'Call', body: '', ownerExternalId: null, dueAt: null });
    await mockCompleteTask(detached(), tk.externalId);
    const again = await a.upsertTask({ externalId: tk.externalId, companyExternalId: co.externalId, subject: 'Call again', body: '', ownerExternalId: null, dueAt: null });
    expect(again).toEqual({ externalId: tk.externalId, status: 'completed' });
  });

  it('reads the activities and deals the helpers added, with money in cents', async () => {
    const a = mock();
    const co = await a.upsertCompany(company(`deal-${Date.now()}.example`));
    const ctx = detached();
    const act = await mockAddActivity(ctx, { companyExternalId: co.externalId, kind: 'reply', actorOwnerExternalId: sellerOwner });
    const deal = await mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Big', amountCents: 1_250_000 });
    expect((await a.listActivities({ companyExternalId: co.externalId, since: EARLY })).map((x) => x.externalId)).toEqual([act]);
    await mockSetDeal(ctx, deal, { status: 'won' });
    const deals = await a.listDeals({ changedSince: EARLY });
    expect(deals.find((d) => d.externalId === deal)).toMatchObject({ status: 'won', amountCents: 1_250_000 });
    expect(await a.readFollowThrough({ companyExternalId: co.externalId, taskExternalIds: [] })).toMatchObject({ emails: 1, deals: 1, openDeals: 0 });
  });

  it('lists a qualified lead by the lifecycle rule', async () => {
    const rule = { property: 'lifecyclestage', value: 'marketingqualifiedlead' };
    const leads = await mock().listQualifiedLeads({ changedSince: EARLY, rule });
    const pat = leads.find((l) => l.contact.email === 'pat.lee@qualified.example');
    expect(pat?.company?.domain).toBe('qualified.example');
    expect(await mock().listQualifiedLeads({ changedSince: EARLY, rule: { property: 'lifecyclestage', value: 'customer' } })).toEqual([]);
    expect((await mock().readQualifiedLead({ contactId: pat!.contact.externalId, rule }))?.contact.email).toBe('pat.lee@qualified.example');
  });

  it('returns a contact qualified after it was created when changedSince falls between the two', async () => {
    const a = mock();
    const co = await a.upsertCompany(company(`later-${Date.now()}.example`));
    const email = `later-${Date.now()}@later.example`;
    await a.upsertPerson({ name: 'Later Lee', email, ownerExternalId: null, takeOverOwner: false, companyExternalId: co.externalId });
    const between = new Date(Date.now() + 1000);
    const rule = { property: 'lifecyclestage', value: 'marketingqualifiedlead' };
    expect((await a.listQualifiedLeads({ changedSince: EARLY, rule })).some((l) => l.contact.email === email)).toBe(false);
    await mockQualifyPerson(detached(), email, new Date(between.getTime() + 1000));
    const leads = await a.listQualifiedLeads({ changedSince: between.toISOString(), rule });
    expect(leads.find((l) => l.contact.email === email)?.qualifiedAt).toBe(new Date(between.getTime() + 1000).toISOString());
  });

  it('429 gives RateLimitedError, 500 throws with status 500, a timeout throws, each the set number of times', async () => {
    const ctx = detached();
    await setMockFailure(ctx, 'findCompany', '429', 1);
    await expect(viaGateway('findCompany', (a) => a.findCompany({ domain: 'x.example' }))).rejects.toBeInstanceOf(RateLimitedError);
    await expect(viaGateway('findCompany', (a) => a.findCompany({ domain: 'x.example' }))).resolves.toBeNull();

    await setMockFailure(ctx, 'listOwners', '500', 1);
    await expect(mock().listOwners({})).rejects.toMatchObject({ status: 500 });
    await expect(mock().listOwners({})).resolves.toBeInstanceOf(Array);

    await setMockFailure(ctx, 'listOwners', 'timeout', 1);
    await expect(mock().listOwners({})).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(mock().listOwners({})).resolves.toBeInstanceOf(Array);
  });
});

describe('mock HubSpot storage (CRM-E1-S3-AC1)', () => {
  it('commits on its own, so a rolled-back caller keeps the record and a fresh transaction sees it', async () => {
    const domain = `commit-${Date.now()}.example`;
    await expect(
      t.run(async (ctx) => {
        await gateway.call(ctx, 'hubspot', 'upsertCompany', (a) =>
          (a as CrmAdapter).upsertCompany({ domain, name: 'Commit', ownerExternalId: null, replaceableOwner: false, properties: {} }),
        );
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    const found = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, domain)));
    expect(found).toHaveLength(1);
    expect(found[0]!.externalId).toMatch(/^mock-co-\d+$/);
  });

  it('writes a call log row with provider hubspot for each call', async () => {
    const rows = () => t.run((ctx) => ctx.tx.select().from(callLog).where(eq(callLog.provider, 'hubspot')));
    const before = (await rows()).length;
    await viaGateway('listOwners', (a) => a.listOwners({}));
    const after = await rows();
    expect(after.length).toBe(before + 1);
    expect(after.some((r) => r.operation === 'listOwners' && r.outcome === 'ok')).toBe(true);
  });
});
