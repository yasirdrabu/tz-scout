import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { v1Route } from '@/app/v1/_lib/v1-route';
import { sourceAccessProvider, sourceInfoProvider } from '@/modules/accounts';
import {
  childSources,
  listSources,
  personSourceFor,
  registerSource,
  updateSource,
} from '@/modules/intake';
import { arrival, relationshipDefault, source } from '@/modules/intake/db/schema';
import {
  SYSTEM_GRANTOR,
  addMember,
  createApiKey,
  createTenant,
  handleDevSignIn,
  setPrincipalCacheTtl,
} from '@/modules/tenancy';
import { apiKey, membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { schedule } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let currentHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => currentHeaders }));
const { tenantAction } = await import('@/server/page-context');

let t: Tenant;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const bad = (title: string) => expect.objectContaining({ status: 400, message: title });

describe('registerSource (SRC-E1-S1-AC1)', () => {
  it('creates a source of each kind with a name and the default cap and trust', async () => {
    const out = await t.run(async (ctx) => {
      const vendor = await registerSource(ctx, { kind: 'vendor', name: 'Lead list co' });
      const person = await registerSource(ctx, { kind: 'person', name: 'Mike' });
      return [
        vendor,
        person,
        await registerSource(ctx, { kind: 'agent', name: 'Mike agent', parentId: person.id }),
        await registerSource(ctx, { kind: 'partner', name: 'Partner firm' }),
        await registerSource(ctx, { kind: 'crm', name: 'HubSpot forms' }),
        await registerSource(ctx, { kind: 'web_form', name: 'Contact form' }),
        await registerSource(ctx, { kind: 'scheduled_pull', name: 'Logistics weekly', parentId: vendor.id }),
      ];
    });
    expect(out.map((s) => s.kind)).toEqual(['vendor', 'person', 'agent', 'partner', 'crm', 'web_form', 'scheduled_pull']);
    expect(out.every((s) => s.dailyArrivalCap === 500 && s.trust === 0.6 && s.status === 'active')).toBe(true);
    expect(out[2]!.parentId).toBe(out[1]!.id);
    expect(out[6]!.parentId).toBe(out[0]!.id);
  });

  it('needs an owner person for an agent and a vendor for a scheduled pull', async () => {
    const vendor = await t.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'V' }));
    const person = await t.run((ctx) => registerSource(ctx, { kind: 'person', name: 'P' }));
    const agentCopy = 'An agent needs an owner. Pick the person who runs it.';
    await expect(t.run((ctx) => registerSource(ctx, { kind: 'agent', name: 'A' }))).rejects.toEqual(bad(agentCopy));
    await expect(t.run((ctx) => registerSource(ctx, { kind: 'agent', name: 'A', parentId: vendor.id }))).rejects.toEqual(
      bad(agentCopy),
    );
    const pullCopy = 'A scheduled pull needs a vendor.';
    await expect(t.run((ctx) => registerSource(ctx, { kind: 'scheduled_pull', name: 'S' }))).rejects.toEqual(bad(pullCopy));
    await expect(
      t.run((ctx) => registerSource(ctx, { kind: 'scheduled_pull', name: 'S', parentId: person.id })),
    ).rejects.toEqual(bad(pullCopy));
  });

  it('links a person source to a tenant user, one per user (SRC-E1-S1-AC2)', async () => {
    const u = await seedUser();
    const s = await t.run((ctx) => registerSource(ctx, { kind: 'person', name: 'Andy', userId: u.id }));
    expect(s.userId).toBe(u.id);
    await expect(t.run((ctx) => registerSource(ctx, { kind: 'person', name: 'Andy again', userId: u.id }))).rejects.toEqual(
      bad('This person already has a source.'),
    );
    expect(await t.run((ctx) => personSourceFor(ctx, u.id))).toBe(s.id);
    expect(await t.run((ctx) => personSourceFor(ctx, 'usr_nobody'))).toBeUndefined();
  });

  it('creates a member person source on first use, once, and none for a non-member', async () => {
    const u = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
    expect(await t.run((ctx) => personSourceFor(ctx, u.id))).toBeUndefined();
    const first = await t.run((ctx) => sourceAccessProvider().personSourceFor(ctx, u.id));
    expect(first).toMatch(/^src_/);
    expect(await t.run((ctx) => sourceAccessProvider().personSourceFor(ctx, u.id))).toBe(first);
    expect(await t.run((ctx) => personSourceFor(ctx, u.id))).toBe(first);
    const outsider = await seedUser();
    expect(await t.run((ctx) => sourceAccessProvider().personSourceFor(ctx, outsider.id))).toBeUndefined();
  });
});

