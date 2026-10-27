import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { GET as listAccounts } from '@/app/v1/accounts/route';
import { GET as getAccountRoute, PATCH as patchAccount } from '@/app/v1/accounts/[id]/route';
import { GET as listPeopleRoute, POST as addPerson } from '@/app/v1/accounts/[id]/people/route';
import { POST as addSignal } from '@/app/v1/accounts/[id]/signals/route';
import { GET as getFacts } from '@/app/v1/accounts/[id]/facts/route';
import { GET as accountArrivals } from '@/app/v1/accounts/[id]/arrivals/route';
import { PATCH as patchPerson } from '@/app/v1/people/[id]/route';
import { mergeAccounts, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { fact, person } from '@/modules/accounts/db/schema';
import { SYSTEM_GRANTOR, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { call, personAndAgent } from './intake-helpers';

const READ: Permission[] = ['accounts:read', 'arrivals:read'];
const WRITE: Permission[] = [...READ, 'accounts:write', 'people:write', 'signals:write'];

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;
let ownerCookie: string;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
let writeKey: string;
let writeKeyWithPeople: string;
let boKey: string;

const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(tenantId, owner.actor, fn);
const keyFor = async (scopes: Permission[], sourceId: string) =>
  (await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes, sourceId }, SYSTEM_GRANTOR))).secret;

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;
const arrivalFor = (agentSourceId: string, over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts => ({
  arrivalId: newId('arr'),
  receivedAt: new Date('2026-10-26T15:00:00Z'),
  sourceChain: { agentSourceId },
  account: { name: 'Seed Co', domain: domain() },
  people: [],
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
  ...over,
});
const seed = (agentId: string, over: Partial<ArrivalForAccounts> = {}) =>
  run((ctx) => upsertFromArrival(ctx, arrivalFor(agentId, over)));

/** A cookie-signed-in request, as the web app would send it. */
const asOwner = (
  handler: (r: Request) => Promise<Response>,
  path: string,
  method: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://localhost:4240/v1/${path}`, {
      method,
      headers: {
        cookie: ownerCookie,
        'x-scout-tenant': slug,
        origin: 'http://localhost:4240',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'Acc Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  await runOutbox(tenantId); // tenant defaults: buying roles, exclusion rules
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: owner.id }),
    }),
    { enabled: true },
  );
  ownerCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
  const t2 = { tenantId, actor: owner.actor, run };
  ash = await personAndAgent(t2 as never, 'Ash');
  bo = await personAndAgent(t2 as never, 'Bo');
  writeKey = await keyFor(WRITE, ash.agentId);
  writeKeyWithPeople = await keyFor([...WRITE, 'people:read'], ash.agentId);
  boKey = await keyFor(WRITE, bo.agentId);
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const factsOf = (accountId: string, key: string, personId?: string) =>
  run(async (ctx) =>
    (await ctx.tx.select().from(fact).where(eq(fact.accountId, accountId))).filter(
      (f) => f.key === key && (personId ? f.personId === personId : !f.personId),
    ),
  );

describe('POST /v1/accounts/{id}/people', () => {
  it('ACC-E1-S4-AC1: returns the person_id in the same response, with 201', async () => {
    const acc = await seed(ash.agentId);
    const res = await call(addPerson, writeKey, `accounts/${acc.accountId}/people`, {
      body: { name: 'Pat Lee', title: 'CTO', email: 'pat@seedco.example.com' },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ arrival_id: expect.stringMatching(/^arr_/), person_id: expect.stringMatching(/^per_/), already_known: false });
  });

  it('ACC-E1-S4-AC2: a repeat returns the same id with already_known', async () => {
    const acc = await seed(ash.agentId);
    const body = { name: 'Sam Roe', email: 'sam@seedco.example.com' };
    const first = await (await call(addPerson, writeKey, `accounts/${acc.accountId}/people`, { body })).json();
    const again = await call(addPerson, writeKey, `accounts/${acc.accountId}/people`, { body });
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ person_id: first.person_id, already_known: true });
  });

  it('ACC-E1-S4-AC4: an agent that cannot see the account gets 404', async () => {
    const acc = await seed(ash.agentId);
    const res = await call(addPerson, boKey, `accounts/${acc.accountId}/people`, { body: { name: 'Nope' } });
    expect(res.status).toBe(404);
  });

  it('answers 422 when the account is excluded, keeping what the service reports', async () => {
    const d = domain();
    const acc = await seed(ash.agentId, { account: { name: 'Excluded Co', domain: d, industryKey: 'software' } });
    const res = await call(addPerson, writeKey, `accounts/${acc.accountId}/people`, { body: { name: 'Ex Person', email: `ex@${d}` } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 'rejected', reason: 'excluded' });
  });

  it('needs people:write', async () => {
    const acc = await seed(ash.agentId);
    const readOnly = await keyFor(READ, ash.agentId);
    expect((await call(addPerson, readOnly, `accounts/${acc.accountId}/people`, { body: { name: 'X' } })).status).toBe(403);
  });
});

