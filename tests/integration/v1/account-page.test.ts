// Task 6 of the Playbooks (minimum) plan: the account page's read gaps in scoring, accounts and crm.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getActivity } from '@/http/routes/v1/accounts/[id]/activity/route';
import { GET as getEngagement } from '@/http/routes/v1/accounts/[id]/engagement/route';
import { GET as getCrmCheck } from '@/http/routes/v1/accounts/[id]/crm-check/route';
import { GET as getFacts } from '@/http/routes/v1/accounts/[id]/facts/route';
import { GET as getHandoffs } from '@/http/routes/v1/accounts/[id]/handoffs/route';
import { GET as getPeople } from '@/http/routes/v1/accounts/[id]/people/route';
import { GET as getAccountRoute, POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { GET as getScore } from '@/http/routes/v1/accounts/[id]/score/route';
import { POST as postArrival } from '@/http/routes/v1/arrivals/route';
import { GET as getBuyingRoles } from '@/http/routes/v1/buying-roles/route';
import { listPeople, upsertFromArrival } from '@/modules/accounts';
import { buyingRole } from '@/modules/accounts/db/schema';
import { handoffPackageProvider, registerHandoffPackageProvider, seedMockCrm, syncAccount, syncOwners } from '@/modules/crm';
import { activity, companyCheck, followThrough, handoff, link } from '@/modules/crm/db/schema';
import { mockAddActivity, setMockFailure } from '@/modules/crm/fixtures';
import { arrival } from '@/modules/intake/db/schema';
import { offer as offerTable } from '@/modules/offers/db/schema';
import { offerMatch } from '@/modules/scoring/db/schema';
import { setConnectionSettings } from '@/modules/integrations';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { completeOffer } from '../offers/helpers';
import { resolved, setSummary } from '../routing/helpers';
import { call, keyFor, SEND } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let otherAccount: string;
let bestPractice: string;
let bestOfferId: string;
let otherOfferId: string;
let unmatchedOfferId: string;

beforeAll(async () => {
  w = await workspace('Page Co');
  other = await workspace('Other Page Co');
  leader = await w.person('leader', { name: 'Dana Ruiz' });
  seller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'own_accounts' } });
  await w.run((ctx) => seedMockCrm(ctx));
  await w.run((ctx) => syncOwners(ctx));
  const practice = await w.run((ctx) => createPractice(ctx, { name: 'Page Practice', slug: `pg-${newId('prc').slice(-8).toLowerCase()}` }));
  const best = await w.run((ctx) => createOffer(ctx, { name: 'Page Best', practiceId: practice.id, ...completeOffer }));
  const second = await w.run((ctx) => createOffer(ctx, { name: 'Page Other', practiceId: practice.id, ...completeOffer, industries: ['healthcare'] }));
  for (const o of [best, second]) await w.run((ctx) => approveOffer(ctx, o.id));
  bestPractice = practice.id;
  bestOfferId = best.id;
  otherOfferId = second.id;
  unmatchedOfferId = (await w.run((ctx) => createOffer(ctx, { name: 'Page Draft', practiceId: practice.id, ...completeOffer }))).id;
  otherAccount = await other.sent({ name: 'Elsewhere Co' });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const json = async (res: Response | Promise<Response>) => (await res).json();
const own = (accountId: string) => setSummary(w.tenant, accountId, { ownerUserId: seller });