describe('starting review status (SRC-E1-S2-AC3)', () => {
  it('defaults by kind and can be changed', async () => {
    const keys = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'P' });
      const vendor = await registerSource(ctx, { kind: 'vendor', name: 'V' });
      const kinds = [
        person,
        await registerSource(ctx, { kind: 'agent', name: 'A', parentId: person.id }),
        vendor,
        await registerSource(ctx, { kind: 'partner', name: 'Pa' }),
        await registerSource(ctx, { kind: 'scheduled_pull', name: 'S', parentId: vendor.id }),
        await registerSource(ctx, { kind: 'crm', name: 'C' }),
        await registerSource(ctx, { kind: 'web_form', name: 'W' }),
      ];
      return Object.fromEntries(kinds.map((s) => [s.kind, s.initialReviewStatusKey]));
    });
    expect(keys).toEqual({
      person: 'needs_review',
      agent: 'unvetted',
      vendor: 'unvetted',
      partner: 'unvetted',
      scheduled_pull: 'unvetted',
      crm: 'needs_review',
      web_form: 'needs_review',
    });
    const changed = await t.run(async (ctx) => {
      const s = await registerSource(ctx, { kind: 'vendor', name: 'V2' });
      return updateSource(ctx, s.id, { initialReviewStatusKey: 'needs_review' });
    });
    expect(changed.initialReviewStatusKey).toBe('needs_review');
  });
});

