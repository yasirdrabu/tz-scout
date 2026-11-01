import { describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { getBrief } from '@/modules/playbooks';
import { arrival, asPerson, domain, routingTenant, scoredAccount } from './helpers';

describe('getBrief', () => {
  it('returns the recommendation, who first, opener, why now and the four sections with labels', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch', {
      people: [{ firstName: 'Maria', lastName: 'Lopez', title: 'COO', email: 'maria@example.com' }],
      signals: [{ kind: 'trigger', type: 'leadership', title: 'Brief Co appoints first CIO', occurredAt: new Date('2026-10-01T00:00:00Z') }],
    });
    const b = (await t.run((ctx) => getBrief(ctx, id)))!;
    expect(b).toMatchObject({ accountId: id, state: 'ready', offerId: null, offerName: null });
    expect(b.lastDraftedAt).toBeInstanceOf(Date);
    expect(b.whoFirst).toMatchObject({ title: 'COO', writtenBy: 'rules', label: 'Assembled from rules' });
    expect(b.whoFirst!.personId).toMatch(/^per_/);
    expect(b.opener!.body).toBe('Hi Maria, I noticed Brief Co appoints first CIO. We help teams like yours get one hard workflow working in weeks.');
    expect(b.whyNow).toMatchObject({ body: 'Brief Co appoints first CIO (Oct 1, 2026)', label: 'Assembled from rules' });
    expect(b.whyNow!.citations[0]).toMatch(/^sig_/);
    expect(b.sections.map((s) => [s.key, s.title])).toEqual([
      ['overview', 'Overview'],
      ['approach', 'Approach'],
      ['value_angle', 'Value angle'],
      ['risks', 'Risks'],
    ]);
    expect(b.sections[1]).toMatchObject({ body: 'Start with Maria Lopez, COO.', version: 1, editedByName: null, writtenForOfferName: null });
    // No contact details reach the brief.
    expect(JSON.stringify(b)).not.toContain('maria@example.com');
  });

  it('before any draft: state not_drafted and four empty sections', async () => {
    const t = await routingTenant();
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Fresh', domain: domain() } })));
    const b = (await t.run((ctx) => getBrief(ctx, accountId)))!;
    expect(b).toMatchObject({ state: 'not_drafted', recommendation: null, whoFirst: null, opener: null, whyNow: null, lastDraftedAt: null });
    expect(b.sections.map((s) => s.body)).toEqual([null, null, null, null]);
  });

  it('is null for a hidden account, a missing one and another tenant', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    expect(await asPerson(t, (ctx) => getBrief(ctx, id), { dataLimit: { kind: 'own_accounts' } })).toBeNull();
    expect(await t.run((ctx) => getBrief(ctx, 'acc_missing'))).toBeNull();
    const other = await routingTenant();
    expect(await other.run((ctx) => getBrief(ctx, id))).toBeNull();
  });
});