describe('POST /v1/accounts/{id}/signals', () => {
  const signal = { type: 'trigger', title: 'Hired a new CIO', occurred_at: '2026-10-01', url: 'https://news.example.com/cio' };

  it('ACC-E4-S3-AC1: returns a signal id, and a repeat returns the existing id', async () => {
    const acc = await seed(ash.agentId);
    const res = await call(addSignal, writeKey, `accounts/${acc.accountId}/signals`, { body: signal });
    expect(res.status).toBe(201);
    const first = await res.json();
    expect(first).toEqual({ arrival_id: expect.stringMatching(/^arr_/), signal_id: expect.stringMatching(/^sig_/), already_known: false });
    const again = await (await call(addSignal, writeKey, `accounts/${acc.accountId}/signals`, { body: signal })).json();
    expect(again).toMatchObject({ signal_id: first.signal_id, already_known: true });
  });

  it('ACC-E4-S3-AC2: no occurred_at is a 400 with the copy; no url is a 201 with a warning', async () => {
    const acc = await seed(ash.agentId);
    const { occurred_at: _omit, ...undated } = signal;
    const bad = await call(addSignal, writeKey, `accounts/${acc.accountId}/signals`, { body: undated });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('Add the date it happened.');
    const { url: _url, ...noLink } = signal;
    const ok = await call(addSignal, writeKey, `accounts/${acc.accountId}/signals`, { body: { ...noLink, title: 'No link signal' } });
    expect(ok.status).toBe(201);
    expect((await ok.json()).warning).toBe('A source link is strongly recommended.');
  });
});

