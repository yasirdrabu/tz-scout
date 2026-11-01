import { describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { signalRecorded } from '@/modules/accounts/contracts/events';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { editSection, getBrief } from '@/modules/playbooks';
import { assign, decline, ensureReview, setLeadOffer, withdraw } from '@/modules/routing';
import { member } from '../routing/helpers';
import { scoreAccount } from '@/modules/scoring';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer } from '../offers/helpers';
import { arrival, asPerson, briefRow, briefRuns, domain, draftJobs, routingTenant, runPlaybooks, scoredAccount, sectionRows } from './helpers';

const signal = (accountId: string) => ({
  accountId,
  signalId: newId('sig'),
  type: 'news',
  kind: 'trigger' as const,
  occurredAt: new Date().toISOString(),
  sourceChain: {},
});

describe('draft triggers', () => {
  it('twelve signals in one arrival make at most two draft runs (Review Focus 3)', async () => {
    const t = await routingTenant();
    const d = domain();
    const id = await scoredAccount(t, 'act_now', { account: { domain: d } });
    const runsBefore = (await briefRuns(t.tenantId)).length;
    const jobsBefore = await draftJobs(t.tenantId, id);
    const a = arrival({
      account: { name: 'Brief Co', domain: d },
      signals: Array.from({ length: 12 }, (_, i) => ({ kind: 'trigger' as const, type: 'news', title: `Brief Co opens office ${i + 1}`, occurredAt: new Date(Date.now() - i * 86_400_000) })),
    });
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, a));
    expect(accountId).toBe(id);
    await publishTestEvent(t.tenantId, arrivalResolved, {
      arrivalId: a.arrivalId,
      accountId: id,
      resolution: 'attached',
      sourceChain: {},
      isFirstFromSource: false,
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
    });
    await runOutbox(t.tenantId);
    expect((await briefRuns(t.tenantId)).length - runsBefore).toBeLessThanOrEqual(2);
    expect((await draftJobs(t.tenantId, id)) - jobsBefore).toBeLessThanOrEqual(2);
    expect(await briefRow(id)).toMatchObject({ draftState: 'ready' });
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b.whyNow!.body).toContain('Brief Co opens office 1 (');
  });

  it('no automatic redraft after an assignment; its decline starts them again', async () => {
    const t = await routingTenant();
    const seller = await member(t, 'seller');
    const id = await scoredAccount(t, 'watch');
    const before = (await briefRow(id))!;
    const a = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: seller }));
    await runPlaybooks(t.tenantId);
    expect(await briefRow(id)).toMatchObject({ frozenByAssignmentId: a.id });

    await publishTestEvent(t.tenantId, signalRecorded, signal(id));
    await runPlaybooks(t.tenantId);
    expect((await briefRow(id))!.requestedSeq).toBe(before.requestedSeq);
    expect(await draftJobs(t.tenantId, id)).toBe(1);

    await asPerson(t, (ctx) => decline(ctx, a.id, { reasonKey: 'not_a_fit' }), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runPlaybooks(t.tenantId);
    const after = (await briefRow(id))!;
    expect(after).toMatchObject({ frozenAt: null, frozenByAssignmentId: null, draftState: 'ready', draftedSeq: before.draftedSeq + 1 });
    expect(await draftJobs(t.tenantId, id)).toBe(2);
  });

  it('a reassignment keeps the brief frozen for the new AE; a plain withdrawal unfreezes', async () => {
    const t = await routingTenant();
    const [s1, s2] = [await member(t, 'seller'), await member(t, 'seller')];
    const id = await scoredAccount(t, 'watch');
    const a = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s1 }));
    await runPlaybooks(t.tenantId);
    const b = await asPerson(t, (ctx) => assign(ctx, id, { sellerUserId: s2 }));
    await runPlaybooks(t.tenantId);
    expect(await briefRow(id)).toMatchObject({ frozenByAssignmentId: b.id });
    expect(b.id).not.toBe(a.id);
    await asPerson(t, (ctx) => withdraw(ctx, b.id));
    await runPlaybooks(t.tenantId);
    expect((await briefRow(id))!.frozenAt).toBeNull();
    expect(await draftJobs(t.tenantId, id)).toBe(2);
  });

  it('an account assigned before its first draft still gets one', async () => {
    const t = await routingTenant();
    const seller = await member(t, 'seller');
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Early', domain: domain() } })));
    await t.run((ctx) => ensureReview(ctx, accountId, 'unvetted'));
    await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller }));
    await runPlaybooks(t.tenantId);
    expect((await briefRow(accountId))!.frozenAt).not.toBeNull();
    await t.run((ctx) => scoreAccount(ctx, accountId, 'manual_rescore'));
    await runPlaybooks(t.tenantId);
    expect(await briefRow(accountId)).toMatchObject({ draftState: 'ready', mode: 'rules' });
    expect((await briefRow(accountId))!.frozenAt).not.toBeNull();
  });

  it('a signal for an account with no brief requests nothing', async () => {
    const t = await routingTenant();
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Unscored', domain: domain() } })));
    await publishTestEvent(t.tenantId, signalRecorded, signal(accountId));
    await runPlaybooks(t.tenantId);
    expect(await briefRow(accountId)).toBeUndefined();
  });

  it('a new lead offer redrafts for it; an edited Approach keeps its text and says which offer it was written for', async () => {
    const t = await routingTenant();
    const practice = await t.run((ctx) => createPractice(ctx, { name: 'Brief Practice', slug: `bp-${newId('prc').slice(-8).toLowerCase()}` }));
    const offers = [];
    for (const name of ['Offer One', 'Offer Two']) {
      const o = await t.run((ctx) => createOffer(ctx, { name, practiceId: practice.id, ...completeOffer }));
      await t.run((ctx) => approveOffer(ctx, o.id));
      offers.push(o);
    }
    const id = await scoredAccount(t, 'watch', {}, { practiceIds: [practice.id] });
    const first = (await briefRow(id))!;
    expect(offers.map((o) => o.id)).toContain(first.offerId);
    const firstName = offers.find((o) => o.id === first.offerId)!.name;
    const other = offers.find((o) => o.id !== first.offerId)!;
    const approach = (await sectionRows(id)).find((s) => s.key === 'approach')!;
    await asPerson(t, (ctx) => editSection(ctx, id, 'approach', { body: 'Call them about the depot.', ifVersion: approach.version }));
    await runOutbox(t.tenantId);

    await asPerson(t, (ctx) => setLeadOffer(ctx, id, other.id));
    await runOutbox(t.tenantId);
    expect((await briefRow(id))!.offerId).toBe(other.id);
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    const [overview, approachView] = b.sections;
    expect(overview!.body).toContain(`Scout matched it to ${other.name}`);
    expect(overview!.writtenForOfferName).toBeNull();
    expect(approachView).toMatchObject({ body: 'Call them about the depot.', writtenBy: 'person', writtenForOfferName: firstName });
    expect(b.offerName).toBe(other.name);
  });
});
