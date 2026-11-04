import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedAccountDefaults } from '@/modules/accounts';
import { buyingRole } from '@/modules/accounts/db/schema';
import { createOffer, createPractice, seedOffers, TAAZAA_OFFERS } from '@/modules/offers';
import {
  archiveTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  offerPlaybooks,
  playbookFor,
  seedPlaybooksDefaults,
  setOfferPlaybook,
  updateTemplate,
  type StepInput,
} from '@/modules/playbooks';
import { accountPlan, offerPlaybook, playbookTemplate } from '@/modules/playbooks/db/schema';
import { newId } from '@/platform/ids';
import { completeOffer, freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let offerId: string;
beforeAll(async () => {
  t = await freshTenant();
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run((ctx) => createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer }))).id;
});

const email: StepInput = { day: 0, channel: 'email', ownerRole: 'seller', title: 'Intro', subject: 'Hello {person.first_name}', body: 'About {offer.name}' };
const call: StepInput = { day: 5, channel: 'call', ownerRole: 'seller', title: 'Call' };
const rejects = (p: Promise<unknown>, status: number, text: string) =>
  expect(p).rejects.toMatchObject({ status, message: expect.stringContaining(text) });

describe('versioning (Ruling 6)', () => {
  it('bumps an active template on a step change, keeps the old rows readable, and leaves metadata edits alone', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Versioned', status: 'active', steps: [email] }));
    expect(made).toMatchObject({ version: 1, status: 'active', stepCount: 1 });

    const renamed = await t.run((ctx) => updateTemplate(ctx, made.id, { name: 'Versioned 2', whenToUse: 'Always', stopWhen: 'meeting' }));
    expect(renamed).toMatchObject({ version: 1, name: 'Versioned 2', whenToUse: 'Always', stopWhen: 'meeting' });
    const same = await t.run((ctx) => updateTemplate(ctx, made.id, { steps: [email] }));
    expect(same.version).toBe(1);

    const bumped = await t.run((ctx) => updateTemplate(ctx, made.id, { steps: [email, call] }));
    expect(bumped.version).toBe(2);
    expect(bumped.steps.map((s) => s.title)).toEqual(['Intro', 'Call']);
    expect(bumped.days).toBe(5);
    const old = await t.run((ctx) => getTemplate(ctx, made.id, 1));
    expect(old.steps.map((s) => s.title)).toEqual(['Intro']);
    expect(old.stepsVersion).toBe(1);
    await rejects(t.run((ctx) => getTemplate(ctx, made.id, 3)), 404, 'not found');
  });

  it('replaces the steps of a draft in place', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Draft', steps: [email] }));
    expect(made.status).toBe('draft');
    const edited = await t.run((ctx) => updateTemplate(ctx, made.id, { steps: [call] }));
    expect(edited.version).toBe(1);
    expect(edited.steps.map((s) => s.title)).toEqual(['Call']);
  });

  it('refuses to activate with no steps, and a blank name', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Empty' }));
    await rejects(t.run((ctx) => updateTemplate(ctx, made.id, { status: 'active' })), 400, 'Add at least one step.');
    await rejects(t.run((ctx) => createTemplate(ctx, { name: 'Active empty', status: 'active' })), 400, 'Add at least one step.');
    await rejects(t.run((ctx) => createTemplate(ctx, { name: '  ' })), 400, 'Give the playbook a name.');
    const ok = await t.run((ctx) => updateTemplate(ctx, made.id, { status: 'active', steps: [email] }));
    expect(ok).toMatchObject({ status: 'active', version: 1 });
  });
});

describe('target buying roles', () => {
  it('refuses an unknown role at its step, on create and on update', async () => {
    await t.run((ctx) => seedAccountDefaults(ctx));
    const bad: StepInput[] = [email, { ...call, targetBuyingRoles: ['business_owner', 'wizard'] }];
    await expect(t.run((ctx) => createTemplate(ctx, { name: 'Bad roles', steps: bad }))).rejects.toMatchObject({
      status: 400,
      message: 'Unknown buying role: wizard',
      errors: [{ path: 'steps.1.target_buying_roles' }],
    });
    const ok = await t.run((ctx) => createTemplate(ctx, { name: 'Good roles', steps: [{ ...email, targetBuyingRoles: ['business_owner'] }] }));
    await rejects(t.run((ctx) => updateTemplate(ctx, ok.id, { steps: bad })), 400, 'Unknown buying role: wizard');
  });
});

