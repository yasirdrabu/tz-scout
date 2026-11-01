import { and, desc, eq, sql } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { activity, followThrough, handoff } from '../db/schema';
import { activityEntry, afterCursor, newestFirst, scoutEntries, type ActivityEntry } from '../domain/activity';
import { ownerName } from './owners';

export const ACTIVITY_PAGE = 25;

export type ActivityCursor = { at: string; id: string };

const badCursor = () => new ScoutError({ slug: 'validation', status: 400, title: 'That cursor is not valid.', errors: [{ path: 'cursor', message: 'That cursor is not valid.' }] });

/** A cursor as `encodeCursor` gave it back, checked. */
export function activityCursor(v: Record<string, unknown> | null): ActivityCursor | null {
  if (v === null) return null;
  if (typeof v.at !== 'string' || typeof v.id !== 'string' || Number.isNaN(new Date(v.at).getTime())) throw badCursor();
  return { at: v.at, id: v.id };
}

/**
 * The account's HubSpot activity and Scout's own actions, newest first (screens.md §4b item 3): up to `limit + 1`
 * rows after the cursor, so the caller can tell there is another page. `syncedAt` is when follow-through was last
 * read for the latest completed handoff. Not found when the caller can't see the account.
 */
export async function listActivity(
  ctx: ModuleContext,
  accountId: string,
  cursor: ActivityCursor | null,
  limit = ACTIVITY_PAGE,
): Promise<{ rows: ActivityEntry[]; syncedAt: Date | null }> {
  const account = await getAccount(ctx, accountId);
  if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  const id = account.id;
  // Ids compare byte-wise ("C") in SQL and in JS, so the cursor means the same in both.
  const crm = await ctx.tx
    .select({ id: activity.id, kind: activity.kind, occurredAt: activity.occurredAt })
    .from(activity)
    .where(
      and(
        eq(activity.tenantId, ctx.tenantId),
        eq(activity.accountId, id),
        cursor ? sql`(${activity.occurredAt} < ${cursor.at}::timestamptz or (${activity.occurredAt} = ${cursor.at}::timestamptz and ${activity.id} collate "C" < ${cursor.id}))` : undefined,
      ),
    )
    .orderBy(desc(activity.occurredAt), sql`${activity.id} collate "C" desc`)
    .limit(limit + 1);

  const handoffs = await ctx.tx
    .select()
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, id)))
    .orderBy(desc(handoff.queuedAt), desc(handoff.id));
  const people = await members(ctx);
  const scout: ActivityEntry[] = [];
  for (const h of handoffs) {
    scout.push(
      ...scoutEntries(h, {
        seller: people.find((m) => m.userId === h.sellerUserId)?.name ?? null,
        owner: h.ownerExternalId ? await ownerName(ctx, h.system, h.ownerExternalId) : null,
        returnedTo: h.undone?.ownerReturnedTo ? await ownerName(ctx, h.system, h.undone.ownerReturnedTo) : null,
      }),
    );
  }
  const rows = [...crm.map(activityEntry), ...scout].filter(afterCursor(cursor)).sort(newestFirst).slice(0, limit + 1);

  const completed = handoffs.find((h) => h.status === 'completed');
  const [ft] = completed
    ? await ctx.tx
        .select({ checkedAt: followThrough.checkedAt })
        .from(followThrough)
        .where(and(eq(followThrough.tenantId, ctx.tenantId), eq(followThrough.handoffId, completed.id)))
    : [];
  return { rows, syncedAt: ft?.checkedAt ?? null };
}