describe('daily cap setting (SRC-E1-S2-AC1)', () => {
  it('can be set from 0 to 10,000', async () => {
    const s = await t.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'Capped' }));
    expect((await t.run((ctx) => updateSource(ctx, s.id, { dailyArrivalCap: 0 }))).dailyArrivalCap).toBe(0);
    expect((await t.run((ctx) => updateSource(ctx, s.id, { dailyArrivalCap: 10_000 }))).dailyArrivalCap).toBe(10_000);
    const copy = 'The daily limit must be between 0 and 10,000.';
    for (const cap of [-1, 10_001, 2.5]) {
      await expect(t.run((ctx) => updateSource(ctx, s.id, { dailyArrivalCap: cap }))).rejects.toEqual(bad(copy));
    }
    await expect(t.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'X', dailyArrivalCap: 10_001 }))).rejects.toEqual(
      bad(copy),
    );
  });

  it('gives 404 for a source that does not exist', async () => {
    await expect(t.run((ctx) => updateSource(ctx, 'src_missing', { name: 'x' }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('archiving', () => {
  it("revokes the source's keys, so a request with one gets 401", async () => {
    setPrincipalCacheTtl(0);
    const { agentId } = await personAndAgent(t);
    const { secret, id } = await t.run((ctx) =>
      createApiKey(ctx, { name: 'agent key', environment: 'live', scopes: ['arrivals:write'], sourceId: agentId }, SYSTEM_GRANTOR),
    );
    const route = v1Route({}, async () => ({ ok: true }));
    const call = () => route(new Request('http://x/v1/y', { headers: { authorization: `Bearer ${secret}` } }));
    expect((await call()).status).toBe(200);

    await t.run((ctx) => updateSource(ctx, agentId, { status: 'archived' }));
    const [row] = await adminDb.select().from(apiKey).where(eq(apiKey.id, id));
    expect(row!.revokedAt).not.toBeNull();
    expect((await call()).status).toBe(401);
  });

  it('is final: an archived source cannot be made active or paused again', async () => {
    const { agentId } = await personAndAgent(t);
    await t.run((ctx) => updateSource(ctx, agentId, { status: 'archived' }));
    for (const status of ['active', 'paused'] as const) {
      await expect(t.run((ctx) => updateSource(ctx, agentId, { status }))).rejects.toMatchObject({
        status: 409,
        message: "An archived source can't be reactivated. Create a new source.",
      });
    }
    expect((await t.run((ctx) => updateSource(ctx, agentId, { name: 'Renamed' }))).status).toBe('archived');
  });

  it('refuses new keys for an archived or unknown source', async () => {
    const { agentId } = await personAndAgent(t);
    await t.run((ctx) => updateSource(ctx, agentId, { status: 'archived' }));
    for (const sourceId of [agentId, 'src_unknown']) {
      await expect(
        t.run((ctx) =>
          createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['arrivals:write'], sourceId }, SYSTEM_GRANTOR),
        ),
      ).rejects.toMatchObject({ slug: 'source-not-found' });
    }
  });
});

describe('intake.tenant_defaults (SRC-E1-S1-AC4)', () => {
  it('registers the vendor sources, the relationship defaults and the expiry schedule', async () => {
    const vendors = await t.run((ctx) =>
      ctx.tx
        .select()
        .from(source)
        .where(and(eq(source.tenantId, ctx.tenantId), eq(source.name, 'Apollo'))),
    );
    expect(vendors).toHaveLength(1);
    const all = await t.run((ctx) => ctx.tx.select().from(source));
    const keyed = all
      .filter((s) => (s.settings as { key?: string }).key)
      .map((s) => [(s.settings as { key: string }).key, s.name, s.kind]);
    expect(keyed.sort()).toEqual([
      ['apollo', 'Apollo', 'vendor'],
      ['hubspot_qualified', 'HubSpot marketing qualified', 'crm'],
      ['vibe', 'Vibe Prospecting', 'vendor'],
    ]);

    const defaults = await t.run((ctx) => ctx.tx.select().from(relationshipDefault));
    expect(Object.fromEntries(defaults.map((d) => [d.relationshipKey, d.points]))).toEqual({
      customer_referral: 15,
      partner_referral: 10,
      board_or_investor: 12,
      employee_network: 8,
      event_meeting: 5,
      other: 3,
    });
    expect(defaults.find((d) => d.relationshipKey === 'employee_network')!.label).toBe('Someone on our team knows them');

    const [sch] = await adminDb
      .select()
      .from(schedule)
      .where(and(eq(schedule.tenantId, t.tenantId), eq(schedule.jobName, 'intake.waiting.expire')));
    expect(sch).toMatchObject({ cron: '0 4 * * *', timezone: 'UTC', enabled: true });
  });
});

describe('listSources', () => {
  it('lists the tree in order with trust and arrivals in the last 30 days, limited to what the principal sees', async () => {
    const own = await freshTenant();
    const { personId, agentId } = await personAndAgent(own, 'Zed');
    const other = await own.run((ctx) => registerSource(ctx, { kind: 'person', name: 'Amy' }));
    const insert = (receivedAt: Date) =>
      own.run((ctx) =>
        ctx.tx.insert(arrival).values({
          id: newId('arr'),
          tenantId: ctx.tenantId,
          personSourceId: personId,
          agentSourceId: agentId,
          closestSourceId: agentId,
          principal: 'agent:k',
          channel: 'api',
          payload: {},
          payloadHash: 'h',
          receivedAt,
        }),
      );
    await insert(new Date());
    await insert(new Date(Date.now() - 31 * 86_400_000));

    const everything = await own.run((ctx) => listSources(ctx));
    expect(everything.map((s) => s.name)).toEqual(['Amy', 'Zed', 'Zed agent']);
    expect(everything.map((s) => s.arrivalsLast30Days)).toEqual([0, 1, 1]);
    expect(everything.every((s) => s.trust === 0.6)).toBe(true);

    const mine = await asSource(own, personId, (ctx) => listSources(ctx));
    expect(mine.map((s) => s.id)).toEqual([personId, agentId]);
    const agentOnly = await asSource(own, agentId, (ctx) => listSources(ctx));
    expect(agentOnly.map((s) => s.id)).toEqual([agentId]);
    expect(agentOnly.some((s) => s.id === other.id)).toBe(false);
  });
});

describe('ports', () => {
  it('childSources returns every source below the given ones', async () => {
    const { personId, agentId } = await personAndAgent(t);
    expect(await t.run((ctx) => childSources(ctx, [personId]))).toEqual([agentId]);
    expect(await t.run((ctx) => sourceAccessProvider().childSources(ctx, [agentId]))).toEqual([]);
    expect(await t.run((ctx) => sourceAccessProvider().personSourceFor(ctx, 'usr_x'))).toBeUndefined();
  });

  it('getTrust is 0.60 for any chain, and sourcesForAccount lists the chains of resolved arrivals', async () => {
    const { personId, agentId } = await personAndAgent(t);
    expect(await t.run((ctx) => sourceInfoProvider().getTrust(ctx, { personSourceId: personId, agentSourceId: agentId }))).toBe(
      0.6,
    );
    expect(await t.run((ctx) => sourceInfoProvider().getTrust(ctx, {}))).toBe(0.6);

    // Weights 0.4 person, 0.3 agent, 0.3 vendor, re-weighted over the levels present.
    const vendor = await t.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'Weighted vendor' }));
    await t.run((ctx) => ctx.tx.update(source).set({ trust: 1 }).where(eq(source.id, personId)));
    await t.run((ctx) => ctx.tx.update(source).set({ trust: 0.2 }).where(eq(source.id, vendor.id)));
    const trust = (chain: Parameters<ReturnType<typeof sourceInfoProvider>['getTrust']>[1]) =>
      t.run((ctx) => sourceInfoProvider().getTrust(ctx, chain));
    expect(await trust({ personSourceId: personId, agentSourceId: agentId })).toBeCloseTo((0.4 * 1 + 0.3 * 0.6) / 0.7, 10);
    expect(await trust({ personSourceId: personId, agentSourceId: agentId, vendorSourceId: vendor.id })).toBeCloseTo(
      0.4 * 1 + 0.3 * 0.6 + 0.3 * 0.2,
      10,
    );
    expect(await trust({ agentSourceId: agentId, vendorSourceId: vendor.id })).toBeCloseTo((0.3 * 0.6 + 0.3 * 0.2) / 0.6, 10);

    const accountId = newId('acc');
    const add = (status: string) =>
      t.run((ctx) =>
        ctx.tx.insert(arrival).values({
          id: newId('arr'),
          tenantId: ctx.tenantId,
          personSourceId: personId,
          agentSourceId: agentId,
          closestSourceId: agentId,
          principal: 'agent:k',
          channel: 'api',
          payload: {},
          payloadHash: 'h',
          status,
          accountId,
        }),
      );
    await add('resolved');
    expect((await t.run((ctx) => sourceInfoProvider().sourcesForAccount(ctx, accountId))).sort()).toEqual(
      [agentId, personId].sort(),
    );
  });
});

