import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNAL_RULES,
  GENERIC_SIGNAL_RULES,
  approveOffer,
  archiveOffer,
  createOffer,
  createPractice,
  listApprovedOffers,
  listOffers,
  listSignalRules,
  replaceSignalRules,
  resetSignalRules,
  seedOffers,
  type SignalRuleInput,
} from '@/modules/offers';
import { adminDb, closeDbs } from '@/platform/db/client';
import { completeOffer, freshTenant } from './helpers';

afterAll(closeDbs);

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Main Practice' }))).id;
});

const rule = (over: Partial<SignalRuleInput> = {}): SignalRuleInput => ({
  type: 'intent',
  label: 'Researching',
  weight: 40,
  match: ['ai strategy'],
  minValue: 0.6,
  why: 'They are researching the problem.',
  enabled: true,
  ...over,
});
const offerNamed = (name: string, extra: Record<string, unknown> = {}) =>
  t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...extra }));
const events = async (type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OFF-E4-S1 replace signal rules', () => {
  it('stores the rules in order and returns them', async () => {
    const o = await offerNamed('Ordered');
    const saved = await t.run((ctx) =>
      replaceSignalRules(ctx, o.id, [
        rule({ label: 'First', weight: 10, minValue: null, match: [' acqui ', ''] }),
        rule({ label: 'Off', enabled: false }),
      ]),
    );
    expect(saved.map((r) => r.label)).toEqual(['First', 'Off']);
    expect(saved[0]).toMatchObject({ id: expect.stringMatching(/^sr_/), match: ['acqui'], minValue: null, origin: 'manual', sort: 0 });
    expect(saved[1]).toMatchObject({ enabled: false, minValue: 0.6, sort: 1 });
    const again = await t.run((ctx) => replaceSignalRules(ctx, o.id, [rule({ label: 'Only' })]));
    expect(again.map((r) => r.label)).toEqual(['Only']);
    expect((await t.run((ctx) => listSignalRules(ctx, o.id))).map((r) => r.label)).toEqual(['Only']);
  });

  it('AC2: publishes offers.offer.changed with affectsMatching and audits', async () => {
    const o = await offerNamed('Evented');
    await t.run((ctx) => replaceSignalRules(ctx, o.id, [rule()]));
    const mine = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload.data).toMatchObject({ practiceId, changed: ['signal_rules'], affectsMatching: true });
    const audits = await adminDb.execute(
      sql`select action from platform.audit_log where tenant_id = ${t.tenantId} and subject_id = ${o.id} and action = 'offers.signal_rules.replaced'`,
    );
    expect(audits).toHaveLength(1);
  });

  it('AC4: refuses an empty why and keeps the old rules', async () => {
    const o = await offerNamed('Why needed');
    await t.run((ctx) => replaceSignalRules(ctx, o.id, [rule({ label: 'Kept' })]));
    await expect(t.run((ctx) => replaceSignalRules(ctx, o.id, [rule(), rule({ why: '  ' })]))).rejects.toMatchObject({
      status: 400,
      errors: [{ path: 'rules.1.why', message: 'Add why this signal matters.' }],
    });
    expect((await t.run((ctx) => listSignalRules(ctx, o.id))).map((r) => r.label)).toEqual(['Kept']);
  });

  it('is a 404 for an offer that does not exist', async () => {
    await expect(t.run((ctx) => replaceSignalRules(ctx, 'off_nope', [rule()]))).rejects.toMatchObject({ status: 404 });
    await expect(t.run((ctx) => resetSignalRules(ctx, 'off_nope'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('OFF-E4-S1-AC3 reset to defaults', () => {
  it('restores modernization-blueprint defaults', async () => {
    const o = await offerNamed('Modernization Blueprint', { slug: 'modernization-blueprint' });
    await t.run((ctx) => replaceSignalRules(ctx, o.id, [rule({ label: 'Mine' })]));
    const reset = await t.run((ctx) => resetSignalRules(ctx, o.id));
    const want = DEFAULT_SIGNAL_RULES['modernization-blueprint']!;
    expect(reset.map((r) => [r.type, r.label, r.weight, r.match, r.minValue, r.why, r.enabled, r.origin])).toEqual(
      want.map((r) => [r.type, r.label, r.weight, r.match, r.minValue, r.why, true, 'default']),
    );
    const changed = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(changed.at(-1)!.payload.data).toMatchObject({ changed: ['signal_rules'], affectsMatching: true });
  });

  it('gives an offer with no defaults the generic set', async () => {
    const o = await offerNamed('Something Else');
    await t.run((ctx) => replaceSignalRules(ctx, o.id, [rule({ label: 'Mine' })]));
    const reset = await t.run((ctx) => resetSignalRules(ctx, o.id));
    expect(reset.map((r) => r.label)).toEqual(GENERIC_SIGNAL_RULES.map((r) => r.label));
  });
});

describe('listApprovedOffers', () => {
  it('leaves out drafts, archived offers and disabled rules, ordered by approval', async () => {
    const t2 = await freshTenant();
    const p = (await t2.run((ctx) => createPractice(ctx, { name: 'P' }))).id;
    const q = (await t2.run((ctx) => createPractice(ctx, { name: 'Q' }))).id;
    const make = (name: string, practice: string) => t2.run((ctx) => createOffer(ctx, { name, practiceId: practice, ...completeOffer }));
    const first = await make('First created', p);
    const second = await make('Second created', p);
    const draft = await make('Draft', p);
    const archived = await make('Archived', p);
    const other = await make('Other practice', q);
    await t2.run((ctx) => replaceSignalRules(ctx, second.id, [rule({ label: 'On' }), rule({ label: 'Off', enabled: false })]));
    // Approved in a different order from creation.
    for (const o of [second, first, archived, other]) {
      await t2.run((ctx) => approveOffer(ctx, o.id));
      await wait(5);
    }
    await t2.run((ctx) => archiveOffer(ctx, archived.id));

    const all = await t2.run((ctx) => listApprovedOffers(ctx));
    expect(all.map((o) => o.id)).toEqual([second.id, first.id, other.id]);
    expect(all.map((o) => o.id)).not.toContain(draft.id);
    expect(all[0]!.signalRules.map((r) => r.label)).toEqual(['On']);
    expect(all[0]).toMatchObject({ targetTitles: ['CTO'], industries: ['logistics'] });
    expect(all[1]!.signalRules).toEqual([]);

    expect((await t2.run((ctx) => listApprovedOffers(ctx, { practiceIds: [] }))).map((o) => o.id)).toEqual(all.map((o) => o.id));
    expect((await t2.run((ctx) => listApprovedOffers(ctx, { practiceIds: [q] }))).map((o) => o.id)).toEqual([other.id]);
  });
});

describe('seed', () => {
  it('gives Taazaa offers their default rules, and a second run changes nothing', async () => {
    const t3 = await freshTenant();
    const count = async () =>
      ((await t3.run((ctx) =>
        ctx.tx.execute(sql`select count(*)::int as n from offers.signal_rule where tenant_id = ${ctx.tenantId}`),
      )) as unknown as { n: number }[])[0]!.n;
    await t3.run((ctx) => seedOffers(ctx));
    const first = await count();
    const offers = await t3.run((ctx) => listOffers(ctx));
    const blueprint = offers.find((o) => o.slug === 'modernization-blueprint')!;
    expect(await t3.run((ctx) => listSignalRules(ctx, blueprint.id))).toHaveLength(DEFAULT_SIGNAL_RULES['modernization-blueprint']!.length);
    const draft = offers.find((o) => o.slug === 'gtm-audit-pilot')!;
    expect(await t3.run((ctx) => listSignalRules(ctx, draft.id))).toHaveLength(GENERIC_SIGNAL_RULES.length);
    await t3.run((ctx) => seedOffers(ctx));
    expect(await count()).toBe(first);
  });
});