describe('GET /accounts/{id}/score tiles and warm_intro', () => {
  it('adds five tiles in order and warm_intro', async () => {
    const a = await w.sent({ name: 'Tile Co', industry: 'Logistics' });
    const res = await w.as(leader, getScore, `accounts/${a}/score`);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.tiles.map((t: { key: string; label: string }) => [t.key, t.label])).toEqual([
      ['priority', 'Priority'],
      ['fit', 'Fit'],
      ['intent', 'Buying intent'],
      ['revenue_potential', 'Revenue potential'],
      ['source_trust', 'Source trust'],
    ]);
    expect(s.tiles[0]).toMatchObject({ value: s.priority, max: 100 });
    expect(s.tiles[1]).toMatchObject({ value: s.fit, max: 100 });
    expect(s.tiles[2]).toMatchObject({ value: s.intent, max: 100, note: 'No dated signals yet.' });
    expect(s.tiles[0].note).toBe('Act now starts at 75 with a research or trigger signal.');
    expect(s.tiles[3]).toEqual({ key: 'revenue_potential', label: 'Revenue potential', value: expect.any(Number), max: 100, note: "About $50,000 a deal at this company's size (medium)." });
    expect(s.tiles[4]).toEqual({ key: 'source_trust', label: 'Source trust', value: expect.any(Number), max: 100, note: expect.stringMatching(/rated|counts as 60/) });
    expect(s.warm_intro).toBeNull();
  });

  it('says no signal matched an intent rule when a dated signal matched none', async () => {
    const key = await keyFor(w.tenant, SEND, { sourceId: w.source.agentId, dataLimit: { kind: 'own_source' } });
    const body = {
      account: { domain: `${newId('acc').slice(-10).toLowerCase()}-example.com`, name: 'Signal Tile Co', industry: 'Logistics' },
      signals: [{ type: 'trigger', title: 'Opened a new depot', occurred_at: '2026-10-14' }],
    };
    const res = await call(postArrival, key, 'arrivals', { body });
    expect(res.status).toBe(202);
    const arrivalId = (await res.json()).arrival_id as string;
    await w.deliver();
    const [row] = await w.run((ctx) => ctx.tx.select({ accountId: arrival.accountId }).from(arrival).where(eq(arrival.id, arrivalId)));
    const s = await json(w.as(leader, getScore, `accounts/${row!.accountId}/score`));
    expect(s.intent).toBe(0);
    expect(s.tiles[2]).toMatchObject({ value: 0, note: `No signal matched an intent rule for ${s.offer}.` });
  });

  it('a non-best offer gets its own tiles; an offer with no match is a 404', async () => {
    const a = await w.sent({ name: 'Offer Tile Co', industry: 'Logistics' });
    const best = await json(w.as(leader, getScore, `accounts/${a}/score`));
    expect(best.offer_id).toBe(bestOfferId);
    const res = await w.as(leader, getScore, `accounts/${a}/score?offer_id=${otherOfferId}`);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.offer_id).toBe(otherOfferId);
    expect(s.tiles[1].value).toBe(s.fit);
    expect(s.tiles[0].value).toBe(s.priority);
    expect((await w.as(leader, getScore, `accounts/${a}/score?offer_id=${unmatchedOfferId}`)).status).toBe(404);
  });

  it("a chosen offer's tiles carry the reasons, say when it has no deal size, and say not scored yet for a match from before the four-weight model", async () => {
    const a = await w.sent({ name: 'Reason Tile Co', industry: 'Logistics' });
    const noDeal = await w.run((ctx) =>
      createOffer(ctx, { name: 'Page No Deal', practiceId: bestPractice, ...completeOffer, industries: ['healthcare'] }),
    );
    await w.run((ctx) => approveOffer(ctx, noDeal.id));
    // Approval needs a deal size; an offer can lose it afterwards.
    await w.run((ctx) => ctx.tx.update(offerTable).set({ typicalDealCents: null }).where(eq(offerTable.id, noDeal.id)));
    await w.deliver();
    const best = await json(w.as(leader, getScore, `accounts/${a}/score`));
    const chosen = await json(w.as(leader, getScore, `accounts/${a}/score?offer_id=${otherOfferId}`));
    expect(chosen.tiles[3]).toMatchObject({ value: expect.any(Number), max: 100, note: "About $50,000 a deal at this company's size (medium)." });
    expect(chosen.tiles[4]).toMatchObject({ value: expect.any(Number), max: 100, note: best.tiles[4].note });
    expect(chosen.tiles[4].note).not.toBe('');
    const empty = await json(w.as(leader, getScore, `accounts/${a}/score?offer_id=${noDeal.id}`));
    expect(empty.tiles[3]).toMatchObject({ value: 50, note: 'No deal size on Page No Deal.' });

    await w.run((ctx) => ctx.tx.update(offerMatch).set({ revenueScore: null, trustScore: null }).where(and(eq(offerMatch.accountId, a), eq(offerMatch.offerId, otherOfferId))));
    const old = await json(w.as(leader, getScore, `accounts/${a}/score?offer_id=${otherOfferId}`));
    expect(old.tiles[3]).toEqual({ key: 'revenue_potential', label: 'Revenue potential', value: null, max: null, note: 'Not scored yet.' });
    expect(old.tiles[4]).toEqual({ key: 'source_trust', label: 'Source trust', value: null, max: null, note: 'Not scored yet.' });
  });

  it('needs accounts:read, is a 404 across tenants, and a seller reads their own account', async () => {
    const a = await w.sent({ name: 'Seller Tile Co', industry: 'Logistics' });
    const key = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getScore, key, `accounts/${a}/score`)).status).toBe(403);
    expect((await w.as(leader, getScore, `accounts/${otherAccount}/score`)).status).toBe(404);
    expect((await w.as(seller, getScore, `accounts/${a}/score`)).status).toBe(404);
    await own(a);
    expect((await json(w.as(seller, getScore, `accounts/${a}/score`))).tiles).toHaveLength(5);
  });
});

