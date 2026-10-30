import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { getBatch, listBatches, markCopied, seedMockCrm, syncOwners } from '@/modules/crm';
import { handoff, handoffBatch, handoffMessage } from '@/modules/crm/db/schema';
import { setConnectionSettings } from '@/modules/integrations';
import { assignmentCreated, bulk } from '@/modules/routing';
import { addMember } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import type { DataLimit } from '@/platform/access';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, setSummary, type Tenant } from '../routing/helpers';
import { seedUser } from '../tenancy/helpers';

let t: Tenant;
let mike: string;
let ash: string;
let noOwner: string;

beforeAll(async () => {
  t = await routingTenant();
  mike = await member(t, 'seller');
  ash = await member(t, 'seller');
  const u = await seedUser({ signedIn: true });
  await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' })); // no CRM owner id
  noOwner = u.id;
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
  await t.run((ctx) => setConnectionSettings(ctx, 'hubspot', { portal_id: '777' }));
});
afterAll(closeDbs);

const nameOf = async (id: string) => (await t.run((ctx) => import('@/modules/tenancy').then((m) => m.members(ctx)))).find((m) => m.userId === id)!.name;
const firstName = async (id: string) => (await nameOf(id)).split(' ')[0]!;

async function account(name: string): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name, domain: domain() },
      people: [{ firstName: 'Pat', lastName: 'Lee', title: 'CTO', email: `pat.${newId('acc').slice(-6).toLowerCase()}@batch.example` }],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(t, accountId, { arrivalId, resolution: 'created' });
  return accountId;
}

/** What routing sends when a leader assigns; `bulkId` ties accounts to one leader action. */
const assigned = (accountId: string, sellerUserId: string, bulkId: string | null) =>
  publishTestEvent(t.tenantId, assignmentCreated, {
    assignmentId: newId('asg'),
    accountId,
    sellerUserId,
    assignedBy: t.actor.id,
    templateId: null,
    offerId: null,
    notes: null,
    ownershipDecision: 'assign',
    previousAssignmentId: null,
    bulkId,
  });

const view = (id: string) => t.run((ctx) => getBatch(ctx, id));
const batchIdOf = async (accountId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, accountId))))[0]!.handoffBatchId!;

describe('handoff batches and messages (CRM-E4)', () => {
  it('a bulk of 3 accounts to two sellers is one batch with two messages, named for the split', async () => {
    const [a1, a2, a3] = [await account('Acme'), await account('Globex'), await account('Initech')];
    const blk = newId('blk');
    await assigned(a1, mike, blk);
    await assigned(a2, mike, blk);
    await assigned(a3, ash, blk);
    await runOutbox(t.tenantId);

    const id = await batchIdOf(a1);
    expect(await batchIdOf(a3)).toBe(id);
    const b = (await view(id))!;
    expect(b.name).toMatch(new RegExp(`^[A-Z][a-z]{2} \\d{1,2} · 2 to ${await firstName(mike)}, 1 to ${await firstName(ash)}$`));
    expect(b.handoffs).toHaveLength(3);
    expect(b.messages.map((m) => [m.sellerUserId, m.count]).sort()).toEqual([[ash, 1], [mike, 2]].sort());
    const toMike = b.messages.find((m) => m.sellerUserId === mike)!;
    expect(toMike.text).toContain(`Hi ${await firstName(mike)}, 2 new accounts are in HubSpot for you.`);
    expect(toMike.text).toContain('1. Acme');
    expect(toMike.text).toContain('Start with Pat Lee, CTO');
    expect(toMike.text).toMatch(/https:\/\/app\.hubspot\.com\/contacts\/777\/record\/0-2\/mock-co-\d+/);
    expect(toMike.text).toContain('(days 3, 7 and 14)');
    expect(toMike.text!.endsWith(await firstName(t.actor.id))).toBe(true);
    expect(b.notSentYet).toEqual([]);
    expect(toMike.copiedAt).toBeNull();
  });

  it('a routing bulk assign to one seller gives one batch and one message', async () => {
    const ids = [await account('Hooli'), await account('Pied Piper')];
    await asPerson(t, (ctx) => bulk(ctx, ids, { kind: 'assign', sellerUserId: mike }));
    await runOutbox(t.tenantId);
    const id = await batchIdOf(ids[0]!);
    expect(await batchIdOf(ids[1]!)).toBe(id);
    const b = (await view(id))!;
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.count).toBe(2);
    expect(b.name).toContain(`2 to ${await firstName(mike)}`);
  });

  it('a single assignment makes its own batch named for the account', async () => {
    const a = await account('Soylent');
    await assigned(a, ash, null);
    await runOutbox(t.tenantId);
    const b = (await view(await batchIdOf(a)))!;
    expect(b.name).toMatch(new RegExp(`· Soylent to ${await firstName(ash)}$`));
    expect(b.messages).toHaveLength(1);
  });

  it('a failed handoff is listed under Not sent yet with its reason and left out of the text (CRM-E4-S2-AC2)', async () => {
    const [ok, bad] = [await account('Wayne Co'), await account('Stark Co')];
    const blk = newId('blk');
    await assigned(ok, mike, blk);
    await assigned(bad, noOwner, blk);
    await runOutbox(t.tenantId);

    const b = (await view(await batchIdOf(ok)))!;
    expect(b.notSentYet).toEqual([{ accountName: 'Stark Co', reason: "This seller isn't linked to a CRM owner" }]);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.sellerUserId).toBe(mike);
    expect(b.messages[0]!.text).toContain('Wayne Co');
    expect(b.messages[0]!.text).not.toContain('Stark Co');
    expect(b.messages[0]!.text).toContain('1 new account is in HubSpot');
    expect(b.handoffs.map((h) => h.status).sort()).toEqual(['completed', 'failed']);
  });

  it('copying records copied_at', async () => {
    const a = await account('Umbrella');
    await assigned(a, mike, null);
    await runOutbox(t.tenantId);
    const b = (await view(await batchIdOf(a)))!;
    const msg = b.messages[0]!;
    const copied = await t.run((ctx) => markCopied(ctx, msg.id));
    expect(copied.copiedAt).toBeInstanceOf(Date);
    const [row] = await t.run((ctx) => ctx.tx.select().from(handoffMessage).where(eq(handoffMessage.id, msg.id)));
    expect(row!.copiedAt).not.toBeNull();
  });

  it('batches list newest first and page by cursor', async () => {
    const a = await account('Newest Co');
    await assigned(a, ash, null);
    await runOutbox(t.tenantId);
    const newest = await batchIdOf(a);

    const page1 = await t.run((ctx) => listBatches(ctx, { limit: 2 }));
    expect(page1.items[0]!.id).toBe(newest);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await t.run((ctx) => listBatches(ctx, { limit: 2, cursor: page1.nextCursor! }));
    expect(page2.items.length).toBeGreaterThan(0);
    const all = await t.run((ctx) => ctx.tx.select().from(handoffBatch).orderBy(handoffBatch.createdAt, handoffBatch.id));
    const order = [...page1.items, ...page2.items].map((x) => x.id);
    expect(order).toEqual(all.map((r) => r.id).reverse().slice(0, order.length));
    expect(order[0]).toBe(newest);
  });
});

