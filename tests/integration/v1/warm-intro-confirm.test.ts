import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getScore } from '@/http/routes/v1/accounts/[id]/score/route';
import { POST as postArrival } from '@/http/routes/v1/arrivals/route';
import { POST as warmIntroAction } from '@/http/routes/v1/warm-intros/[id]/route';
import { warmIntro } from '@/modules/intake/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { user } from '@/modules/tenancy/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { call, keyFor, SEND } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let operator: string;
let introducer: string;
let introducerEmail: string;
let otherSeller: string;
let hiddenIntroducer: string;
let hiddenIntroducerEmail: string;

const emailOf = async (id: string) => (await adminDb.select({ email: user.email }).from(user).where(eq(user.id, id)))[0]!.email;

/** An account the agent sent with a warm intro from the given person; the agent's own intro is unconfirmed. */
async function introOn(email: string, name: string) {
  const key = await keyFor(w.tenant, SEND, { sourceId: w.source.agentId, dataLimit: { kind: 'own_source' } });
  const domain = `${newId('acc').slice(-10).toLowerCase()}-example.com`;
  const res = await call(postArrival, key, 'arrivals', {
    body: { account: { domain, name: 'Warm Co' }, warm_intro: { introducer_name: name, introducer_email: email, relationship_key: 'employee_network' } },
  });
  expect(res.status).toBe(202);
  await w.deliver();
  const arrivalId = ((await res.json()) as { arrival_id: string }).arrival_id;
  const [row] = await w.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, arrivalId)));
  return row!;
}
const confirm = (id: string, who: string) => w.as(who, warmIntroAction, `warm-intros/${id}:confirm`, 'POST');
const scoreAs = async (accountId: string, who: string) => (await (await w.as(who, getScore, `accounts/${accountId}/score`)).json()).warm_intro;

beforeAll(async () => {
  w = await workspace('Warm Confirm Co');
  operator = await w.person('operator', { name: 'Olive Operator' });
  introducer = await w.person('seller', { name: 'Ivy Introducer', dataLimit: { kind: 'all' } });
  otherSeller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'all' } });
  hiddenIntroducer = await w.person('seller', { name: 'Hana Hidden', dataLimit: { kind: 'own_accounts' } });
  introducerEmail = await emailOf(introducer);
  hiddenIntroducerEmail = await emailOf(hiddenIntroducer);
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('POST /warm-intros/{id}:confirm (SRC-E5-S2-AC2)', () => {
  it('a reviewer confirms: 200, the intro counts in full, and /score shows it confirmed', async () => {
    const i = await introOn(introducerEmail, 'Ivy Introducer');
    expect([i.points, i.effectivePoints, i.confirmed]).toEqual([8, 4, false]);
    expect(await scoreAs(i.accountId, operator)).toEqual({
      warm_intro_id: i.id,
      introducer_name: 'Ivy Introducer',
      relationship_key: 'employee_network',
      relationship_label: 'Someone on our team knows them',
      points: 4,
      full_points: 8,
      confirmed: false,
      can_confirm: true,
    });
    // Another seller cannot confirm, so the Confirm button is not offered.
    expect((await scoreAs(i.accountId, otherSeller)).can_confirm).toBe(false);
    expect((await scoreAs(i.accountId, introducer)).can_confirm).toBe(true);

    const res = await confirm(i.id, operator);
    expect(res.status).toBe(200);
    expect((await res.json()).warm_intro).toMatchObject({ warm_intro_id: i.id, confirmed: true, points: 8, full_points: 8, confirmed_at: expect.any(String) });
    expect(await scoreAs(i.accountId, operator)).toMatchObject({ confirmed: true, points: 8, can_confirm: false });
    // Confirming again is not an error and changes nothing.
    expect((await confirm(i.id, operator)).status).toBe(200);
  });

  it('the introducer confirms without review:act', async () => {
    const i = await introOn(introducerEmail, 'Ivy Introducer');
    const res = await confirm(i.id, introducer);
    expect(res.status).toBe(200);
    expect((await res.json()).warm_intro).toMatchObject({ confirmed: true, points: 8 });
  });

  it('another seller is refused with the exact copy, and nothing changes', async () => {
    const i = await introOn(introducerEmail, 'Ivy Introducer');
    const res = await confirm(i.id, otherSeller);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('Only a reviewer or Ivy Introducer, who made the intro, can confirm it.');
    expect((await w.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.id, i.id))))[0]!.confirmed).toBe(false);
  });

  it('a caller who cannot see the account, even the introducer, gets a 404; so does an unknown id', async () => {
    const i = await introOn(hiddenIntroducerEmail, 'Hana Hidden');
    expect((await confirm(i.id, hiddenIntroducer)).status).toBe(404);
    expect((await confirm('wi_doesnotexist', operator)).status).toBe(404);
    expect((await w.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.id, i.id))))[0]!.confirmed).toBe(false);
  });

  it('an agent key is refused (people only)', async () => {
    const i = await introOn(introducerEmail, 'Ivy Introducer');
    const key = await keyFor(w.tenant, ['accounts:read', 'review:act'], { dataLimit: { kind: 'all' } });
    const res = await call(warmIntroAction, key, `warm-intros/${i.id}:confirm`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await w.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.id, i.id))))[0]!.confirmed).toBe(false);
  });

  it('an unknown action is a 404', async () => {
    expect((await w.as(operator, warmIntroAction, 'warm-intros/wi_x:nope', 'POST')).status).toBe(404);
  });
});