describe('role labels and GET /buying-roles', () => {
  it('people roles carry the tenant label, on the account and on /people', async () => {
    const { accountId: a } = await w.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('arr'),
        receivedAt: new Date(),
        sourceChain: {},
        account: { name: 'Role Co', domain: `${newId('acc').slice(-10).toLowerCase()}-example.com` },
        people: [{ firstName: 'Rita', lastName: 'Gomez', title: 'CIO', email: `rita.${newId('acc').slice(-6).toLowerCase()}@role.example`, roleKeys: ['technical_buyer'] }],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    );
    await adminDb
      .update(buyingRole)
      .set({ label: 'Tech buyer' })
      .where(and(eq(buyingRole.tenantId, w.tenantId), eq(buyingRole.key, 'technical_buyer')));
    const people = (await json(w.as(leader, getPeople, `accounts/${a}/people`))).data;
    expect(people[0].roles).toEqual([expect.objectContaining({ key: 'technical_buyer', label: 'Tech buyer' })]);
    const acc = await json(w.as(leader, getAccountRoute, `accounts/${a}`));
    expect(acc.people[0].roles[0].label).toBe('Tech buyer');
  });

  it('lists the active roles by sort', async () => {
    await adminDb.update(buyingRole).set({ archived: true }).where(and(eq(buyingRole.tenantId, w.tenantId), eq(buyingRole.key, 'blocker')));
    const res = await w.as(seller, getBuyingRoles, 'buying-roles');
    expect(res.status).toBe(200);
    const roles = (await res.json()).data as { key: string; label: string }[];
    expect(roles[0]).toEqual({ key: 'business_owner', label: 'Business owner' });
    expect(roles.map((r) => r.key)).not.toContain('blocker');
    expect(Object.keys(roles[0]!)).toEqual(['key', 'label']);
    const key = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getBuyingRoles, key, 'buying-roles')).status).toBe(403);
    const otherRoles = (await json(other.as(other.owner, getBuyingRoles, 'buying-roles'))).data as { key: string }[];
    expect(otherRoles.map((r) => r.key)).toContain('blocker');
  });
});

describe('GET /accounts/{id}/facts source_names', () => {
  it('names each source of the chain, for a seller without arrivals:read', async () => {
    const a = await w.sent({ name: 'Fact Source Co', industry: 'Logistics' });
    await own(a);
    const res = await w.as(seller, getFacts, `accounts/${a}/facts`);
    expect(res.status).toBe(200);
    const facts = (await res.json()).data as { key: string; source_names: { person: string | null; agent: string | null; vendor: string | null } }[];
    const industry = facts.find((f) => f.key === 'industry')!;
    expect(industry.source_names).toEqual({ person: 'Page Co Ash', agent: 'Page Co Ash agent', vendor: null });
    expect((await w.as(leader, getFacts, `accounts/${otherAccount}/facts`)).status).toBe(404);
    const key = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getFacts, key, `accounts/${a}/facts`)).status).toBe(403);
  });
});