describe('batches seen through a data limit (final review I3)', () => {
  const as = (userId: string, dataLimit: DataLimit) => ({ userId, dataLimit });
  const viewAs = (id: string, who: { userId: string; dataLimit: DataLimit }) => asPerson(t, (ctx) => getBatch(ctx, id), who);
  const listAs = async (who: { userId: string; dataLimit: DataLimit }) => {
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await asPerson(t, (ctx) => listBatches(ctx, { limit: 100, ...(cursor ? { cursor } : {}) }), who);
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  };

  it('a seller limited to own accounts sees only their handoffs, with no batch name and no message text', async () => {
    const [mine, theirs] = [await account('Mine Co'), await account('Theirs Co')];
    await setSummary(t, mine, { ownerUserId: mike });
    const blk = newId('blk');
    await assigned(mine, mike, blk);
    await assigned(theirs, ash, blk);
    await runOutbox(t.tenantId);
    const id = await batchIdOf(mine);
    const seller = as(mike, { kind: 'own_accounts' });

    const b = (await viewAs(id, seller))!;
    expect(b.name).toBeNull();
    expect(b.handoffs.map((h) => h.accountId)).toEqual([mine]);
    expect(b.messages.length).toBeGreaterThan(0);
    expect(b.messages.every((m) => m.text === null && m.restricted)).toBe(true);
    expect(JSON.stringify(b)).not.toContain('Theirs Co');
    expect((await listAs(seller)).find((x) => x.id === id)).toEqual(b);

    // A batch with nothing the seller can see is left out of the list and not found.
    const other = await account('Elsewhere Co');
    await assigned(other, ash, null);
    await runOutbox(t.tenantId);
    const hidden = await batchIdOf(other);
    expect(await viewAs(hidden, seller)).toBeNull();
    expect((await listAs(seller)).map((x) => x.id)).not.toContain(hidden);
    // Unlimited, everything shows.
    expect((await view(id))!.name).toEqual(expect.any(String));
    expect((await view(id))!.messages.every((m) => typeof m.text === 'string' && !m.restricted)).toBe(true);
  });

  it('a leader limited by practice sees a batch of their practice whole, and a mixed one restricted', async () => {
    const practice = newId('prc');
    const [inside, inside2, outside] = [await account('Inside Co'), await account('Inside Two'), await account('Outside Co')];
    await setSummary(t, inside, { practiceId: practice });
    await setSummary(t, inside2, { practiceId: practice });
    const whole = newId('blk');
    await assigned(inside2, mike, whole);
    const mixed = newId('blk');
    await assigned(inside, mike, mixed);
    await assigned(outside, ash, mixed);
    const leader = await member(t, 'leader');
    await runOutbox(t.tenantId);
    const who = as(leader, { kind: 'practices', ids: [practice] });

    const w = (await viewAs(await batchIdOf(inside2), who))!;
    expect(w.name).toContain('Inside Two');
    expect(w.messages.every((m) => typeof m.text === 'string' && m.text.includes('Inside Two') && !m.restricted)).toBe(true);

    const m = (await viewAs(await batchIdOf(inside), who))!;
    expect(m.name).toBeNull();
    expect(m.handoffs.map((h) => h.accountId)).toEqual([inside]);
    expect(m.messages.every((x) => x.text === null && x.restricted)).toBe(true);
    expect(JSON.stringify(m)).not.toContain('Outside Co');
  });
});
