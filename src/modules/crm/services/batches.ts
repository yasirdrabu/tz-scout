import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { accountNames, filterVisibleAccountIds, getAccounts, type AccountView } from '@/modules/accounts';
import { connectionSettings } from '@/modules/integrations';
import { members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { handoffPackageProvider } from '../contracts/ports';
import { DEFAULT_FOLLOW_UP_DAYS } from '../contracts/types';
import { crmSetting, followThrough, handoff, handoffBatch, handoffMessage as messageTable } from '../db/schema';
import { batchName, notSentReason, NOT_SENT_STATUSES } from '../domain/batch';
import { countsOfRow, type FollowThroughCounts } from '../domain/follow-through';
import { handoffMessages } from '../domain/message';

type Handoff = typeof handoff.$inferSelect;

const personName = (p: AccountView['people'][number]) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '';

/** The handoff batch for a bulk run, found or made; a null key makes a batch of its own (Ruling 8). */
export async function batchFor(ctx: ModuleContext, bulkKey: string | null, createdBy: string): Promise<string> {
  const id = newId('hbt');
  await ctx.tx.insert(handoffBatch).values({ id, tenantId: ctx.tenantId, bulkKey, createdBy }).onConflictDoNothing();
  if (!bulkKey) return id;
  const [row] = await ctx.tx
    .select({ id: handoffBatch.id })
    .from(handoffBatch)
    .where(and(eq(handoffBatch.tenantId, ctx.tenantId), eq(handoffBatch.bulkKey, bulkKey)));
  return row!.id;
}

/**
 * Rewrites the batch name and one message per seller, listing only completed handoffs (CRM-E4-S2-AC2).
 * Called whenever a handoff of the batch completes, fails, needs a decision or is cancelled. The batch row
 * lock serialises two handoffs of one batch settling at once.
 */
export async function refreshBatch(ctx: ModuleContext, batchId: string): Promise<void> {
  const [batch] = await ctx.tx
    .select()
    .from(handoffBatch)
    .where(and(eq(handoffBatch.tenantId, ctx.tenantId), eq(handoffBatch.id, batchId)))
    .for('update');
  if (!batch) return;
  const rows = await ctx.tx
    .select()
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.handoffBatchId, batchId)))
    .orderBy(handoff.queuedAt, handoff.id);
  const [setting] = await ctx.tx.select({ days: crmSetting.followUpDays }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const timezone = await tenantTimezone(ctx);
  const people = await members(ctx);
  const nameOfUser = (id: string | null) => people.find((m) => m.userId === id)?.name ?? null;
  const accounts = new Map((await getAccounts(ctx, [...new Set(rows.map((r) => r.accountId))])).map((a) => [a.id, a]));

  await ctx.tx
    .update(handoffBatch)
    .set({ name: batchName(rows.map((r) => ({ name: accounts.get(r.accountId)?.name ?? 'An account', seller: nameOfUser(r.sellerUserId) ?? 'Unassigned' })), batch.createdAt, timezone) })
    .where(and(eq(handoffBatch.tenantId, ctx.tenantId), eq(handoffBatch.id, batchId)));

  const portal = (await connectionSettings(ctx, 'hubspot')).portal_id;
  const sent: Parameters<typeof handoffMessages>[0]['accounts'] = [];
  for (const h of rows) {
    const a = accounts.get(h.accountId);
    if (h.status !== 'completed' || h.undone || !h.sellerUserId || !a) continue;
    const buyer = a.people.find((p) => p.isPrimary && personName(p)) ?? a.people.find((p) => personName(p));
    const best = (await handoffPackageProvider().package(ctx, h.accountId, h.assignmentId))?.properties.best_offer;
    sent.push({
      sellerId: h.sellerUserId,
      seller: nameOfUser(h.sellerUserId),
      name: a.name,
      domain: a.domain ?? '',
      offer: typeof best === 'string' && best.trim() ? best : null,
      buyer: buyer ? { name: personName(buyer), title: buyer.title, email: buyer.email } : null,
      crmUrl: (typeof portal === 'string' || typeof portal === 'number') && portal !== '' && h.companyExternalId
        ? `https://app.hubspot.com/contacts/${portal}/record/0-2/${h.companyExternalId}`
        : null,
    });
  }
  const messages = handoffMessages({
    from: nameOfUser(batch.createdBy),
    at: batch.createdAt,
    timezone,
    followUpDays: setting?.days ?? DEFAULT_FOLLOW_UP_DAYS,
    accounts: sent,
  });
  for (const m of messages) {
    await ctx.tx
      .insert(messageTable)
      .values({ id: newId('hmg'), tenantId: ctx.tenantId, handoffBatchId: batchId, sellerUserId: m.sellerId!, count: m.count, text: m.text })
      .onConflictDoUpdate({
        target: [messageTable.tenantId, messageTable.handoffBatchId, messageTable.sellerUserId],
        set: { count: m.count, text: m.text },
      });
  }
  const keep = messages.map((m) => m.sellerId!);
  await ctx.tx
    .delete(messageTable)
    .where(and(eq(messageTable.tenantId, ctx.tenantId), eq(messageTable.handoffBatchId, batchId), keep.length ? notInArray(messageTable.sellerUserId, keep) : undefined));
}

