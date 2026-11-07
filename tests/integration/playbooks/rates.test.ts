import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getRoute } from '@/http/routes/v1/playbooks/[id]/route';
import { GET as listRoute } from '@/http/routes/v1/playbooks/route';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { createTemplate, getTemplate, listTemplates, recordOutcome } from '@/modules/playbooks';
import { accountPlan } from '@/modules/playbooks/db/schema';
import { accept, assign } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { completeOffer } from '../offers/helpers';
import { workspace } from '../v1/review-helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

let t: Tenant;
let seller: string;
let leader: string;
let offerId: string;

const steps = [{ day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', subject: 'Hello', body: 'Hi' }];
const DAY = 86_400_000;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  leader = await member(t, 'leader');
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
});
afterAll(closeDbs);

const newTemplate = async () => (await t.run((ctx) => createTemplate(ctx, { name: 'Rates', status: 'active', stopWhen: 'never', steps }))).id;

/** A plan accepted a week ago on the template. */
async function plan(templateId: string): Promise<{ accountId: string; planId: string }> {
  const accountId = await arrivedAccount(t, { name: 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
  await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  await runPlaybooks(t.tenantId);
  const [p] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
  await t.run((ctx) => ctx.tx.update(accountPlan).set({ acceptedAt: new Date(Date.now() - 7 * DAY) }).where(eq(accountPlan.id, p!.id)));
  return { accountId, planId: p!.id };
}

const finish = (planId: string, ago: number) => t.run((ctx) => ctx.tx.update(accountPlan).set({ finishedAt: new Date(Date.now() - ago) }).where(eq(accountPlan.id, planId)));
const record = (accountId: string, planId: string, kind: 'reply' | 'meeting' | 'won' | 'no_response', ref: string) =>
  t.run((ctx) => recordOutcome(ctx, { accountId, planId, kind, ref, source: 'crm', occurredAt: new Date() }));
const results = async (id: string) => (await t.run((ctx) => getTemplate(ctx, id))).results;

describe('playbook results', () => {
  it('results counts plans finished in the last 90 days, and replied, meetings and won among them', async () => {
    const id = await newTemplate();
    const a = await plan(id);
    const b = await plan(id);
    const c = await plan(id);
    for (const p of [a, b, c]) await finish(p.planId, DAY);
    // Two replies on one plan count once; a plan with all three counts in each.
    await record(a.accountId, a.planId, 'reply', 'hubspot:r1');
    await record(a.accountId, a.planId, 'reply', 'hubspot:r2');
    await record(a.accountId, a.planId, 'meeting', 'hubspot:m1');
    await record(a.accountId, a.planId, 'won', 'hubspot:d1');
    await record(b.accountId, b.planId, 'reply', 'hubspot:r3');
    await record(c.accountId, c.planId, 'no_response', c.planId);
    expect(await results(id)).toEqual({ finished: 3, replied: 2, meetings: 1, won: 1 });
    const [row] = (await t.run((ctx) => listTemplates(ctx))).filter((x) => x.id === id);
    expect(row!.results).toEqual({ finished: 3, replied: 2, meetings: 1, won: 1 });
  });

  it('a plan finished 91 days ago and an abandoned plan count nothing', async () => {
    const id = await newTemplate();
    const old = await plan(id);
    const abandoned = await plan(id);
    await finish(old.planId, 91 * DAY);
    await record(old.accountId, old.planId, 'reply', 'hubspot:old');
    await record(abandoned.accountId, abandoned.planId, 'reply', 'hubspot:ab');
    await t.run((ctx) => ctx.tx.update(accountPlan).set({ status: 'abandoned' }).where(eq(accountPlan.id, abandoned.planId)));
    expect(await results(id)).toEqual({ finished: 0, replied: 0, meetings: 0, won: 0 });
  });

  it('a template with no finished plans returns zeros', async () => {
    expect(await results(await newTemplate())).toEqual({ finished: 0, replied: 0, meetings: 0, won: 0 });
  });
});

describe('GET /api/v1/playbooks', () => {
  it('list and detail include results in snake_case', async () => {
    const w = await workspace('Rates Co');
    const owner = await w.person('leader');
    const made = await w.run((ctx) => createTemplate(ctx, { name: 'Shape', status: 'active', steps }));
    const zeros = { finished: 0, replied: 0, meetings: 0, won: 0 };
    const list = await (await w.as(owner, listRoute, 'playbooks')).json();
    expect(list.data.find((x: { id: string }) => x.id === made.id).results).toEqual(zeros);
    const one = await (await w.as(owner, getRoute, `playbooks/${made.id}`)).json();
    expect(one.results).toEqual(zeros);
  });
});
