import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityObserved } from '@/modules/crm/contracts/events';
import { accept, assign, assignmentAccepted, assignmentCreated, autoAccept, bulk } from '@/modules/routing';
import { assignment, routingSetting } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, routingTenant, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
});
afterAll(closeDbs);

const events = async (accountId: string, type: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type && e.data.accountId === accountId);
const assignmentOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.id, id))))[0]!;

describe('the assignment playbook choice', () => {
  it('no choice: templateId null, noPlaybook false', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    expect(await assignmentOf(made.id)).toMatchObject({ templateId: null, noPlaybook: false });
    expect((await events(a, assignmentCreated.type))[0]!.data).toMatchObject({ templateId: null, noPlaybook: false });
  });

  it('no playbook: noPlaybook true', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, noPlaybook: true }));
    expect(await assignmentOf(made.id)).toMatchObject({ templateId: null, noPlaybook: true });
    expect((await events(a, assignmentCreated.type))[0]!.data).toMatchObject({ templateId: null, noPlaybook: true });
  });

  it('a playbook: the id is carried on the row and the event', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, templateId: 'tpl_x' }));
    expect(await assignmentOf(made.id)).toMatchObject({ templateId: 'tpl_x', noPlaybook: false });
    expect((await events(a, assignmentCreated.type))[0]!.data).toMatchObject({ templateId: 'tpl_x', noPlaybook: false });
  });

  it('a bulk assign carries one choice to every account', async () => {
    const [a, b] = [await arrivedAccount(t), await arrivedAccount(t)];
    await asPerson(t, (ctx) => bulk(ctx, [a, b], { kind: 'assign', sellerUserId: seller, templateId: 'tpl_bulk' }));
    for (const id of [a, b]) expect((await events(id, assignmentCreated.type))[0]!.data).toMatchObject({ templateId: 'tpl_bulk', noPlaybook: false });
  });

  it('accepted by the seller carries the choice', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, templateId: 'tpl_seller' }));
    await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller });
    expect((await events(a, assignmentAccepted.type))[0]!.data).toMatchObject({ acceptedHow: 'seller', templateId: 'tpl_seller', noPlaybook: false });
  });

  it('accepted by CRM activity carries the choice', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, noPlaybook: true }));
    await publishTestEvent(t.tenantId, activityObserved, {
      accountId: a,
      handoffId: null,
      system: 'hubspot',
      externalId: newId('cac'),
      kind: 'email',
      occurredAt: new Date().toISOString(),
      actorCrmOwnerId: null,
      actorUserId: seller,
    });
    await runOutbox(t.tenantId);
    expect((await assignmentOf(made.id)).acceptedHow).toBe('crm_activity');
    expect((await events(a, assignmentAccepted.type))[0]!.data).toMatchObject({ acceptedHow: 'crm_activity', templateId: null, noPlaybook: true });
  });

  it('accepted on timeout carries the choice', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, templateId: 'tpl_timeout' }));
    await t.run((ctx) => ctx.tx.update(routingSetting).set({ autoAcceptWorkingDays: 1 }).where(eq(routingSetting.tenantId, ctx.tenantId)));
    await t.run((ctx) => ctx.tx.update(assignment).set({ assignedAt: new Date('2026-01-05T10:00:00Z') }).where(eq(assignment.id, made.id)));
    await t.run((ctx) => autoAccept(ctx, new Date('2026-06-01T10:00:00Z')));
    expect((await events(a, assignmentAccepted.type))[0]!.data).toMatchObject({ acceptedHow: 'auto_timeout', templateId: 'tpl_timeout', noPlaybook: false });
  });

  it('events stored before the choice existed still parse', () => {
    const created = {
      assignmentId: 'asg_1',
      accountId: 'acc_1',
      sellerUserId: 'u',
      assignedBy: 'u',
      templateId: null,
      offerId: null,
      notes: null,
      ownershipDecision: 'assign',
      previousAssignmentId: null,
    };
    expect(assignmentCreated.data.parse(created)).toMatchObject({ noPlaybook: false, bulkId: null });
    expect(assignmentAccepted.data.parse({ assignmentId: 'asg_1', accountId: 'acc_1', sellerUserId: 'u', acceptedHow: 'seller' })).toMatchObject({ templateId: null, noPlaybook: false });
  });
});
