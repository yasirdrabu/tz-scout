import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { confirmWarmIntro, getArrival, getWarmIntro, submitArrival } from '@/modules/intake';
import { warmIntro } from '@/modules/intake/db/schema';
import { addMember } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { ScoutError } from '@/platform/errors';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser } from '../tenancy/helpers';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let src: { personId: string; agentId: string };
let sel: { id: string; email: string };
let other: { id: string; email: string };

const email = (who: string) => `${who}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  src = await personAndAgent(t, 'Ash');
  sel = await seedUser({ email: email('sel') });
  other = await seedUser({ email: email('other') });
  await t.run((ctx) => addMember(ctx, { email: sel.email, role: 'seller' }));
  await t.run((ctx) => addMember(ctx, { email: other.email, role: 'seller' }));
});

let n = 0;
const uniqueDomain = () => `wic${Date.now().toString(36)}${++n}.com`;

async function intro(warm: Record<string, unknown>, domain = uniqueDomain()) {
  const out = await asSource(t, src.agentId, (ctx) => submitArrival(ctx, { account: { name: 'Confirm Co', domain }, warm_intro: warm }, { channel: 'api' }));
  await runOutbox(t.tenantId);
  const accountId = (await t.run((ctx) => getArrival(ctx, out.arrivalId)))!.accountId!;
  return { ...(await row(out.arrivalId)), accountId };
}
const row = async (arrivalId: string) => (await t.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, arrivalId))))[0]!;
const as = <T>(userId: string, fn: (ctx: ModuleContext) => Promise<T>) => inTenant(t.tenantId, { kind: 'user', id: userId }, fn);

async function confirmedEvents(warmIntroId: string) {
  const rows = (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'intake.warm_intro.confirmed'
        and payload->'data'->>'warmIntroId' = ${warmIntroId} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];
  return rows.map((r) => r.payload.data);
}
const audits = (warmIntroId: string) =>
  t.run((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.action, 'intake.warm_intro.confirm'), eq(auditLog.subjectId, warmIntroId))));

describe('confirmWarmIntro', () => {
  it('makes a halved intro count in full, publishes the event with a change id and audits it; a second confirm changes nothing', async () => {
    const i = await intro({ introducer_name: 'Ash Patel', introducer_email: 'ash@outside.example.com', relationship_key: 'employee_network' });
    expect([i.points, i.effectivePoints, i.confirmed]).toEqual([8, 4, false]);

    const view = await t.run((ctx) => confirmWarmIntro(ctx, i.id, { canReview: true }));
    expect(view).toMatchObject({
      warmIntroId: i.id,
      points: 8,
      fullPoints: 8,
      confirmed: true,
      introducerEmail: 'ash@outside.example.com',
      relationshipLabel: 'Someone on our team knows them',
      confirmedAt: expect.any(Date),
    });
    const stored = await row(i.arrivalId);
    expect(stored).toMatchObject({ effectivePoints: 8, confirmed: true, confirmedBy: `user:${t.actor.id}` });
    expect(stored.repricedChangeId).toMatch(/^wic_/);
    expect(await confirmedEvents(i.id)).toEqual([
      { warmIntroId: i.id, accountId: i.accountId, arrivalId: i.arrivalId, relationshipKey: 'employee_network', points: 8, changeId: stored.repricedChangeId },
    ]);
    const [a] = await audits(i.id);
    expect(a).toMatchObject({ before: { confirmed: false, effectivePoints: 4 }, after: { confirmed: true, effectivePoints: 8 } });

    const again = await t.run((ctx) => confirmWarmIntro(ctx, i.id, { canReview: true }));
    expect(again).toMatchObject({ confirmed: true, points: 8 });
    expect(await confirmedEvents(i.id)).toHaveLength(1);
    expect(await audits(i.id)).toHaveLength(1);
    expect((await row(i.arrivalId)).repricedChangeId).toBe(stored.repricedChangeId);
  });

  it('lets the named introducer confirm without review rights, and refuses anyone else with the copy', async () => {
    const i = await intro({ introducer_name: 'Sel Ahn', introducer_email: sel.email, relationship_key: 'partner_referral' });
    expect(i.introducerUserId).toBe(sel.id);

    const e = await as(other.id, (ctx) => confirmWarmIntro(ctx, i.id, { canReview: false })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ScoutError);
    expect((e as ScoutError).status).toBe(403);
    expect((e as ScoutError).message).toBe('Only a reviewer or Sel Ahn, who made the intro, can confirm it.');
    expect((await row(i.arrivalId)).confirmed).toBe(false);

    const view = await as(sel.id, (ctx) => confirmWarmIntro(ctx, i.id, { canReview: false }));
    expect(view).toMatchObject({ confirmed: true, points: 10 });
    expect((await row(i.arrivalId)).confirmedBy).toBe(`user:${sel.id}`);
  });

  it('is not found for an unknown intro', async () => {
    const e = await t.run((ctx) => confirmWarmIntro(ctx, 'wi_nope', { canReview: true })).catch((x: unknown) => x);
    expect((e as ScoutError).status).toBe(404);
  });

  it('keeps the strongest intro when the weaker of two is confirmed (Review Focus 1)', async () => {
    const domain = uniqueDomain();
    const strong = await intro({ introducer_name: 'Cy', relationship_key: 'customer_referral' }, domain); // 15, counts 7
    const weak = await intro({ introducer_name: 'Dee', relationship_key: 'event_meeting' }, domain); // 5, counts 2
    expect(weak.accountId).toBe(strong.accountId);
    await t.run((ctx) => confirmWarmIntro(ctx, weak.id, { canReview: true }));
    expect(await t.run((ctx) => getWarmIntro(ctx, strong.accountId))).toMatchObject({
      warmIntroId: strong.id,
      points: 7,
      fullPoints: 15,
      confirmed: false,
      confirmedAt: null,
      relationshipLabel: 'Referred by a current customer',
    });
  });
});