describe('reads', () => {
  it('lists accounts within the key data limit', async () => {
    const mine = await seed(ash.agentId, { account: { name: 'Findable Mine', domain: domain() } });
    const theirs = await seed(bo.agentId, { account: { name: 'Findable Theirs', domain: domain() } });
    const { data, next_cursor } = await (await call(listAccounts, writeKey, 'accounts?q=Findable')).json();
    expect(next_cursor).toBeNull();
    const ids = data.map((a: { account_id: string }) => a.account_id);
    expect(ids).toContain(mine.accountId);
    expect(ids).not.toContain(theirs.accountId);
  });

  it('ACC-E5-S1-AC3: an account merged away answers with the survivor and merged_into', async () => {
    const keep = await seed(ash.agentId, { account: { name: 'Keeper', domain: domain() } });
    const gone = await seed(ash.agentId, { account: { name: 'Goner', domain: domain() } });
    await run((ctx) => mergeAccounts({ ...ctx, access: { userId: owner.id, dataLimit: { kind: 'all' } } }, keep.accountId, gone.accountId));
    const res = await call(getAccountRoute, writeKey, `accounts/${gone.accountId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: keep.accountId, merged_into: keep.accountId });
    expect((await call(getAccountRoute, boKey, `accounts/${keep.accountId}`)).status).toBe(404);
  });

  it('TEN-E3-S3-AC1: without people:read a person has no email, phone, mobile_phone or linkedin_url', async () => {
    const acc = await seed(ash.agentId, {
      people: [{ firstName: 'Cy', lastName: 'Dee', title: 'CFO', email: 'cy@seedco.example.com', phone: '1', mobilePhone: '2', linkedinUrl: 'https://linkedin.com/in/cy' }],
    });
    const hidden = (await (await call(listPeopleRoute, writeKey, `accounts/${acc.accountId}/people`)).json()).data[0];
    expect(hidden).toMatchObject({ first_name: 'Cy', title: 'CFO' });
    for (const k of ['email', 'phone', 'mobile_phone', 'linkedin_url']) expect(hidden).not.toHaveProperty(k);
    const onAccount = (await (await call(getAccountRoute, writeKey, `accounts/${acc.accountId}`)).json()).people[0];
    expect(onAccount).not.toHaveProperty('email');
    const factKeys = (await (await call(getFacts, writeKey, `accounts/${acc.accountId}/facts?include=history`)).json()).data.map((f: { key: string }) => f.key);
    expect(factKeys).not.toContain('email');
    expect(factKeys).toContain('title');

    const shown = (await (await call(listPeopleRoute, writeKeyWithPeople, `accounts/${acc.accountId}/people`)).json()).data[0];
    expect(shown).toMatchObject({ email: 'cy@seedco.example.com', phone: '1', mobile_phone: '2', linkedin_url: 'https://linkedin.com/in/cy' });
  });

  it('ACC-E3-S1-AC2: facts with include=history return superseded values, filtered by field', async () => {
    const acc = await seed(ash.agentId, { account: { name: 'Old Name', domain: domain() } });
    await call(patchAccount, writeKey, `accounts/${acc.accountId}`, { method: 'PATCH', body: { name: 'New Name' } });
    const current = (await (await call(getFacts, writeKey, `accounts/${acc.accountId}/facts?field=name`)).json()).data;
    const history = (await (await call(getFacts, writeKey, `accounts/${acc.accountId}/facts?field=name&include=history`)).json()).data;
    expect(history.length).toBeGreaterThan(current.length);
    expect(history.every((f: { key: string }) => f.key === 'name')).toBe(true);
    expect(history.map((f: { value: string }) => f.value)).toEqual(expect.arrayContaining(['Old Name', 'New Name']));
    expect(history[0]).toHaveProperty('source_chain');
  });

  it('lists the arrivals that touched an account', async () => {
    const acc = await seed(ash.agentId);
    const sent = await (await call(addSignal, writeKey, `accounts/${acc.accountId}/signals`, {
      body: { type: 'trigger', title: 'Arrival listed', occurred_at: '2026-10-02', url: 'https://x.example.com' },
    })).json();
    const { data } = await (await call(accountArrivals, writeKey, `accounts/${acc.accountId}/arrivals`)).json();
    expect(data.map((a: { id: string }) => a.id)).toContain(sent.arrival_id);
    expect((await call(accountArrivals, boKey, `accounts/${acc.accountId}/arrivals`)).status).toBe(404);
  });
});

describe('Ruling 9: PATCH', () => {
  it('a key sends an inline targeted arrival with facts and leaves the fact unpinned', async () => {
    const acc = await seed(ash.agentId, { account: { name: 'Patch Co', domain: domain() } });
    const res = await call(patchAccount, writeKey, `accounts/${acc.accountId}`, { method: 'PATCH', body: { description: 'Makes pumps' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ arrival_id: expect.stringMatching(/^arr_/), status: 'resolved' });
    const [f] = await factsOf(acc.accountId, 'description');
    expect(f).toMatchObject({ value: 'Makes pumps', arrivalId: body.arrival_id, agentSourceId: ash.agentId, pinnedAt: null });
  });

  it('a person pins the fact', async () => {
    const acc = await seed(ash.agentId, { account: { name: 'Pin Co', domain: domain() } });
    const res = await asOwner(patchAccount, `accounts/${acc.accountId}`, 'PATCH', { description: 'Pinned text' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: acc.accountId, description: 'Pinned text' });
    const [f] = await factsOf(acc.accountId, 'description');
    expect(f).toMatchObject({ value: 'Pinned text', pinnedBy: owner.id, arrivalId: null });
    expect(f!.pinnedAt).not.toBeNull();
  });

  it('refuses an unknown or empty patch with 400', async () => {
    const acc = await seed(ash.agentId);
    expect((await call(patchAccount, writeKey, `accounts/${acc.accountId}`, { method: 'PATCH', body: { is_shell: true } })).status).toBe(400);
    expect((await call(patchAccount, writeKey, `accounts/${acc.accountId}`, { method: 'PATCH', body: {} })).status).toBe(400);
  });

  it('PATCH /people/{id} by a key puts the facts on that person, and a changed email updates it', async () => {
    const acc = await seed(ash.agentId, { people: [{ firstName: 'Ed', lastName: 'Fox', title: 'VP', email: 'ed@seedco.example.com' }] });
    const [p] = await run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, acc.accountId)));
    const res = await call(patchPerson, writeKey, `people/${p!.id}`, {
      method: 'PATCH',
      body: { email: 'ed.fox@seedco.example.com', title: 'SVP' },
    });
    expect(res.status).toBe(200);
    const after = await run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, acc.accountId)));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: p!.id, email: 'ed.fox@seedco.example.com', title: 'SVP' });
    const f = (await factsOf(acc.accountId, 'title', p!.id)).find((x) => x.value === 'SVP');
    expect(f).toMatchObject({ pinnedAt: null, agentSourceId: ash.agentId });
    expect((await call(patchPerson, writeKey, `people/${p!.id}`, { method: 'PATCH', body: { role_keys: ['x'] } })).status).toBe(400);
    expect((await call(patchPerson, boKey, `people/${p!.id}`, { method: 'PATCH', body: { title: 'x' } })).status).toBe(404);
  });

  it('PATCH /people/{id} by a person pins the fact', async () => {
    const acc = await seed(ash.agentId, { people: [{ firstName: 'Gia', lastName: 'Hu', title: 'Dir', email: 'gia@seedco.example.com' }] });
    const [p] = await run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, acc.accountId)));
    const res = await asOwner(patchPerson, `people/${p!.id}`, 'PATCH', { title: 'Chief of Staff' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: p!.id, title: 'Chief of Staff' });
    const f = (await factsOf(acc.accountId, 'title', p!.id)).find((x) => x.value === 'Chief of Staff');
    expect(f).toMatchObject({ pinnedBy: owner.id });
  });
});