describe('fact labels and signal source names', () => {
  it('each fact has a label', async () => {
    const a = await w.sent({ name: 'Label Co', industry: 'Logistics', employees: 40 });
    const facts = (await json(w.as(leader, getFacts, `accounts/${a}/facts`))).data as { key: string; label: string }[];
    expect(facts.find((f) => f.key === 'industry')!.label).toBe('Industry');
    expect(facts.find((f) => f.key === 'employees')!.label).toBe('Employees');
  });

  it('a signal from the agent carries its source name, for a seller without arrivals:read', async () => {
    const key = await keyFor(w.tenant, SEND, { sourceId: w.source.agentId, dataLimit: { kind: 'own_source' } });
    const domain = `${newId('acc').slice(-10).toLowerCase()}-example.com`;
    const signals = [{ type: 'trigger', title: 'Hired a CIO', occurred_at: '2026-10-01', url: 'https://news.example.com/cio' }];
    const posted = await call(postArrival, key, 'arrivals', { body: { account: { name: 'Signal Source Co', domain }, signals } });
    expect(posted.status).toBe(202);
    await w.deliver();
    const [row] = await adminDb.select({ id: arrival.accountId }).from(arrival).where(eq(arrival.id, (await posted.json()).arrival_id));
    const a = row!.id!;
    await own(a);
    for (const who of [leader, seller]) {
      const res = await w.as(who, getAccountRoute, `accounts/${a}`);
      expect(res.status).toBe(200);
      const signals = (await res.json()).signals as { title: string; source_name: string | null; source_names: Record<string, string | null> }[];
      const s = signals.find((x) => x.title === 'Hired a CIO')!;
      expect(s.source_name).toBe('Page Co Ash agent');
      expect(s.source_names).toEqual({ person: 'Page Co Ash', agent: 'Page Co Ash agent', vendor: null });
    }
    expect((await w.as(leader, getAccountRoute, `accounts/${otherAccount}`)).status).toBe(404);
  });
});

describe('the In HubSpot card', () => {
  it(':check-crm against the mock with open-deal.example returns the deal; GET returns the stored card', async () => {
    const a = await w.sent({ name: 'Open Deal', domain: 'open-deal.example' });
    const res = await w.as(leader, accountAction, `accounts/${a}:check-crm`, 'POST');
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card).toMatchObject({
      exists: true,
      owner_name: 'Vijay Kumar',
      lifecycle: 'open_deal',
      open_deals: 1,
      open_deal: { name: 'Open Deal renewal', amount_cents: 5_000_000, currency: 'USD' },
      hubspot_url: null,
    });
    expect(card.open_deal.last_activity_at).toEqual(expect.any(String));
    expect(card.checked_at).toEqual(expect.any(String));
    await w.run((ctx) => setConnectionSettings(ctx, 'hubspot', { portal_id: '123' }));
    const stored = await json(w.as(leader, getCrmCheck, `accounts/${a}/crm-check`));
    expect(stored).toMatchObject({ exists: true, open_deal: { name: 'Open Deal renewal' } });
    expect(stored.hubspot_url).toMatch(/^https:\/\/app\.hubspot\.com\/contacts\/123\/record\/0-2\//);
  });

  it('is { exists: null, checked_at: null } when never checked', async () => {
    const a = await w.sent({ name: 'Never Checked Co' });
    await adminDb.delete(companyCheck).where(eq(companyCheck.accountId, a));
    expect(await json(w.as(leader, getCrmCheck, `accounts/${a}/crm-check`))).toEqual({ exists: null, checked_at: null });
  });

  it('is a 503 crm_unavailable when HubSpot does not answer', async () => {
    const a = await w.sent({ name: 'Down Co' });
    await w.run((ctx) => setMockFailure(ctx, 'findCompany', '500', 10));
    const res = await w.as(leader, accountAction, `accounts/${a}:check-crm`, 'POST');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ title: "HubSpot didn't answer. Try again in a minute." });
    await w.run((ctx) => setMockFailure(ctx, 'findCompany', '500', 0));
  });

  it('needs accounts:read (people only for :check-crm), 404 across tenants and outside the data limit, and a seller reads their own', async () => {
    const a = await w.sent({ name: 'Card Access Co' });
    const read = await keyFor(w.tenant, ['accounts:read'], { dataLimit: { kind: 'all' } });
    const none = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getCrmCheck, none, `accounts/${a}/crm-check`)).status).toBe(403);
    expect((await call(getCrmCheck, read, `accounts/${a}/crm-check`)).status).toBe(200);
    expect((await call(accountAction, read, `accounts/${a}:check-crm`, { method: 'POST', body: {} })).status).toBe(403);
    expect((await w.as(leader, getCrmCheck, `accounts/${otherAccount}/crm-check`)).status).toBe(404);
    expect((await w.as(leader, accountAction, `accounts/${otherAccount}:check-crm`, 'POST')).status).toBe(404);
    expect((await w.as(seller, getCrmCheck, `accounts/${a}/crm-check`)).status).toBe(404);
    await own(a);
    expect((await w.as(seller, getCrmCheck, `accounts/${a}/crm-check`)).status).toBe(200);
    expect((await w.as(seller, accountAction, `accounts/${a}:check-crm`, 'POST')).status).toBe(200);
  });
});

