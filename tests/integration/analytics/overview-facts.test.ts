import { afterAll, describe, expect, it } from 'vitest';
import { listMeetingFacts } from '@/modules/crm';
import { activity } from '@/modules/crm/db/schema';
import { accountPlan, planStep, playbookTemplate } from '@/modules/playbooks/db/schema';
import { listStepFacts } from '@/modules/playbooks';
import { listAssignmentFacts } from '@/modules/routing';
import { assignment } from '@/modules/routing/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { freshTenant } from '../integrations/helpers';

afterAll(closeDbs);

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
const days = { fromDay: '2026-10-01', toDay: '2026-10-31' };

describe('overview background reads', () => {
  it('return the in-scope rows of the tenant and nothing from another', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const acc1 = newId('acc');
    const acc2 = newId('acc');
    const accB = newId('acc');
    const t1 = new Date('2026-10-01T10:00:00Z');
    const t2 = new Date('2026-10-02T10:00:00Z');
    const atEnd = '2026-11-01T00:00:00Z';

    /** Meetings and owned steps for one account of the given tenant, so both tenants carry in-scope rows. */
    const seedWork = (t: typeof a, accountId: string, meetings: string[], dueDates: string[]) =>
      t.run(async (ctx) => {
        await ctx.tx.insert(activity).values(
          meetings.map((occurredAt) => ({ id: newId('cac'), tenantId: ctx.tenantId, accountId, system: 'hubspot', externalId: `act-${occurredAt}`, kind: 'meeting', occurredAt: new Date(occurredAt) })),
        );
        const templateId = newId('plb');
        const planId = newId('pln');
        await ctx.tx.insert(playbookTemplate).values({ id: templateId, tenantId: ctx.tenantId, name: 'Standard' });
        await ctx.tx.insert(accountPlan).values({
          id: planId, tenantId: ctx.tenantId, accountId, templateId, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'reply_or_meeting', startDate: '2026-10-01',
        });
        await ctx.tx.insert(planStep).values(
          dueDates.map((dueDate) => ({ id: newId('stp'), tenantId: ctx.tenantId, planId, order: 1, day: 0, channel: 'email', ownerRole: 'seller', ownerUserId: 'usr_1', title: 'Step', dueDate })),
        );
        return planId;
      });

    await a.run(async (ctx) => {
      await ctx.tx.insert(assignment).values([
        { id: newId('asg'), tenantId: ctx.tenantId, accountId: acc1, sellerUserId: 'usr_1', assignedBy: 'usr_l', assignedAt: t1, status: 'accepted', respondedAt: t2, acceptedHow: 'seller' },
        { id: newId('asg'), tenantId: ctx.tenantId, accountId: acc2, sellerUserId: 'usr_2', assignedBy: 'usr_l', assignedAt: t2, status: 'pending' },
      ]);
      await ctx.tx.insert(activity).values({ id: newId('cac'), tenantId: ctx.tenantId, accountId: acc1, system: 'hubspot', externalId: 'act-reply', kind: 'reply', occurredAt: new Date('2026-10-11T10:00:00Z') });
    });
    // Tenant a: a meeting mid-window, one exactly at the end, one outside; steps on both ends and mid-range, plus one out of range.
    const planA = await seedWork(a, acc1, ['2026-10-10T10:00:00Z', atEnd, '2026-12-10T10:00:00Z'], ['2026-10-01', '2026-10-05', '2026-10-31', '2026-12-01']);
    await a.run((ctx) =>
      ctx.tx.insert(planStep).values([
        { id: newId('stp'), tenantId: ctx.tenantId, planId: planA, order: 2, day: 0, channel: 'email', ownerRole: 'seller', ownerUserId: 'usr_1', title: 'Skipped', dueDate: '2026-10-20', status: 'skipped' },
        { id: newId('stp'), tenantId: ctx.tenantId, planId: planA, order: 3, day: 0, channel: 'email', ownerRole: 'seller', ownerUserId: null, title: 'Unowned', dueDate: '2026-10-06' },
      ]),
    );
    // Tenant b: in-scope rows of its own, which tenant a must never see.
    await b.run((ctx) => ctx.tx.insert(assignment).values({ id: newId('asg'), tenantId: ctx.tenantId, accountId: accB, sellerUserId: 'usr_9', assignedBy: 'usr_l' }));
    await seedWork(b, accB, ['2026-10-12T10:00:00Z'], ['2026-10-12']);

    expect(await a.run((ctx) => listAssignmentFacts(ctx))).toEqual([
      { accountId: acc1, sellerUserId: 'usr_1', assignedAt: t1, respondedAt: t2, acceptedHow: 'seller' },
      { accountId: acc2, sellerUserId: 'usr_2', assignedAt: t2, respondedAt: null, acceptedHow: null },
    ]);
    expect(await b.run((ctx) => listAssignmentFacts(ctx))).toHaveLength(1);

    expect(await a.run((ctx) => listMeetingFacts(ctx, window))).toEqual([
      { accountId: acc1, occurredAt: new Date('2026-10-10T10:00:00Z') },
      { accountId: acc1, occurredAt: new Date(atEnd) },
    ]);
    expect(await b.run((ctx) => listMeetingFacts(ctx, window))).toEqual([{ accountId: accB, occurredAt: new Date('2026-10-12T10:00:00Z') }]);

    const steps = await a.run((ctx) => listStepFacts(ctx, days));
    expect(steps.map((s) => s.dueDate).sort()).toEqual(['2026-10-01', '2026-10-05', '2026-10-20', '2026-10-31']);
    expect(steps.every((s) => s.accountId === acc1 && s.ownerUserId === 'usr_1')).toBe(true);
    expect(steps.find((s) => s.dueDate === '2026-10-20')).toEqual({ accountId: acc1, ownerUserId: 'usr_1', dueDate: '2026-10-20', doneAt: null, status: 'skipped' });
    expect(await b.run((ctx) => listStepFacts(ctx, days))).toEqual([{ accountId: accB, ownerUserId: 'usr_1', dueDate: '2026-10-12', doneAt: null, status: 'todo' }]);
  });
});
