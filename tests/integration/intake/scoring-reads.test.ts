import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { account } from '@/modules/accounts/db/schema';
import { mergeAccounts } from '@/modules/accounts';
import {
  accountIdsForSource,
  bestTrustForAccounts,
  chainsForAccount,
  getArrival,
  getWarmIntro,
  intakeSourceInfo,
  registerSource,
  sourceTrustChanged,
  submitArrival,
} from '@/modules/intake';
import { arrival, source } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { eventDef } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { publishTestEvent } from '../helpers/publish';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };

afterAll(closeDbs);
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const send = (sourceId: string, account: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, { account: { name: 'Scoring Reads Co', ...account }, ...extra }, { channel: 'api' }));
const accountOf = async (arrivalId: string) => (await t.run((ctx) => getArrival(ctx, arrivalId)))!.accountId!;

describe('intake.source.trust_changed', () => {
  it('is registered and accepts the SRC index payload', async () => {
    expect(eventDef('intake.source.trust_changed')).toBe(sourceTrustChanged);
    await publishTestEvent(t.tenantId, sourceTrustChanged, {
      sourceId: ash.agentId,
      level: 'agent',
      from: 0.6,
      to: 0.65,
      sampleSize: 12,
      cause: 'outcomes',
    });
    await runOutbox(t.tenantId);
  });
});

