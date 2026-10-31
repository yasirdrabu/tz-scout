import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { PATCH as patchSource } from '@/http/routes/v1/sources/[id]/route';
import { GET as listMappingsRoute } from '@/http/routes/v1/sources/[id]/mappings/route';
import { DELETE as deleteMappingRoute } from '@/http/routes/v1/sources/[id]/mappings/[mappingId]/route';
import { GET as waitingRoute } from '@/http/routes/v1/waiting/route';
import { POST as arrivalAction } from '@/http/routes/v1/arrivals/[id]/route';
import { POST as batchAction } from '@/http/routes/v1/batches/[id]/route';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { PUT as putPractices } from '@/http/routes/v1/accounts/[id]/practices/route';
import { DELETE as deleteOverride } from '@/http/routes/v1/accounts/[id]/exclusion-override/route';
import { POST as signalAction } from '@/http/routes/v1/signals/[id]/route';
import { GET as getExclusions } from '@/http/routes/v1/settings/exclusions/route';
import { PUT as putRule } from '@/http/routes/v1/settings/exclusions/rules/[key]/route';
import { PUT as putList } from '@/http/routes/v1/settings/exclusions/lists/[kind]/route';
import { GET as getWarmIntros } from '@/http/routes/v1/settings/warm-intros/route';
import { PUT as putWarmIntro } from '@/http/routes/v1/settings/warm-intros/[key]/route';
import { getAccount, getSignals, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { listMappings, saveMapping, submitBatch } from '@/modules/intake';
import { archivePractice, createPractice } from '@/modules/offers';
import { arrival } from '@/modules/intake/db/schema';
import { SYSTEM_GRANTOR, addMember, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { asSource, personAndAgent } from '../intake/helpers';

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;
let cookies: Record<'owner' | 'operator' | 'seller' | 'admin', string>;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(tenantId, owner.actor, fn);

async function signIn(userId: string): Promise<string> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  return res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
}

/** A cookie-signed-in request with the same-site headers the web app sends. */
const as = (who: keyof typeof cookies, handler: (r: Request) => Promise<Response>, path: string, method: string, body?: unknown) =>
  handler(
    new Request(`http://localhost:4240/api/v1/${path}`, {
      method,
      headers: {
        cookie: cookies[who],
        'x-scout-tenant': slug,
        origin: 'http://localhost:4240',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const seedAccount = async (over: Partial<ArrivalForAccounts> = {}) =>
  (
    await run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('arr'),
        receivedAt: new Date('2026-10-26T15:00:00Z'),
        sourceChain: { agentSourceId: ash.agentId },
        account: { name: 'Seed Co', domain: domain(), industryKey: 'logistics' },
        people: [],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
        ...over,
      }),
    )
  ).accountId;

async function member(role: 'operator' | 'seller') {
  const u = await seedUser({ signedIn: true });
  await run((ctx) => addMember(ctx, { email: u.email, role }));
  return signIn(u.id);
}

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'People Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  await runOutbox(tenantId);
  cookies = { owner: await signIn(owner.id), operator: await member('operator'), seller: await member('seller'), admin: await signIn(admin.id) };
  ash = await personAndAgent({ tenantId, actor: owner.actor, run } as never, 'Ash');
  bo = await personAndAgent({ tenantId, actor: owner.actor, run } as never, 'Bo');
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('sources', () => {
  it('an operator pauses and resumes a source; a seller gets 403', async () => {
    const res = await as('operator', patchSource, `sources/${ash.agentId}`, 'PATCH', { status: 'paused', daily_arrival_cap: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ash.agentId, status: 'paused', daily_arrival_cap: 40 });
    expect((await as('operator', patchSource, `sources/${ash.agentId}`, 'PATCH', { status: 'active' })).status).toBe(200);
    expect((await as('seller', patchSource, `sources/${ash.agentId}`, 'PATCH', { status: 'paused' })).status).toBe(403);
    const key = (await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['sources:manage'], sourceId: ash.agentId }, SYSTEM_GRANTOR))).secret;
    const viaKey = await patchSource(
      new Request(`http://x/api/v1/sources/${ash.agentId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
    );
    expect(viaKey.status).toBe(403);
  });

  it('lists and deletes saved mappings; a seller gets 403', async () => {
    const saved = await run((ctx) =>
      saveMapping(ctx, { sourceId: ash.personId, headers: ['Org', 'Site'], mapping: [{ header: 'Org', target: 'account.name', confidence: 1, reason: 'x' }] }),
    );
    const list = await as('operator', listMappingsRoute, `sources/${ash.personId}/mappings`, 'GET');
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((m: { id: string }) => m.id)).toContain(saved.id);
    expect((await as('seller', listMappingsRoute, `sources/${ash.personId}/mappings`, 'GET')).status).toBe(403);
    expect((await as('seller', deleteMappingRoute, `sources/${ash.personId}/mappings/${saved.id}`, 'DELETE')).status).toBe(403);
    expect((await as('operator', deleteMappingRoute, `sources/${ash.personId}/mappings/${saved.id}`, 'DELETE')).status).toBe(204);
    expect((await as('operator', deleteMappingRoute, `sources/${ash.personId}/mappings/${saved.id}`, 'DELETE')).status).toBe(404);
  });
});

describe('saved mappings and the data limit', () => {
  it("a key limited to its own source cannot list or delete another source's mappings", async () => {
    const theirs = await run((ctx) =>
      saveMapping(ctx, { sourceId: bo.personId, headers: ['Firm', 'Url'], mapping: [{ header: 'Firm', target: 'account.name', confidence: 1, reason: 'x' }] }),
    );
    const key = (
      await run((ctx) =>
        createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['imports:run'], sourceId: ash.agentId, dataLimit: { kind: 'own_source' } }, SYSTEM_GRANTOR),
      )
    ).secret;
    const send = (handler: (r: Request) => Promise<Response>, path: string, method: string) =>
      handler(new Request(`http://x/api/v1/${path}`, { method, headers: { authorization: `Bearer ${key}` } }));
    expect((await send(listMappingsRoute, `sources/${bo.personId}/mappings`, 'GET')).status).toBe(404);
    expect((await send(deleteMappingRoute, `sources/${bo.personId}/mappings/${theirs.id}`, 'DELETE')).status).toBe(404);
    expect((await send(deleteMappingRoute, `sources/${ash.agentId}/mappings/${theirs.id}`, 'DELETE')).status).toBe(404);
    expect((await send(deleteMappingRoute, 'sources/%zz/mappings/x', 'DELETE')).status).toBe(404);
    expect(await run((ctx) => listMappings(ctx, bo.personId))).toHaveLength(1);
    expect((await send(listMappingsRoute, `sources/${ash.agentId}/mappings`, 'GET')).status).toBe(200);
  });
});

describe('waiting arrivals', () => {
  const waiting = async (item: unknown) => {
    const out = await asSource({ tenantId, actor: owner.actor, run } as never, ash.agentId, (ctx) =>
      submitBatch(ctx, { name: `Run ${newId('bat')}`, items: [item] }, { channel: 'webhook' }),
    );
    await runOutbox(tenantId);
    return { batchId: out.batchId, id: out.items[0]!.arrivalId };
  };

  it('chooses a duplicate: new_company and same_as a candidate both succeed', async () => {
    const duplicate = async (label: string, city: string, firm: string) => {
      const stem = `${label}${Date.now().toString(36)}`;
      const existing = await seedAccount({ account: { name: `${stem} ${firm}s`, hqCountry: 'US', hqState: 'FL', hqCity: 'Tampa' } as never });
      const w = await waiting({ account: { name: `${stem} ${firm}`, domain: domain(), country: 'US', region: 'FL', city } });
      return { existing, id: w.id };
    };
    // Both arrivals wait before either is answered, so the account one creates can't change the other's candidates.
    const a = await duplicate('NewCo', 'Orlando', 'Harborview Capital Partner');
    const b = await duplicate('SameAs', 'Orlando', 'Westbrook Equity Partner');
    expect((await as('operator', arrivalAction, `arrivals/${a.id}:choose`, 'POST', { new_company: true })).status).toBe(200);
    expect((await as('operator', arrivalAction, `arrivals/${b.id}:choose`, 'POST', { same_as: b.existing })).status).toBe(200);
    await runOutbox(tenantId);
    const rows = await run((ctx) => ctx.tx.select().from(arrival).where(inArray(arrival.id, [a.id, b.id])));
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'resolved']);
  });

  it('lists the waiting list, and supplies a website', async () => {
    const { id } = await waiting({ account: { name: 'Needs A Site' } });
    const list = await as('operator', waitingRoute, 'waiting?reason=needs_website', 'GET');
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((a: { id: string }) => a.id)).toContain(id);
    expect((await as('seller', waitingRoute, 'waiting', 'GET')).status).toBe(403);

    expect((await as('seller', arrivalAction, `arrivals/${id}:supply-website`, 'POST', { website: 'acme.com' })).status).toBe(403);
    const res = await as('operator', arrivalAction, `arrivals/${id}:supply-website`, 'POST', { website: `https://${domain()}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id });
  });

  it('supplies a company, as a name or as a sole proprietor', async () => {
    const named = await waiting({ people: [{ name: 'Pat Personal', email: `pat${Date.now()}@gmail.com` }] });
    expect((await as('seller', arrivalAction, `arrivals/${named.id}:supply-company`, 'POST', { name: 'Pat Studio' })).status).toBe(403);
    expect((await as('operator', arrivalAction, `arrivals/${named.id}:supply-company`, 'POST', { name: 'Pat Studio' })).status).toBe(200);
    const solo = await waiting({ people: [{ email: `solo${Date.now()}@gmail.com` }] });
    const res = await as('operator', arrivalAction, `arrivals/${solo.id}:supply-company`, 'POST', { sole_proprietor: true, person_name: 'Nora Nameless' });
    expect(res.status).toBe(200);
  });

  it('chooses a duplicate: a seller gets 403, a bad body 400, an unknown action 404', async () => {
    const { id } = await waiting({ account: { name: 'Choose Me' } });
    expect((await as('seller', arrivalAction, `arrivals/${id}:choose`, 'POST', { new_company: true })).status).toBe(403);
    expect((await as('operator', arrivalAction, `arrivals/${id}:choose`, 'POST', {})).status).toBe(400);
    // Waiting for a website, not a duplicate: the operator reaches the service, which refuses with 409.
    expect((await as('operator', arrivalAction, `arrivals/${id}:choose`, 'POST', { new_company: true })).status).toBe(409);
    expect((await as('operator', arrivalAction, `arrivals/${id}:nope`, 'POST', {})).status).toBe(404);
  });

  it("skips a batch's waiting items and names the person", async () => {
    const { batchId, id } = await waiting({ account: { name: 'Skip Me' } });
    expect((await as('seller', batchAction, `batches/${batchId}:skip-waiting`, 'POST')).status).toBe(403);
    const res = await as('owner', batchAction, `batches/${batchId}:skip-waiting`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 1 });
    const [row] = await run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, id)));
    expect(row).toMatchObject({ status: 'rejected', rejectReason: 'invalid', rejectDetail: `Skipped by ${owner.email.split('@')[0]}.` });
  });
});

describe('accounts', () => {
  it('merges: a person succeeds, an API key gets the people-only copy', async () => {
    const keep = await seedAccount();
    const gone = await seedAccount();
    const key = (
      await run((ctx) =>
        createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['accounts:write', 'accounts:read'], sourceId: ash.agentId }, SYSTEM_GRANTOR),
      )
    ).secret;
    const viaKey = await accountAction(
      new Request(`http://x/api/v1/accounts/${keep}:merge`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ merged_id: gone }),
      }),
    );
    expect(viaKey.status).toBe(403);
    expect(JSON.stringify(await viaKey.json())).toContain('Only a person can merge accounts.');

    const res = await as('owner', accountAction, `accounts/${keep}:merge`, 'POST', { merged_id: gone });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: keep });
    expect((await run((ctx) => getAccount(ctx, gone)))?.mergedInto).toBe(keep);
  });

  it('sets practices', async () => {
    const id = await seedAccount();
    const a = (await run((ctx) => createPractice(ctx, { name: `P ${newId('prc')}` }))).id;
    const b = (await run((ctx) => createPractice(ctx, { name: `Q ${newId('prc')}` }))).id;
    const gone = (await run((ctx) => createPractice(ctx, { name: `R ${newId('prc')}` }))).id;
    await run((ctx) => archivePractice(ctx, gone));
    const res = await as('owner', putPractices, `accounts/${id}/practices`, 'PUT', { practice_ids: [a, b] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ practice_ids: [a, b] });
    for (const bad of ['prc_nope', gone]) {
      const refused = await as('owner', putPractices, `accounts/${id}/practices`, 'PUT', { practice_ids: [bad] });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain('Pick practices from your practice list.');
    }
    expect((await as('owner', putPractices, `accounts/${id}/practices`, 'PUT', { practice_ids: 'x' })).status).toBe(400);
    expect((await as('operator', putPractices, `accounts/${id}/practices`, 'PUT', { practice_ids: [] })).status).toBe(200);
  });

  it('pins a primary person', async () => {
    const id = await seedAccount({ people: [{ name: 'Pat Lee', email: 'pat@seedco.example.com', title: 'CTO' }] as never });
    const personId = (await run((ctx) => getAccount(ctx, id)))!.people[0]!.id;
    const res = await as('owner', accountAction, `accounts/${id}:pin-primary`, 'POST', { person_id: personId });
    expect(res.status).toBe(200);
    expect((await as('owner', accountAction, `accounts/${id}:pin-primary`, 'POST', { person_id: 'per_missing' })).status).toBe(404);
  });

  it('archives a signal', async () => {
    const id = await seedAccount({
      signals: [{ kind: 'trigger', type: 'trigger', title: 'Hired a CIO', occurredAt: new Date('2026-10-01'), url: 'https://n.example.com/cio' }] as never,
    });
    const signalId = (await run((ctx) => getSignals(ctx, id)))[0]!.id;
    const res = await as('owner', signalAction, `signals/${signalId}:archive`, 'POST', { reason: 'Not relevant' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: signalId, title: 'Hired a CIO', archived_at: expect.any(String) });
    expect(await run((ctx) => getSignals(ctx, id))).toHaveLength(0);
    expect((await as('owner', signalAction, 'signals/sig_missing:archive', 'POST', {})).status).toBe(404);
  });

  it('overrides an exclusion with a note, then removes the override', async () => {
    const id = await seedAccount({ account: { name: 'Excluded Co', domain: domain(), industryKey: 'software' } });
    expect((await as('owner', accountAction, `accounts/${id}:override-exclusion`, 'POST', {})).status).toBe(400);
    const res = await as('owner', accountAction, `accounts/${id}:override-exclusion`, 'POST', { note: 'Big reseller deal' });
    expect(res.status).toBe(200);
    expect((await as('seller', deleteOverride, `accounts/${id}/exclusion-override`, 'DELETE')).status).toBe(404);
    expect((await as('owner', deleteOverride, `accounts/${id}/exclusion-override`, 'DELETE')).status).toBe(204);
    const [row] = await run((ctx) => ctx.tx.select().from(account).where(eq(account.id, id)));
    expect(row!.excludedOverride).toBe(false);
  });

  it('converts a shell', async () => {
    const id = await seedAccount({ account: {} as never, soleProprietor: true, people: [{ firstName: 'Sam', lastName: 'Solo', email: `sam@${domain()}` }] as never });
    const d = domain();
    const res = await as('owner', accountAction, `accounts/${id}:convert-shell`, 'POST', { name: 'Pat Studio', domain: d });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Pat Studio', domain: d });
    // Not a shell any more.
    expect((await as('owner', accountAction, `accounts/${id}:convert-shell`, 'POST', { name: 'Again', domain: domain() })).status).toBe(409);
    // A seller who cannot see the account gets 404.
    const hidden = await seedAccount({ account: {} as never, soleProprietor: true, people: [{ firstName: 'Hid', lastName: 'Den', email: `hid@${domain()}` }] as never });
    expect((await as('seller', accountAction, `accounts/${hidden}:convert-shell`, 'POST', { name: 'X', domain: domain() })).status).toBe(404);
  });
});

