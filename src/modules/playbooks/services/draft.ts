import { and, eq, sql } from 'drizzle-orm';
import { runTask, type AiMode } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { briefUpdated } from '../contracts/events';
import { briefDraftJob, DRAFT_MAX_ATTEMPTS } from '../contracts/jobs';
import { BRIEF_KEYS, type BriefKey, type BriefOrigin } from '../contracts/types';
import { brief, briefSection, briefSectionHistory } from '../db/schema';
import { OUTPUT_KEY, type BriefOutput } from '../domain/brief-io';
import { isBuyerSafe } from '../domain/buyer-safe';
import { rulesBrief } from '../domain/rules-brief';
import { accountBriefTask } from '../tasks/account-brief';
import { briefWhere, isFrozen, readBrief } from './brief';
import { buildBriefInput, citableIds, type BuiltInput } from './inputs';

const CLAUDE_TIERS = new Set(['act_now', 'good_fit']);
const FALLBACK_SLUGS = new Set(['ai_failed', 'invalid_output']);
const ERROR_MAX = 300;

export type DraftJob = { accountId: string; manual: boolean; includeEdited: string[]; seq?: number };
/** The delivery: its id counts the runs, and a manual run reuses only Claude runs made since it was queued. */
export type DraftMeta = { jobId: string; queuedAt: Date };
type Plan = { manual: boolean; includeEdited: string[]; lastAttempt: boolean; queuedAt: Date };
type Run = { output: BriefOutput; runId: string; mode: AiMode; lastError: string | null };

const lockKey = (ctx: ModuleContext, accountId: string) => `plb:brief:${ctx.tenantId}:${accountId}`;
const sectionWhere = (ctx: ModuleContext, accountId: string, key: string) =>
  and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, accountId), eq(briefSection.key, key));

/**
 * Claude when allowed; a live failure is stored as `last_error` and the brief comes from rules (Ruling 5). The last
 * attempt drafts from rules only, so it cannot time out on Claude. A manual run is fresh, but reuses a Claude run made
 * since the job was queued: a retry after a timeout does not pay again.
 */
async function draftOutput(ctx: ModuleContext, built: BuiltInput, plan: Plan): Promise<Run> {
  const subject = { type: 'account', id: built.accountId };
  const claudeAllowed = !plan.lastAttempt && (plan.manual || CLAUDE_TIERS.has(built.tier));
  try {
    const r = await runTask(ctx, accountBriefTask, built.input, {
      subject,
      accountId: built.accountId,
      rulesOnly: !claudeAllowed,
      ...(plan.manual ? { fresh: true, reuseAfter: plan.queuedAt } : {}),
    });
    return { ...r, lastError: null };
  } catch (e) {
    if (!(e instanceof ScoutError && FALLBACK_SLUGS.has(e.slug))) throw e;
    const r = await runTask(ctx, accountBriefTask, built.input, { subject, rulesOnly: true });
    return { ...r, lastError: `${e.message}${e.detail ? ` ${e.detail}` : ''}`.slice(0, ERROR_MAX) };
  }
}

/** Drops citations the input never gave, and an opener that is not buyer safe (Ruling 6). */
function clean(built: BuiltInput, run: Run, now: Date): { output: BriefOutput; openerFromRules: boolean } {
  const ids = citableIds(built.input);
  const o = run.output;
  const sections = Object.fromEntries(
    Object.entries(o.sections).map(([k, s]) => [k, { ...s, citations: [...new Set(s.citations.filter((c) => ids.has(c)))] }]),
  ) as BriefOutput['sections'];
  const safe = isBuyerSafe(`${o.opener.subject}\n${o.opener.body}`, built.input.signals);
  const whoFirst = o.whoFirst.personId && !built.input.people.some((p) => p.id === o.whoFirst.personId) ? { ...o.whoFirst, personId: null } : o.whoFirst;
  return {
    output: { ...o, sections, whoFirst, opener: safe ? o.opener : rulesBrief(built.input, now).opener },
    openerFromRules: run.mode === 'rules' || !safe,
  };
}

/**
 * Writes one section unless a person wrote it (and the request did not name it) or it changed since it was read
 * (Ruling 4). The old row goes to history first. Returns whether it wrote.
 */
async function writeSection(
  ctx: ModuleContext,
  accountId: string,
  key: BriefKey,
  read: { version: number; origin: string } | undefined,
  values: { body: string; citations: string[]; origin: BriefOrigin; mode: AiMode; aiRunId: string; offerId: string | null },
  includeEdited: string[],
  now: Date,
): Promise<boolean> {
  if (read?.origin === 'human' && !includeEdited.includes(key)) return false;
  const fresh = { ...values, editedBy: null, editedByName: null, editedAt: null, updatedAt: now };
  if (!read) {
    const made = await ctx.tx
      .insert(briefSection)
      .values({ tenantId: ctx.tenantId, accountId, key, ...fresh, version: 1 })
      .onConflictDoNothing()
      .returning({ key: briefSection.key });
    return made.length > 0;
  }
  const [current] = await ctx.tx.select().from(briefSection).where(sectionWhere(ctx, accountId, key)).for('update');
  if (!current || current.version !== read.version) return false;
  await ctx.tx.insert(briefSectionHistory).values({ ...current, recordedAt: now });
  await ctx.tx
    .update(briefSection)
    .set({ ...fresh, version: current.version + 1 })
    .where(and(sectionWhere(ctx, accountId, key), eq(briefSection.version, current.version)));
  return true;
}