describe('chains, trust and sources by account', () => {
  it('chainsForAccount returns one chain per distinct arrival chain', async () => {
    const d = domain();
    const first = await send(ash.agentId, { domain: d });
    await send(ash.agentId, { domain: d }); // same chain again
    await send(bo.agentId, { domain: d });
    await runOutbox(t.tenantId);
    const accountId = await accountOf(first.arrivalId);
    const chains = await t.run((ctx) => chainsForAccount(ctx, [accountId]));
    expect(chains).toHaveLength(2);
    expect(chains).toEqual(
      expect.arrayContaining([
        { personSourceId: ash.personId, agentSourceId: ash.agentId },
        { personSourceId: bo.personId, agentSourceId: bo.agentId },
      ]),
    );
    expect(await t.run((ctx) => chainsForAccount(ctx, []))).toEqual([]);
  });

  it('bestTrustForAccounts picks the highest trust, with the closest source of the winning chain', async () => {
    const d = domain();
    const first = await send(ash.agentId, { domain: d });
    await send(bo.agentId, { domain: d });
    await runOutbox(t.tenantId);
    const accountId = await accountOf(first.arrivalId);
    vi.spyOn(intakeSourceInfo, 'getTrust').mockImplementation(async (_ctx, chain) => (chain.agentSourceId === bo.agentId ? 0.9 : 0.5));
    expect(await t.run((ctx) => bestTrustForAccounts(ctx, [accountId]))).toEqual({ trust: 0.9, sourceId: bo.agentId, sourceName: 'Bo agent' });
    expect(await t.run((ctx) => bestTrustForAccounts(ctx, []))).toBeNull();
  });

  it('bestTrustForAccounts skips a chain with no source and falls back to the next best', async () => {
    const d = domain();
    const first = await send(ash.agentId, { domain: d });
    const second = await send(bo.agentId, { domain: d });
    await runOutbox(t.tenantId);
    const accountId = await accountOf(first.arrivalId);
    await t.run((ctx) =>
      ctx.tx.update(arrival).set({ personSourceId: null, agentSourceId: null, vendorSourceId: null }).where(eq(arrival.id, second.arrivalId)),
    );
    vi.spyOn(intakeSourceInfo, 'getTrust').mockImplementation(async (_ctx, chain) => (chain.agentSourceId ? 0.5 : 0.95));
    expect(await t.run((ctx) => bestTrustForAccounts(ctx, [accountId]))).toEqual({ trust: 0.5, sourceId: ash.agentId, sourceName: 'Ash agent' });
  });

  it('accountIdsForSource includes the source children and pages by id', async () => {
    const cy = await personAndAgent(t, 'Cy');
    const dee = await personAndAgent(t, 'Dee');
    const sent = [
      await send(cy.agentId, { domain: domain() }),
      await send(cy.personId, { domain: domain() }),
      await send(dee.agentId, { domain: domain() }),
    ];
    await runOutbox(t.tenantId);
    const [viaCyAgent, viaCyPerson, viaDee] = await Promise.all(sent.map((s) => accountOf(s.arrivalId)));
    const forCy = await t.run((ctx) => accountIdsForSource(ctx, cy.personId));
    expect(forCy.ids).toEqual([viaCyAgent!, viaCyPerson!].sort());
    expect(forCy.nextAfterId).toBeNull();
    expect((await t.run((ctx) => accountIdsForSource(ctx, cy.agentId))).ids).toEqual([viaCyAgent]);
    expect((await t.run((ctx) => accountIdsForSource(ctx, dee.personId))).ids).toEqual([viaDee]);

    const sorted = [viaCyAgent!, viaCyPerson!].sort();
    const one = await t.run((ctx) => accountIdsForSource(ctx, cy.personId, { limit: 1 }));
    expect(one).toEqual({ ids: [sorted[0]], nextAfterId: sorted[0] });
    const next = await t.run((ctx) => accountIdsForSource(ctx, cy.personId, { limit: 1, afterId: one.nextAfterId! }));
    expect(next).toEqual({ ids: [sorted[1]], nextAfterId: null });
    await expect(t.run((ctx) => accountIdsForSource(ctx, cy.personId, { limit: 201 }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('accountIdsForSource edges', () => {
  it('includes a source two levels down and leaves out archived accounts', async () => {
    const eve = await personAndAgent(t, 'Eve');
    const grand = await t.run(async (ctx) => {
      const g = await registerSource(ctx, { kind: 'partner', name: 'Eve grandchild' });
      await ctx.tx.update(source).set({ parentId: eve.agentId }).where(eq(source.id, g.id));
      return g.id;
    });
    const viaAgent = await send(eve.agentId, { domain: domain() });
    const viaGrand = await send(grand, { domain: domain() });
    const gone = await send(eve.agentId, { domain: domain() });
    await runOutbox(t.tenantId);
    const [agentAcc, grandAcc, goneAcc] = await Promise.all([viaAgent, viaGrand, gone].map((s) => accountOf(s.arrivalId)));
    await t.run((ctx) => ctx.tx.update(account).set({ archivedAt: new Date() }).where(eq(account.id, goneAcc!)));
    const ids = (await t.run((ctx) => accountIdsForSource(ctx, eve.personId))).ids;
    expect(ids).toEqual([agentAcc!, grandAcc!].sort());
  });
});

describe('getWarmIntro across ids', () => {
  it('takes the strongest across a survivor and a merged id, before and after the merge is applied', async () => {
    const survivor = await send(ash.agentId, { domain: domain() }, { warm_intro: { introducer_name: 'Ash', relationship_key: 'event_meeting' } });
    const merged = await send(bo.agentId, { domain: domain() }, { warm_intro: { introducer_name: 'Bo', relationship_key: 'customer_referral' } });
    await runOutbox(t.tenantId);
    const survivorId = await accountOf(survivor.arrivalId);
    const mergedId = await accountOf(merged.arrivalId);
    const strong = (await t.run((ctx) => getWarmIntro(ctx, mergedId)))!;
    expect((await t.run((ctx) => getWarmIntro(ctx, survivorId)))!.points).toBeLessThan(strong.points);

    await t.run((ctx) => mergeAccounts({ ...ctx, access: { userId: 'usr_leader', sourceId: ash.personId, dataLimit: { kind: 'all' } } }, survivorId, mergedId));
    expect(await t.run((ctx) => getWarmIntro(ctx, [survivorId, mergedId]))).toMatchObject({ warmIntroId: strong.warmIntroId });
    expect(await t.run((ctx) => getWarmIntro(ctx, []))).toBeNull();

    await runOutbox(t.tenantId);
    expect(await t.run((ctx) => getWarmIntro(ctx, [survivorId, mergedId]))).toMatchObject({ warmIntroId: strong.warmIntroId });
    const [row] = await t.run((ctx) => ctx.tx.select({ accountId: arrival.accountId }).from(arrival).where(eq(arrival.id, merged.arrivalId)));
    expect(row!.accountId).toBe(survivorId);
  });
});