describe('access for signed-in people', () => {
  it('a cookie-session /v1 request and a server action from a seller carry their person source and its children', async () => {
    const admin = await seedUser({ admin: true });
    const owner = await seedUser({ signedIn: true });
    const slug = uniqueSlug();
    const tenant = await createTenant(admin.actor, { slug, name: 'S', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
    const seller = await seedUser({ signedIn: true });
    await inTenant(tenant.tenantId, owner.actor, (ctx) => addMember(ctx, { email: seller.email, role: 'seller' }));
    await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.tenantId, tenant.tenantId));
    const { personId, agentId } = await inTenant(tenant.tenantId, owner.actor, async (ctx) => {
      const p = await registerSource(ctx, { kind: 'person', name: 'Seller', userId: seller.id });
      const a = await registerSource(ctx, { kind: 'agent', name: 'Seller agent', parentId: p.id });
      return { personId: p.id, agentId: a.id };
    });

    setPrincipalCacheTtl(0);
    const res = await handleDevSignIn(
      new Request('http://localhost:4240/api/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: seller.id }),
      }),
      { enabled: true },
    );
    const cookies = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') });

    let seen: unknown;
    const route = v1Route({}, async (_r, _p, ctx) => {
      seen = ctx.access;
      return {};
    });
    const h = new Headers(cookies);
    h.set('x-scout-tenant', slug);
    expect((await route(new Request('http://localhost:4240/v1/y', { headers: h }))).status).toBe(200);
    expect(seen).toMatchObject({ userId: seller.id, sourceId: personId, childSourceIds: [agentId] });

    currentHeaders = cookies;
    const fromAction = await tenantAction(slug, 'accounts:read', async (ctx) => ctx.access);
    expect(fromAction).toMatchObject({ userId: seller.id, sourceId: personId, childSourceIds: [agentId] });
  });
});