/** Counts this delivery's run in its own transaction, so a run that times out or rolls back still counts. */
async function countAttempt(ctx: ModuleContext, accountId: string, jobId: string): Promise<number> {
  return withTenant(ctx.tenantId, async (tx) => {
    const [r] = await tx
      .update(brief)
      .set({
        draftAttempts: sql`case when ${brief.draftJobId} = ${jobId} then ${brief.draftAttempts} + 1 else 1 end`,
        draftJobId: jobId,
      })
      .where(briefWhere(ctx, accountId))
      .returning({ attempts: brief.draftAttempts });
    return r?.attempts ?? 1;
  });
}

/**
 * The `playbooks.brief.draft` job (Rulings 2 to 6).
 * - Takes the account's advisory lock without waiting: when another draft holds it, the delivery fails and the worker
 *   retries it after the backoff (the holder may roll back), and the retry finds its request drafted or drafts it.
 * - Ends at once when a newer draft already reached the request it was queued for (`seq`).
 * - Reads the request number S, drafts with no row lock, then locks the brief row and writes the sections that are
 *   still as read, unless the brief was frozen meanwhile (an assignment landed during the draft).
 * - Settles S and queues itself again if more requests arrived meanwhile.
 */
export async function runDraft(ctx: ModuleContext, job: DraftJob, meta: DraftMeta, now: Date): Promise<void> {
  const [lock] = (await ctx.tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${lockKey(ctx, job.accountId)})) as got`)) as unknown as { got: boolean }[];
  // Another draft holds the account. Fail this delivery so the worker tries it again after the backoff: if the holder
  // rolls back (a timeout), this request is still drafted; if it commits, the retry finds the request covered.
  if (!lock?.got) throw new ScoutError({ slug: 'draft_busy', status: 409, title: 'Another draft of this brief is running. This one will try again.' });
  const row = await readBrief(ctx, job.accountId);
  if (!row) return;
  if (job.seq !== undefined && row.draftedSeq >= job.seq) return;
  const attempt = await countAttempt(ctx, job.accountId, meta.jobId);
  const seq = row.requestedSeq;
  const plan: Plan = {
    manual: job.manual || row.manualSeq > row.draftedSeq,
    includeEdited: [...new Set([...job.includeEdited, ...row.pendingIncludeEdited])],
    lastAttempt: attempt >= DRAFT_MAX_ATTEMPTS,
    queuedAt: meta.queuedAt,
  };
  let wrote = false;
  const built = !plan.manual && isFrozen(row) ? null : await buildBriefInput(ctx, job.accountId);

  if (built) {
    const read = new Map(
      (await ctx.tx.select().from(briefSection).where(and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, job.accountId)))).map((s) => [
        s.key,
        { version: s.version, origin: s.origin },
      ]),
    );
    const run = await draftOutput(ctx, built, plan);
    const { output, openerFromRules } = clean(built, run, now);
    // An assignment that landed while Claude was writing froze the brief: the AE keeps what they got.
    const current = await readBrief(ctx, job.accountId, { lock: true });
    if (current && (plan.manual || !isFrozen(current))) {
      const origin: BriefOrigin = run.mode === 'rules' ? 'rules' : 'ai';
      const written: BriefKey[] = [];
      for (const key of BRIEF_KEYS) {
        const s = output.sections[OUTPUT_KEY[key]];
        const values = { body: s.text, citations: s.citations, origin, mode: run.mode, aiRunId: run.runId, offerId: built.offerId };
        if (await writeSection(ctx, job.accountId, key, read.get(key), values, plan.includeEdited, now)) written.push(key);
      }
      await ctx.tx
        .update(brief)
        .set({
          offerId: built.offerId,
          mode: run.mode,
          aiRunId: run.runId,
          recommendationHeadline: output.recommendation.headline,
          recommendationDetail: output.recommendation.detail,
          recommendationOrigin: origin,
          openerSubject: output.opener.subject,
          openerBody: output.opener.body,
          openerOrigin: openerFromRules ? 'rules' : 'ai',
          whoFirstPersonId: output.whoFirst.personId,
          whoFirstTitle: output.whoFirst.title,
          whoFirstReason: output.whoFirst.reason,
          lastError: run.lastError,
          draftedAt: now,
        })
        .where(briefWhere(ctx, job.accountId));
      await publish(ctx, briefUpdated, { accountId: job.accountId, sectionKeys: written, origin, mode: run.mode }, { type: 'account', id: job.accountId });
      wrote = true;
    }
  }

  const settled = wrote || row.draftedAt ? 'ready' : 'not_drafted';
  const taken = plan.includeEdited;
  const [after] = await ctx.tx
    .update(brief)
    .set({
      draftedSeq: seq,
      draftState: sql`case when ${brief.requestedSeq} > ${seq} then 'drafting' else ${settled}::text end`,
      // Keys asked for after this run read them stay for the next one.
      pendingIncludeEdited: sql`array(select unnest(${brief.pendingIncludeEdited}) except select jsonb_array_elements_text(${JSON.stringify(taken)}::jsonb))`,
      updatedAt: now,
    })
    .where(briefWhere(ctx, job.accountId))
    .returning({ requestedSeq: brief.requestedSeq });
  if (after && after.requestedSeq > seq) {
    await enqueueJob(ctx, briefDraftJob, { accountId: job.accountId, manual: false, includeEdited: [], seq: after.requestedSeq });
  }
}