describe('archived target buying roles', () => {
  it('keeps a role the current version already uses; a new unknown key still fails', async () => {
    await t.run((ctx) => seedAccountDefaults(ctx));
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Kept role', steps: [{ ...email, targetBuyingRoles: ['business_owner'] }] }));
    await t.run((ctx) => ctx.tx.update(buyingRole).set({ archived: true }).where(and(eq(buyingRole.tenantId, ctx.tenantId), eq(buyingRole.key, 'business_owner'))));
    const kept = await t.run((ctx) => updateTemplate(ctx, made.id, { name: 'Kept role 2', steps: [{ ...email, targetBuyingRoles: ['business_owner'] }, call] }));
    expect(kept.steps[0]!.targetBuyingRoles).toEqual(['business_owner']);
    await rejects(t.run((ctx) => updateTemplate(ctx, made.id, { steps: [{ ...email, targetBuyingRoles: ['business_owner', 'wizard'] }] })), 400, 'Unknown buying role: wizard');
    const other = await t.run((ctx) => createTemplate(ctx, { name: 'Other' }));
    await rejects(t.run((ctx) => updateTemplate(ctx, other.id, { steps: [{ ...email, targetBuyingRoles: ['business_owner'] }] })), 400, 'Unknown buying role: business_owner');
  });
});

describe('list, duplicate, archive, delete', () => {
  it('lists steps, days, channels, runs_on and running', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Listed', status: 'active', steps: [email, call, { ...call, day: 9 }] }));
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'watch', made.id));
    await t.run((ctx) =>
      ctx.tx.insert(accountPlan).values({ id: newId('pln'), tenantId: ctx.tenantId, accountId: newId('acc'), offerId, tier: 'watch', templateId: made.id, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'never', startDate: '2026-11-04' }),
    );
    const row = (await t.run((ctx) => listTemplates(ctx))).find((x) => x.id === made.id)!;
    expect(row).toMatchObject({ steps: 3, days: 9, channels: { email: 1, call: 2 }, runsOn: [{ offerId, tier: 'watch' }], running: 1 });
  });

  it('duplicates as a draft named "(copy)" and archives', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'Original', status: 'active', steps: [email, call] }));
    const copy = await t.run((ctx) => duplicateTemplate(ctx, made.id));
    expect(copy).toMatchObject({ name: 'Original (copy)', status: 'draft', version: 1, stepCount: 2 });
    expect(copy.id).not.toBe(made.id);
    expect((await t.run((ctx) => archiveTemplate(ctx, made.id))).status).toBe('archived');
  });

  it('archiving removes the offer mapping so the tier shows null; running plans stay', async () => {
    const made = await t.run((ctx) => createTemplate(ctx, { name: 'To archive', status: 'active', steps: [email] }));
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', made.id));
    const planId = newId('pln');
    await t.run((ctx) =>
      ctx.tx.insert(accountPlan).values({ id: planId, tenantId: ctx.tenantId, accountId: newId('acc'), offerId, tier: 'good_fit', templateId: made.id, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'never', startDate: '2026-11-04' }),
    );
    expect((await t.run((ctx) => offerPlaybooks(ctx, offerId))).find((v) => v.tier === 'good_fit')!.playbook).toMatchObject({ id: made.id });
    await t.run((ctx) => archiveTemplate(ctx, made.id));
    expect((await t.run((ctx) => offerPlaybooks(ctx, offerId))).find((v) => v.tier === 'good_fit')).toEqual({ tier: 'good_fit', playbook: null, firstEmail: null });
    const [plan] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId)));
    expect(plan).toMatchObject({ status: 'active', templateId: made.id });
  });

  it('deletes an unused template and refuses one a plan or an offer uses (409)', async () => {
    const unused = await t.run((ctx) => createTemplate(ctx, { name: 'Unused', steps: [email] }));
    await t.run((ctx) => deleteTemplate(ctx, unused.id));
    await rejects(t.run((ctx) => getTemplate(ctx, unused.id)), 404, 'not found');

    const mapped = await t.run((ctx) => createTemplate(ctx, { name: 'Mapped', status: 'active', steps: [email] }));
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', mapped.id));
    await rejects(t.run((ctx) => deleteTemplate(ctx, mapped.id)), 409, 'This playbook has run on accounts. Retire it instead.');

    const used = await t.run((ctx) => createTemplate(ctx, { name: 'Used', status: 'active', steps: [email] }));
    await t.run((ctx) =>
      ctx.tx.insert(accountPlan).values({ id: newId('pln'), tenantId: ctx.tenantId, accountId: newId('acc'), offerId, tier: 'act_now', templateId: used.id, templateVersion: 1, assignmentId: newId('asg'), status: 'completed', stopWhen: 'never', startDate: '2026-11-04' }),
    );
    await rejects(t.run((ctx) => deleteTemplate(ctx, used.id)), 409, 'This playbook has run on accounts. Retire it instead.');
  });
});