/**
 * A batch as the reader may see it (final review I3): only handoffs of accounts inside the reader's data limit. When
 * any handoff of the batch is outside it, the name and the message texts (which name every account) are withheld:
 * `name` is null and each message has `text` null and `restricted` true.
 */
export type BatchView = {
  id: string;
  name: string | null;
  createdBy: string;
  createdAt: Date;
  handoffs: {
    id: string;
    accountId: string;
    accountName: string;
    sellerUserId: string | null;
    sellerName: string | null;
    status: string;
    followThrough: FollowThroughCounts | null;
  }[];
  messages: { id: string; sellerUserId: string; sellerName: string | null; count: number; text: string | null; restricted: boolean; copiedAt: Date | null; sentAt: Date | null }[];
  notSentYet: { accountName: string; reason: string }[];
};

/** The views of these batches; a batch with no handoff the reader can see is left out. */
async function views(ctx: ModuleContext, batches: (typeof handoffBatch.$inferSelect)[]): Promise<BatchView[]> {
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);
  const all = await ctx.tx
    .select()
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), inArray(handoff.handoffBatchId, ids)))
    .orderBy(handoff.queuedAt, handoff.id);
  const visible = new Set(await filterVisibleAccountIds(ctx, [...new Set(all.map((r) => r.accountId))]));
  const rows = all.filter((r) => visible.has(r.accountId));
  const restricted = new Set(all.filter((r) => !visible.has(r.accountId)).map((r) => r.handoffBatchId));
  const msgs = await ctx.tx
    .select()
    .from(messageTable)
    .where(and(eq(messageTable.tenantId, ctx.tenantId), inArray(messageTable.handoffBatchId, ids)))
    .orderBy(messageTable.id);
  const ft = rows.length
    ? await ctx.tx
        .select()
        .from(followThrough)
        .where(and(eq(followThrough.tenantId, ctx.tenantId), inArray(followThrough.handoffId, rows.map((r) => r.id))))
    : [];
  const ftBy = new Map(ft.map((f) => [f.handoffId, countsOfRow(f, null, new Date())]));
  const names = await accountNames(ctx, [...new Set(rows.map((r) => r.accountId))]);
  const people = await members(ctx);
  const nameOfUser = (id: string | null) => people.find((m) => m.userId === id)?.name ?? null;
  const accountName = (h: Handoff) => names.get(h.accountId) ?? 'An account you cannot see';

  return batches.flatMap((b) => {
    const mine = rows.filter((r) => r.handoffBatchId === b.id);
    if (mine.length === 0) return [];
    const hidden = restricted.has(b.id);
    return {
      id: b.id,
      name: hidden ? null : b.name,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      handoffs: mine.map((h) => ({
        id: h.id,
        accountId: h.accountId,
        accountName: accountName(h),
        sellerUserId: h.sellerUserId,
        sellerName: nameOfUser(h.sellerUserId),
        status: h.status,
        followThrough: ftBy.get(h.id) ?? null,
      })),
      messages: msgs
        .filter((m) => m.handoffBatchId === b.id)
        .map((m) => ({
          id: m.id,
          sellerUserId: m.sellerUserId,
          sellerName: nameOfUser(m.sellerUserId),
          count: m.count,
          text: hidden ? null : m.text,
          restricted: hidden,
          copiedAt: m.copiedAt,
          sentAt: m.sentAt,
        })),
      notSentYet: mine.filter((h) => NOT_SENT_STATUSES.includes(h.status as never)).map((h) => ({ accountName: accountName(h), reason: notSentReason(h) })),
    };
  });
}

/** One batch, or null when it does not exist or has no handoff the reader can see. */
export async function getBatch(ctx: ModuleContext, id: string): Promise<BatchView | null> {
  const rows = await ctx.tx.select().from(handoffBatch).where(and(eq(handoffBatch.tenantId, ctx.tenantId), eq(handoffBatch.id, id)));
  return (await views(ctx, rows))[0] ?? null;
}

/**
 * Newest first (CRM-E4-S1-AC1). The cursor is the last batch's id; its position is read from its row. A batch the
 * reader can see none of is left out, so a page may hold fewer than `limit`.
 */
export async function listBatches(ctx: ModuleContext, opts: { cursor?: string; limit?: number } = {}): Promise<{ items: BatchView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const after = opts.cursor
    ? sql`(${handoffBatch.createdAt}, ${handoffBatch.id}) < (select b.created_at, b.id from crm.handoff_batch b where b.tenant_id = ${ctx.tenantId} and b.id = ${opts.cursor})`
    : undefined;
  const rows = await ctx.tx
    .select()
    .from(handoffBatch)
    .where(and(eq(handoffBatch.tenantId, ctx.tenantId), after))
    .orderBy(desc(handoffBatch.createdAt), desc(handoffBatch.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: await views(ctx, page), nextCursor: rows.length > limit && last ? last.id : null };
}

/** Records that a leader copied a seller's message (CRM-E4-S2-AC1). */
export async function markCopied(ctx: ModuleContext, messageId: string): Promise<{ id: string; copiedAt: Date }> {
  const [row] = await ctx.tx
    .update(messageTable)
    .set({ copiedAt: sql`now()` })
    .where(and(eq(messageTable.tenantId, ctx.tenantId), eq(messageTable.id, messageId)))
    .returning({ id: messageTable.id, copiedAt: messageTable.copiedAt });
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That message was not found.' });
  return { id: row.id, copiedAt: row.copiedAt! };
}
