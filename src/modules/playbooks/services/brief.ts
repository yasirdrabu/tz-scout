import { and, eq } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { getAccountReview } from '@/modules/routing';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob } from '@/platform/events/outbox';
import { briefDraftJob } from '../contracts/jobs';
import type { DraftState } from '../contracts/types';
import { brief } from '../db/schema';

export type BriefRow = typeof brief.$inferSelect;

/** A draft still "drafting" after this long lost its job (dead-lettered); the next request queues a new one. */
export const STALE_DRAFT_MS = 15 * 60 * 1000;

export const briefWhere = (ctx: ModuleContext, accountId: string) => and(eq(brief.tenantId, ctx.tenantId), eq(brief.accountId, accountId));

export async function readBrief(ctx: ModuleContext, accountId: string, opts: { lock?: boolean } = {}): Promise<BriefRow | undefined> {
  const q = ctx.tx.select().from(brief).where(briefWhere(ctx, accountId));
  const [row] = await (opts.lock ? q.for('update') : q);
  return row;
}

/** The brief row, created empty when the account has none. Locked for update. */
export async function ensureBrief(ctx: ModuleContext, accountId: string): Promise<BriefRow> {
  await ctx.tx.insert(brief).values({ tenantId: ctx.tenantId, accountId }).onConflictDoNothing();
  return (await readBrief(ctx, accountId, { lock: true }))!;
}

export type DraftRequest = {
  /** A person asked: Claude at any tier, a fresh run, and allowed while frozen. */
  manual?: boolean;
  /** Edited sections the draft may overwrite. */
  includeEdited?: string[];
  /** Only for an account that already has a brief row (the redraft triggers). */
  onlyExisting?: boolean;
};


const isStale = (row: BriefRow, now: Date) => row.draftState === 'drafting' && now.getTime() - row.updatedAt.getTime() > STALE_DRAFT_MS;
/** Frozen once a first draft exists: automatic redrafts stop (an account assigned before its first draft still gets one). */
export const isFrozen = (row: Pick<BriefRow, 'frozenAt' | 'draftedAt'>) => !!row.frozenAt && !!row.draftedAt;

/** Ends a stuck "drafting" with nothing left to draft: every request so far counts as drafted. */
export async function settleStuck(ctx: ModuleContext, row: BriefRow, now: Date): Promise<DraftState> {
  const state: DraftState = row.draftedAt ? 'ready' : 'not_drafted';
  await ctx.tx.update(brief).set({ draftState: state, draftedSeq: row.requestedSeq, updatedAt: now }).where(briefWhere(ctx, row.accountId));
  return state;
}

/**
 * Asks for a draft (Rulings 2 and 3): bumps `requested_seq` and queues `playbooks.brief.draft` unless one is already
 * drafting, which then sees the bump and runs again. Automatic requests do nothing while the brief is frozen. A manual
 * request marks `manual_seq`, so the draft that takes it runs as manual; one made while a manual draft is still pending
 * and asks for nothing more joins it (a double click spends once). A draft stuck past STALE_DRAFT_MS is queued again.
 */
export async function requestDraft(ctx: ModuleContext, accountId: string, req: DraftRequest = {}): Promise<{ state: DraftState; queued: boolean }> {
  const manual = req.manual ?? false;
  const keys = [...new Set(req.includeEdited ?? [])];
  const now = new Date();
  let id = accountId;
  if (manual) {
    const account = await getAccount(ctx, accountId);
    if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
    id = account.id;
  }
  if (req.onlyExisting && !(await readBrief(ctx, id))) return { state: 'not_drafted', queued: false };
  const row = await ensureBrief(ctx, id);
  const stale = isStale(row, now);
  if (!manual && isFrozen(row)) {
    return { state: stale ? await settleStuck(ctx, row, now) : (row.draftState as DraftState), queued: false };
  }
  const manualPending = row.draftState === 'drafting' && row.manualSeq > row.draftedSeq;
  if (manual && manualPending && !stale && keys.every((k) => row.pendingIncludeEdited.includes(k))) return { state: 'drafting', queued: false };
  const queue = row.draftState !== 'drafting' || stale;
  const seq = row.requestedSeq + 1;
  await ctx.tx
    .update(brief)
    .set({
      requestedSeq: seq,
      draftState: 'drafting',
      ...(manual ? { manualSeq: seq, pendingIncludeEdited: [...new Set([...row.pendingIncludeEdited, ...keys])] } : {}),
      ...(queue ? { updatedAt: now } : {}),
    })
    .where(briefWhere(ctx, id));
  if (queue) await enqueueJob(ctx, briefDraftJob, { accountId: id, manual, includeEdited: keys, seq });
  return { state: 'drafting', queued: queue };
}

/**
 * `routing.assignment.created`: the brief the AE and HubSpot got stays put. Consumers are not ordered against each
 * other, so a freeze for an assignment that is no longer the account's open one (declined or replaced first) is ignored.
 */
export async function freezeBrief(ctx: ModuleContext, accountId: string, assignmentId: string, at: Date): Promise<void> {
  const open = await openAssignmentId(ctx, accountId);
  if (open !== assignmentId) return;
  await ensureBrief(ctx, accountId);
  await ctx.tx.update(brief).set({ frozenAt: at, frozenByAssignmentId: assignmentId }).where(briefWhere(ctx, accountId));
}

/**
 * `routing.assignment.declined` or `.withdrawn`: only the assignment that froze the brief unfreezes it. A withdrawal
 * replaced by a new assignment hands the freeze on to it. Otherwise automatic redrafts start again, with one now.
 */
export async function unfreezeBrief(ctx: ModuleContext, accountId: string, assignmentId: string, replacedBy: string | null = null): Promise<void> {
  const row = await readBrief(ctx, accountId, { lock: true });
  if (!row || !row.frozenAt || row.frozenByAssignmentId !== assignmentId) return;
  if (replacedBy) {
    await ctx.tx.update(brief).set({ frozenByAssignmentId: replacedBy }).where(briefWhere(ctx, accountId));
    return;
  }
  await ctx.tx.update(brief).set({ frozenAt: null, frozenByAssignmentId: null }).where(briefWhere(ctx, accountId));
  await requestDraft(ctx, accountId);
}

async function openAssignmentId(ctx: ModuleContext, accountId: string): Promise<string | null> {
  try {
    return (await getAccountReview(ctx, accountId)).currentAssignment?.id ?? null;
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return null;
    throw e;
  }
}
