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
    const t1 = new Date('2026-10-01T10:00:00Z');
    const t2 = new Date('2026-10-02T10:00:00Z');

    await a.run(async (ctx) => {
      await ctx.tx.insert(assignment).values([
        { id: newId('asg'), tenantId: ctx.tenantId, accountId: acc1, sellerUserId: 'usr_1', assignedBy: 'usr_l', assignedAt: t1, status: 'accepted', respondedAt: t2, acceptedHow: 'seller' },
        { id: newId('asg'), tenantId: ctx.tenantId, accountId: acc2, sellerUserId: 'usr_2', assignedBy: 'usr_l', assignedAt: t2, status: 'pending' },
      ]);
      const act = (kind: string, occurredAt: string) => ({
        id: newId('cac'), tenantId: ctx.tenantId, accountId: acc1, system: 'hubspot', externalId: `act-${kind}-${occurredAt}`, kind, occurredAt: new Date(occurredAt),
      });
      await ctx.tx.insert(activity).values([act('meeting', '2026-10-10T10:00:00Z'), act('meeting', '2026-12-10T10:00:00Z'), act('reply', '2026-10-11T10:00:00Z')]);
      const templateId = newId('plb');
      const planId = newId('pln');
      await ctx.tx.insert(playbookTemplate).values({ id: templateId, tenantId: ctx.tenantId, name: 'Standard' });
      await ctx.tx.insert(accountPlan).values({
        id: planId, tenantId: ctx.tenantId, accountId: acc1, templateId, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'reply_or_meeting', startDate: '2026-10-01',
      });
      const step = (dueDate: string, extra: Record<string, unknown> = {}) => ({
        id: newId('stp'), tenantId: ctx.tenantId, planId, order: 1, day: 0, channel: 'email', ownerRole: 'seller', ownerUserId: 'usr_1', title: 'Step', dueDate, ...extra,
      });
      await ctx.tx.insert(planStep).values([
        step('2026-10-05', { status: 'done', doneAt: t2 }),
        step('2026-10-20', { status: 'skipped' }),
        step('2026-12-01'),
        step('2026-10-06', { ownerUserId: null }),
      ]);
    });
    await b.run(async (ctx) => {
      await ctx.tx.insert(assignment).values({ id: newId('asg'), tenantId: ctx.tenantId, accountId: newId('acc'), sellerUserId: 'usr_9', assignedBy: 'usr_l' });
    });

    expect(await a.run((ctx) => listAssignmentFacts(ctx))).toEqual([
      { accountId: acc1, sellerUserId: 'usr_1', assignedAt: t1, respondedAt: t2, acceptedHow: 'seller' },
      { accountId: acc2, sellerUserId: 'usr_2', assignedAt: t2, respondedAt: null, acceptedHow: null },
    ]);
    expect(await b.run((ctx) => listAssignmentFacts(ctx))).toHaveLength(1);

    expect(await a.run((ctx) => listMeetingFacts(ctx, window))).toEqual([{ accountId: acc1, occurredAt: new Date('2026-10-10T10:00:00Z') }]);
    expect(await b.run((ctx) => listMeetingFacts(ctx, window))).toEqual([]);

    const steps = await a.run((ctx) => listStepFacts(ctx, days));
    expect(steps).toHaveLength(2);
    expect(steps).toEqual(
      expect.arrayContaining([
        { accountId: acc1, ownerUserId: 'usr_1', dueDate: '2026-10-05', doneAt: t2, status: 'done' },
        { accountId: acc1, ownerUserId: 'usr_1', dueDate: '2026-10-20', doneAt: null, status: 'skipped' },
      ]),
    );
    expect(await b.run((ctx) => listStepFacts(ctx, days))).toEqual([]);
  });
});
