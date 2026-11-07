import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { activity, deal } from '@/modules/crm/db/schema';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { backfillOutcomes, createTemplate } from '@/modules/playbooks';
import { accountPlan, outcome } from '@/modules/playbooks/db/schema';
import { accept, assign } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

let t: Tenant;
let seller: string;
let leader: string;
let offerId: string;
let templateId: string;
const DAY = 86_400_000;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  leader = await member(t, 'leader');
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  templateId = (
    await t.run((ctx) =>
      createTemplate(ctx, { name: 'Backfill', status: 'active', stopWhen: 'never', steps: [{ day: 0, channel: 'email', ownerRole: 'seller', title: 'Intro', subject: 'Hello', body: 'Hi' }] }),
    )
  ).id;
});
afterAll(closeDbs);

async function plan(): Promise<{ accountId: string; planId: string }> {
  const accountId = await arrivedAccount(t, { name: 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
  await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  await runPlaybooks(t.tenantId);
  const [p] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
  await t.run((ctx) => ctx.tx.update(accountPlan).set({ acceptedAt: new Date(Date.now() - 30 * DAY) }).where(eq(accountPlan.id, p!.id)));
  return { accountId, planId: p!.id };
}

describe('backfillOutcomes', () => {
  it('records replies, meetings, opportunity, won and no_response, and a second run records 0', async () => {
    const { accountId, planId } = await plan();
    const at = (days: number) => new Date(Date.now() - days * DAY);
    await t.run(async (ctx) => {
      const act = (externalId: string, kind: string, days: number) =>
        ctx.tx.insert(activity).values({ id: newId('cac'), tenantId: ctx.tenantId, accountId, system: 'hubspot', externalId, kind, occurredAt: at(days) });
      await act('act_r', 'reply', 5);
      await act('act_m', 'meeting', 4);
      await act('act_e', 'email', 3);
      await ctx.tx
        .insert(deal)
        .values({ id: newId('dea'), tenantId: ctx.tenantId, accountId, system: 'hubspot', externalId: 'deal_1', name: 'Big', status: 'won', amountCents: 5000, openedAt: at(10), closedAt: at(2) });
      await ctx.tx.update(accountPlan).set({ noReplyAt: at(1) }).where(eq(accountPlan.id, planId));
    });

    expect(await t.run((ctx) => backfillOutcomes(ctx))).toBe(5);
    const rows = await t.run((ctx) => ctx.tx.select().from(outcome).where(eq(outcome.accountId, accountId)).orderBy(outcome.kind));
    expect(rows.map((r) => [r.kind, r.ref])).toEqual([
      ['meeting', 'hubspot:act_m'],
      ['no_response', planId],
      ['opportunity', 'hubspot:deal_1'],
      ['reply', 'hubspot:act_r'],
      ['won', 'hubspot:deal_1'],
    ]);
    expect(rows.find((r) => r.kind === 'won')).toMatchObject({ amountCents: 5000, source: 'crm', planId });
    expect(rows.find((r) => r.kind === 'no_response')).toMatchObject({ source: 'playbooks', planId });

    expect(await t.run((ctx) => backfillOutcomes(ctx))).toBe(0);
  });
});
