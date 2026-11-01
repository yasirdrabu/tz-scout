import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { getArrival, intakeSourceInfo, registerSource, submitArrival } from '@/modules/intake';
import { approveOffer, archiveOffer, createOffer, createPractice } from '@/modules/offers';
import { previewProfile, scoreAccount, updateProfile, type ProfilePatch } from '@/modules/scoring';
import { accountScore } from '@/modules/scoring/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

afterAll(closeDbs);
afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-10-27T12:00:00Z');
const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const NURTURE_ALL: ProfilePatch = { tierCutoffs: { actNow: 100, goodFit: 99, watch: 98 } };
const DEFAULT_CUTOFFS: ProfilePatch = { tierCutoffs: { actNow: 75, goodFit: 55, watch: 35 } };

const arrival = (name: string): ArrivalForAccounts => ({
  arrivalId: newId('arr'),
  receivedAt: new Date('2026-10-26T15:00:00Z'),
  sourceChain: {},
  account: { name, domain: domain(), industry: 'Logistics' },
  people: [],
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
});

/** Four scored accounts for one approved offer: plain, one with a warm intro, one researched B and one researched C. */
async function world() {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Preview Practice', slug: `p-${newId('prc').slice(-8).toLowerCase()}` }));
  const offer = await t.run((ctx) => createOffer(ctx, { name: 'Lead', practiceId: practice.id, ...completeOffer }));
  await t.run((ctx) => approveOffer(ctx, offer.id));
  const plain = (await t.run((ctx) => upsertFromArrival(ctx, arrival('Plain Co')))).accountId;
  const tierB = (await t.run((ctx) => upsertFromArrival(ctx, arrival('Research B Co')))).accountId;
  const tierC = (await t.run((ctx) => upsertFromArrival(ctx, arrival('Research C Co')))).accountId;
  await t.run((ctx) => ctx.tx.update(account).set({ researchTier: 'B' }).where(eq(account.id, tierB)));
  await t.run((ctx) => ctx.tx.update(account).set({ researchTier: 'C' }).where(eq(account.id, tierC)));
  const agentId = await t.run(async (ctx) => {
    const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
    return (await registerSource(ctx, { kind: 'agent', name: 'Ash agent', parentId: person.id })).id;
  });
  vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.6);
  const sent = await t.run((ctx) =>
    submitArrival(
      { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'own_source' } } },
      { account: { name: 'Warm Co', domain: domain(), industry: 'Logistics' }, warm_intro: { introducer_name: 'Ash', relationship_key: 'event_meeting' } },
      { channel: 'api', canDeclareWarmIntro: true },
    ),
  );
  await runOutbox(t.tenantId);
  const warm = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
  const ids = { plain, warm, tierB, tierC };
  for (const id of Object.values(ids)) await t.run((ctx) => scoreAccount(ctx, id, 'manual_rescore', undefined, { now: NOW }));
  return { t, practice, offer, ids };
}

const afterTiers = (p: Awaited<ReturnType<typeof previewProfile>>) => Object.fromEntries(p.samples.map((s) => [s.accountId, s.tierAfter]));

describe('previewProfile applies the floors as a rescore does', () => {
  it('a warm intro and a research B keep Good fit when the draft pushes the score below it; a research C keeps Watch', async () => {
    const { t, ids } = await world();
    const p = await t.run((ctx) => previewProfile(ctx, NURTURE_ALL, NOW));
    expect(afterTiers(p)).toEqual({ [ids.plain]: 'nurture', [ids.warm]: 'good_fit', [ids.tierB]: 'good_fit', [ids.tierC]: 'watch' });
  });

  it('applies a floor the draft newly triggers, as a real rescore does', async () => {
    const { t, ids } = await world();
    // Saved with cutoffs that put the plain account at nurture: only the floors lift the others.
    await t.run((ctx) => updateProfile(ctx, NURTURE_ALL));
    for (const id of Object.values(ids)) await t.run((ctx) => scoreAccount(ctx, id, 'rules_changed', undefined, { now: NOW }));
    const p = await t.run((ctx) => previewProfile(ctx, DEFAULT_CUTOFFS, NOW));
    await t.run((ctx) => updateProfile(ctx, DEFAULT_CUTOFFS));
    for (const id of Object.values(ids)) await t.run((ctx) => scoreAccount(ctx, id, 'rules_changed', undefined, { now: NOW }));
    const rows = await t.run((ctx) => ctx.tx.select().from(accountScore));
    expect(afterTiers(p)).toEqual(Object.fromEntries(rows.map((r) => [r.accountId, r.tier])));
  });

  it('equals the tiers after saving the draft and rescoring', async () => {
    const { t, ids } = await world();
    const drafts: ProfilePatch[] = [NURTURE_ALL, { weights: { fit: 60, intent: 20, revenue: 10, trust: 10 } }, { tierCutoffs: { actNow: 60, goodFit: 40, watch: 20 } }];
    for (const draft of drafts) {
      const p = await t.run((ctx) => previewProfile(ctx, draft, NOW));
      await t.run((ctx) => updateProfile(ctx, draft));
      for (const id of Object.values(ids)) await t.run((ctx) => scoreAccount(ctx, id, 'rules_changed', undefined, { now: NOW }));
      const rows = await t.run((ctx) => ctx.tx.select().from(accountScore));
      expect(afterTiers(p)).toEqual(Object.fromEntries(rows.map((r) => [r.accountId, r.tier])));
    }
  });

  it('ignores a stored match for an offer that is no longer approved', async () => {
    const { t, offer, ids } = await world();
    await t.run((ctx) => archiveOffer(ctx, offer.id));
    const p = await t.run((ctx) => previewProfile(ctx, {}, NOW));
    expect(Object.values(afterTiers(p))).toEqual(['not_fit', 'not_fit', 'not_fit', 'not_fit']);
    expect(Object.keys(afterTiers(p)).sort()).toEqual(Object.values(ids).sort());
  });

  it('keeps a hand-set tier', async () => {
    const { t, ids } = await world();
    await t.run((ctx) => ctx.tx.update(accountScore).set({ tierOverride: 'act_now' }).where(eq(accountScore.accountId, ids.plain)));
    const p = await t.run((ctx) => previewProfile(ctx, NURTURE_ALL, NOW));
    expect(afterTiers(p)[ids.plain]).toBe('act_now');
  });
});
