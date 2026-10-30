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
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';
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
    expect(toMike.text.endsWith(await firstName(t.actor.id))).toBe(true);
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