describe('handoffs and the activity feed', () => {
  let a: string;
  let h: typeof handoff.$inferSelect;

  beforeAll(async () => {
    a = await w.sent({ name: 'Feed Co', industry: 'Logistics' });
    const res = await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller });
    if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
    await w.deliver();
    h = (await adminDb.select().from(handoff).where(eq(handoff.accountId, a)))[0]!;
    await adminDb.update(followThrough).set({ checkedAt: new Date('2026-10-31T09:00:00Z') }).where(eq(followThrough.handoffId, h.id));
    await w.run((ctx) => setConnectionSettings(ctx, 'hubspot', { portal_id: '123' }));
    const kinds = ['email', 'reply', 'call', 'meeting', 'task_done'];
    const base = h.completedAt!.getTime();
    await adminDb.insert(activity).values(
      Array.from({ length: 26 }, (_, i) => ({
        id: newId('cac'),
        tenantId: w.tenantId,
        accountId: a,
        handoffId: h.id,
        system: 'hubspot',
        externalId: `ext-${a}-${i}`,
        kind: kinds[i % 5]!,
        occurredAt: new Date(base + (i + 1) * 60_000),
      })),
    );
  });

  it('handoffs carry crm_url, and follow_through.counts.replies counts only replies', async () => {
    const body = await json(w.as(leader, getHandoffs, `accounts/${a}/handoffs`));
    expect(h.status).toBe('completed');
    expect(body.handoffs[0].crm_url).toBe(`https://app.hubspot.com/contacts/123/record/0-2/${h.companyExternalId}`);
    expect(body.follow_through.counts.replies).toBe(5);
  });

  it('pages newest first, 25 a page, with Scout rows and synced_at', async () => {
    const res = await w.as(leader, getActivity, `accounts/${a}/activity`);
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first.data).toHaveLength(25);
    expect(first.data[0]).toEqual({ id: expect.stringMatching(/^cac_/), kind: 'email', at: expect.any(String), who: null, actor: 'person', summary: 'Email sent' });
    expect(first.data[1].summary).toBe('Task done');
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.synced_at).toBe('2026-10-31T09:00:00.000Z');
    const second = await json(w.as(leader, getActivity, `accounts/${a}/activity?cursor=${first.next_cursor}`));
    expect(second.next_cursor).toBeNull();
    expect(second.data.map((r: { kind: string }) => r.kind)).toEqual(['email', 'scout']);
    expect(second.data[1]).toMatchObject({ id: `${h.id}:sent`, summary: 'Scout sent the account to HubSpot with Sam Seller as owner and logged the brief.' });
    const ids = [...first.data, ...second.data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(27);
    expect((await w.as(leader, getActivity, `accounts/${a}/activity?cursor=nope`)).status).toBe(400);
  });

  it('needs accounts:read, is a 404 across tenants and outside the data limit, and a seller reads their own', async () => {
    const none = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getActivity, none, `accounts/${a}/activity`)).status).toBe(403);
    expect((await w.as(leader, getActivity, `accounts/${otherAccount}/activity`)).status).toBe(404);
    const limited = await w.person('seller', { name: 'Lee Limited', dataLimit: { kind: 'own_accounts' } });
    expect((await w.as(limited, getActivity, `accounts/${a}/activity`)).status).toBe(404);
    expect((await w.as(seller, getActivity, `accounts/${a}/activity`)).status).toBe(200);
  });
});