describe('settings', () => {
  it('reads and changes exclusion rules and lists; only settings:manage', async () => {
    const res = await as('owner', getExclusions, 'settings/exclusions', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules.length).toBeGreaterThan(0);
    expect(body).toHaveProperty('lists');
    expect((await as('operator', getExclusions, 'settings/exclusions', 'GET')).status).toBe(403);

    const key = body.rules[0].key;
    const off = await as('owner', putRule, `settings/exclusions/rules/${key}`, 'PUT', { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ key, enabled: false });
    expect((await as('operator', putRule, `settings/exclusions/rules/${key}`, 'PUT', { enabled: true })).status).toBe(403);

    const list = await as('owner', putList, 'settings/exclusions/lists/parent_domain', 'PUT', { values: ['Big.example.com', 'big.example.com'] });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ kind: 'parent_domain', values: ['big.example.com'] });
    expect((await as('owner', putList, 'settings/exclusions/lists/nope', 'PUT', { values: [] })).status).toBe(400);
    expect((await as('operator', putList, 'settings/exclusions/lists/parent_domain', 'PUT', { values: [] })).status).toBe(403);
  });

  it('warm-intro defaults: a platform admin changes them; an owner who is not one gets the copy', async () => {
    const list = await as('owner', getWarmIntros, 'settings/warm-intros', 'GET');
    expect(list.status).toBe(403);
    expect(JSON.stringify(await list.json())).toContain('Only a platform admin can change these in this release.');

    const refused = await as('owner', putWarmIntro, 'settings/warm-intros/other', 'PUT', { points: 4 });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain('Only a platform admin can change these in this release.');

    const all = await as('admin', getWarmIntros, 'settings/warm-intros', 'GET');
    expect(all.status).toBe(200);
    expect((await all.json()).data.find((d: { relationship_key: string }) => d.relationship_key === 'other')).toMatchObject({ points: 3 });
    const ok = await as('admin', putWarmIntro, 'settings/warm-intros/other', 'PUT', { points: 4 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ relationship_key: 'other', points: 4 });
    expect((await as('admin', putWarmIntro, 'settings/warm-intros/other', 'PUT', { points: 21 })).status).toBe(400);
    expect((await as('admin', putWarmIntro, 'settings/warm-intros/nope', 'PUT', { points: 5 })).status).toBe(404);
  });
});
