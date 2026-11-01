import { and, eq, sql } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
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

/**
 * Asks for a draft (Rulings 2 and 3): bumps `requested_seq` and queues `playbooks.brief.draft` unless one is already
 * drafting, which then sees the bump and runs again. Automatic requests do nothing while the brief is frozen.
 * A manual request always queues its own job, so its flags are not lost; the advisory lock serializes the runs.
 */
export async function requestDraft(ctx: ModuleContext, accountId: string, req: DraftRequest = {}): Promise<{ state: DraftState; queued: boolean }> {
  const manual = req.manual ?? false;
  let id = accountId;
  if (manual) {
    const account = await getAccount(ctx, accountId);
    if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
    id = account.id;
  }
  if (req.onlyExisting && !(await readBrief(ctx, id))) return { state: 'not_drafted', queued: false };
  const row = await ensureBrief(ctx, id);
  // A frozen brief stays as the AE got it; an account assigned before its first draft still gets one.
  if (!manual && row.frozenAt && row.draftedAt) return { state: row.draftState as DraftState, queued: false };
  const stale = row.draftState === 'drafting' && Date.now() - row.updatedAt.getTime() > STALE_DRAFT_MS;
  const queue = manual || row.draftState !== 'drafting' || stale;
  await ctx.tx
    .update(brief)
    .set({ requestedSeq: sql`${brief.requestedSeq} + 1`, draftState: 'drafting', ...(queue ? { updatedAt: new Date() } : {}) })
    .where(briefWhere(ctx, id));
  if (queue) await enqueueJob(ctx, briefDraftJob, { accountId: id, manual, includeEdited: req.includeEdited ?? [] });
  return { state: 'drafting', queued: queue };
}

/** `routing.assignment.created`: the brief the AE and HubSpot got stays put. */
export async function freezeBrief(ctx: ModuleContext, accountId: string, at: Date): Promise<void> {
  await ensureBrief(ctx, accountId);
  await ctx.tx.update(brief).set({ frozenAt: at }).where(briefWhere(ctx, accountId));
}

/** `routing.assignment.declined` or `.withdrawn`: automatic redrafts start again, beginning with one now. */
export async function unfreezeBrief(ctx: ModuleContext, accountId: string): Promise<void> {
  const row = await readBrief(ctx, accountId, { lock: true });
  if (!row) return;
  if (row.frozenAt) await ctx.tx.update(brief).set({ frozenAt: null }).where(briefWhere(ctx, accountId));
  await requestDraft(ctx, accountId);
}