describe('feed rows say who did what (R2d Ruling 8)', () => {
  let a: string;
  let h: typeof handoff.$inferSelect;
  const startedAt = '2026-10-30T10:00:00.000Z';
  let before: ReturnType<typeof handoffPackageProvider> | null = null;

  beforeAll(async () => {
    a = await w.sent({ name: 'Who Co', industry: 'Logistics' });
    const res = await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller });
    if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
    await w.deliver();
    h = (await adminDb.select().from(handoff).where(eq(handoff.accountId, a)))[0]!;
    const base = h.completedAt!.getTime();
    const row = (i: number, over: Partial<typeof activity.$inferInsert>) => ({
      id: newId('cac'),
      tenantId: w.tenantId,
      accountId: a,
      handoffId: h.id,
      system: 'hubspot',
      externalId: `who-${a}-${i}`,
      kind: 'email',
      occurredAt: new Date(base + (i + 1) * 60_000),
      ...over,
    });
    const pat = { externalId: 'c-pat', name: 'Pat Lee' };
    await adminDb.insert(activity).values([
      row(0, { kind: 'email', actorOwnerExternalId: `mock-${seller}`, contacts: [pat], subject: 'Pilot scope' }),
      row(1, { kind: 'reply', contacts: [pat], subject: 'Re: Pilot scope' }),
      row(2, { kind: 'meeting', status: 'scheduled', startAt: new Date('2099-11-18T15:00:00Z'), endAt: new Date('2099-11-18T16:00:00Z'), contacts: [pat] }),
    ]);
    before = handoffPackageProvider();
    registerHandoffPackageProvider({
      package: async () => null,
      planTasks: async () => ({ planId: 'apl_who', playbookName: 'Logistics intro', startedAt, otherPlans: [] }) as never,
    });
  });
  // Put back the provider compose registered, not the default.
  afterAll(() => registerHandoffPackageProvider(before));

  it('names the seller on their email, the contact on a reply, and Scout on its own rows', async () => {
    const body = await json(w.as(leader, getActivity, `accounts/${a}/activity`));
    const by = (summary: string) => body.data.find((r: { summary: string }) => r.summary === summary);
    expect(by('Sent "Pilot scope" to Pat Lee')).toMatchObject({ kind: 'email', who: 'Sam Seller', actor: 'person' });
    expect(by('Replied: "Re: Pilot scope"')).toMatchObject({ kind: 'reply', who: 'Pat Lee', actor: 'contact' });
    expect(body.data.find((r: { id: string }) => r.id === `${h.id}:sent`)).toMatchObject({ who: 'Scout', actor: 'scout' });
    expect(by('Started the Logistics intro playbook')).toEqual({ id: 'apl_who:started', kind: 'scout', at: startedAt, who: 'Scout', actor: 'scout', summary: 'Started the Logistics intro playbook' });
  });

  it('puts a meeting at its start and words it as booked', async () => {
    const body = await json(w.as(leader, getActivity, `accounts/${a}/activity`));
    expect(body.data[0]).toMatchObject({ kind: 'meeting', at: '2099-11-18T15:00:00.000Z', summary: 'Meeting booked for Nov 18 with Pat Lee' });
  });

  it('never carries a body', async () => {
    const body = await json(w.as(leader, getActivity, `accounts/${a}/activity`));
    for (const r of body.data) expect(Object.keys(r).sort()).toEqual(['actor', 'at', 'id', 'kind', 'summary', 'who']);
  });
});