describe('offer playbooks (Ruling 14)', () => {
  it('returns all three tiers, validates the tier and refuses an archived template', async () => {
    const a = await t.run((ctx) => createTemplate(ctx, { name: 'Tier A', status: 'active', steps: [call, email, { ...email, title: 'Second email', subject: 'Later' }] }));
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'act_now', a.id));
    const views = await t.run((ctx) => offerPlaybooks(ctx, offerId));
    expect(views.map((v) => v.tier)).toEqual(['act_now', 'good_fit', 'watch']);
    const act = views[0]!;
    expect(act.playbook).toMatchObject({ id: a.id, name: 'Tier A', status: 'active', steps: 3, days: 5 });
    // The first email step by order, with the raw placeholders.
    expect(act.firstEmail).toEqual({ subject: 'Hello {person.first_name}', body: 'About {offer.name}' });
    expect(await t.run((ctx) => playbookFor(ctx, offerId, 'act_now'))).toMatchObject({ templateId: a.id, status: 'active' });

    await rejects(t.run((ctx) => setOfferPlaybook(ctx, offerId, 'nurture', a.id)), 400, 'act_now');
    await t.run((ctx) => archiveTemplate(ctx, a.id));
    await rejects(t.run((ctx) => setOfferPlaybook(ctx, offerId, 'watch', a.id)), 400, "That playbook isn't available.");

    const cleared = await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'act_now', null));
    expect(cleared[0]).toEqual({ tier: 'act_now', playbook: null, firstEmail: null });
  });
});

describe('seeds (Ruling 17)', () => {
  it('gives a seeded catalogue its templates and maps act_now and good_fit, once', async () => {
    const s = await freshTenant();
    await s.run((ctx) => seedAccountDefaults(ctx));
    await s.run((ctx) => seedOffers(ctx));
    await s.run((ctx) => seedPlaybooksDefaults(ctx));
    await s.run((ctx) => seedPlaybooksDefaults(ctx));
    const templates = await s.run((ctx) => listTemplates(ctx));
    expect(templates.map((x) => x.name).sort()).toEqual(['Public sector RFP', 'Standard outbound']);
    expect(templates.every((x) => x.status === 'active')).toBe(true);

    const rfp = await s.run(async (ctx) => getTemplate(ctx, templates.find((x) => x.name === 'Public sector RFP')!.id));
    expect(rfp.steps.map((x) => [x.day, x.channel, x.ownerRole, x.targetBuyingRoles])).toEqual([
      [0, 'task', 'seller', []],
      [3, 'email', 'seller', ['business_owner']],
      [14, 'task', 'seller', ['commercial_buyer']],
      [21, 'meeting', 'leader', []],
    ]);
    const std = await s.run(async (ctx) => getTemplate(ctx, templates.find((x) => x.name === 'Standard outbound')!.id));
    expect(std.steps.map((x) => [x.day, x.channel])).toEqual([[0, 'email'], [3, 'linkedin'], [7, 'email'], [14, 'call']]);
    expect(std.steps[0]!.body).toContain('{person.first_name}');

    const maps = await s.run((ctx) => ctx.tx.select().from(offerPlaybook).where(eq(offerPlaybook.tenantId, ctx.tenantId)));
    expect(maps).toHaveLength(TAAZAA_OFFERS.length * 2);
    expect(maps.some((m) => m.tier === 'watch')).toBe(false);
    const blueprint = await s.run(async (ctx) => {
      const offers = await import('@/modules/offers').then((m) => m.listOffers(ctx));
      return offers.find((o) => o.slug === 'modernization-blueprint')!.id;
    });
    const mapped = await s.run((ctx) => playbookFor(ctx, blueprint, 'act_now'));
    expect(mapped!.templateId).toBe(templates.find((x) => x.name === 'Public sector RFP')!.id);
    // A cleared mapping stays cleared when the seed runs again.
    await s.run((ctx) => setOfferPlaybook(ctx, blueprint, 'good_fit', null));
    await s.run((ctx) => seedPlaybooksDefaults(ctx));
    expect(await s.run((ctx) => playbookFor(ctx, blueprint, 'good_fit'))).toBeNull();
    const rows = await s.run((ctx) => ctx.tx.select({ id: playbookTemplate.id }).from(playbookTemplate).where(and(eq(playbookTemplate.tenantId, ctx.tenantId))));
    expect(rows).toHaveLength(2);
  });

  it('seeds nothing for a workspace with no practices', async () => {
    const s = await freshTenant();
    await s.run((ctx) => seedPlaybooksDefaults(ctx));
    expect(await s.run((ctx) => listTemplates(ctx))).toEqual([]);
  });
});