describe('GET /accounts/{id}/engagement (R2d Ruling 7)', () => {
  let a: string;

  beforeAll(async () => {
    const arrivalId = newId('arr');
    const mail = (n: string) => `${n}.${newId('acc').slice(-6).toLowerCase()}@engage.example`;
    ({ accountId: a } = await w.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId,
        receivedAt: new Date(),
        sourceChain: {},
        account: { name: 'Engage Co', domain: `${newId('acc').slice(-10).toLowerCase()}-example.com` },
        people: [
          { firstName: 'Ana', lastName: 'Met', email: mail('ana'), roleKeys: ['business_owner'] },
          { firstName: 'Ben', lastName: 'Replied', email: mail('ben'), roleKeys: ['technical_buyer'] },
          { firstName: 'Cy', lastName: 'Emailed', email: mail('cy') },
          { firstName: 'Dee', lastName: 'Unlinked', email: mail('dee') },
        ],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    ));
    await resolved(w.tenant, a, { arrivalId, resolution: 'created' });
    const res = await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller });
    if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
    await w.deliver();
  });

  it('engagement lists each committee person', async () => {
    const co = (await adminDb.select().from(handoff).where(eq(handoff.accountId, a)))[0]!.companyExternalId!;
    const people = await w.run((ctx) => listPeople(ctx, a));
    const id = (first: string) => people.find((p) => p.firstName === first)!.id;
    const links = await adminDb.select().from(link).where(and(eq(link.tenantId, w.tenantId), eq(link.scoutType, 'person')));
    const contact = (first: string) => links.find((l) => l.scoutId === id(first))!.externalId;
    await adminDb.delete(link).where(and(eq(link.tenantId, w.tenantId), eq(link.scoutType, 'person'), eq(link.scoutId, id('Dee'))));
    const now = new Date();
    const next = new Date(now.getTime() + 5 * 86_400_000);
    await w.run(async (ctx) => {
      await mockAddActivity(ctx, { companyExternalId: co, kind: 'email', contactExternalIds: [contact('Ana'), contact('Ben'), contact('Cy')] });
      await mockAddActivity(ctx, { companyExternalId: co, kind: 'meeting', occurredAt: now, startAt: now, endAt: now, status: 'held', contactExternalIds: [contact('Ana')] });
      await mockAddActivity(ctx, { companyExternalId: co, kind: 'reply', contactExternalIds: [contact('Ben')] });
      await mockAddActivity(ctx, { companyExternalId: co, kind: 'meeting', occurredAt: next, startAt: next, endAt: next, status: 'scheduled', subject: 'Scoping call' });
    });
    await w.run((ctx) => syncAccount(ctx, a, new Date()));
    const body = await json(w.as(leader, getEngagement, `accounts/${a}/engagement`));
    const state = (first: string) => body.people.find((p: { person_id: string }) => p.person_id === id(first));
    expect(state('Ana')).toEqual({ person_id: id('Ana'), state: 'met', at: now.toISOString() });
    expect(state('Ben')).toMatchObject({ state: 'replied', at: expect.any(String) });
    expect(state('Cy')).toMatchObject({ state: 'emailed' });
    expect(state('Dee')).toEqual({ person_id: id('Dee'), state: 'not_contacted', at: null });
    expect(body).toMatchObject({ engaged: 2, total: 4, gap_role: 'Commercial buyer' });
    const handoffs = await json(w.as(leader, getHandoffs, `accounts/${a}/handoffs`));
    expect(handoffs.follow_through).toMatchObject({ meetings_held: 1, next_meeting: { at: next.toISOString(), with: 'Scoping call' } });
  });

  it('engagement is 404 for an account the caller cannot see', async () => {
    const none = await keyFor(w.tenant, ['playbooks:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getEngagement, none, `accounts/${a}/engagement`)).status).toBe(403);
    expect((await w.as(leader, getEngagement, `accounts/${otherAccount}/engagement`)).status).toBe(404);
    const limited = await w.person('seller', { name: 'Lou Limited', dataLimit: { kind: 'own_accounts' } });
    expect((await w.as(limited, getEngagement, `accounts/${a}/engagement`)).status).toBe(404);
    expect((await w.as(seller, getEngagement, `accounts/${a}/engagement`)).status).toBe(200);
  });
});
