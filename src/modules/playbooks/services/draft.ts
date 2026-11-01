import { and, eq, sql } from 'drizzle-orm';
import { runTask, type AiMode } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { briefUpdated } from '../contracts/events';
import { briefDraftJob } from '../contracts/jobs';
import { BRIEF_KEYS, type BriefKey, type BriefOrigin } from '../contracts/types';
import { brief, briefSection, briefSectionHistory } from '../db/schema';
import { OUTPUT_KEY, type BriefOutput } from '../domain/brief-io';
import { isBuyerSafe } from '../domain/buyer-safe';
import { rulesBrief } from '../domain/rules-brief';
import { accountBriefTask } from '../tasks/account-brief';
import { briefWhere, readBrief } from './brief';
import { buildBriefInput, citableIds, type BuiltInput } from './inputs';

const CLAUDE_TIERS = new Set(['act_now', 'good_fit']);
const FALLBACK_SLUGS = new Set(['ai_failed', 'invalid_output']);
const ERROR_MAX = 300;

export type DraftJob = { accountId: string; manual: boolean; includeEdited: string[] };
type Run = { output: BriefOutput; runId: string; mode: AiMode; lastError: string | null };

const lockKey = (ctx: ModuleContext, accountId: string) => `plb:brief:${ctx.tenantId}:${accountId}`;
const sectionWhere = (ctx: ModuleContext, accountId: string, key: string) =>
  and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, accountId), eq(briefSection.key, key));

/** Claude when allowed; a live failure is stored as `last_error` and the brief comes from rules (Ruling 5). */
async function draftOutput(ctx: ModuleContext, built: BuiltInput, job: DraftJob): Promise<Run> {
  const subject = { type: 'account', id: built.accountId };
  const claudeAllowed = job.manual || CLAUDE_TIERS.has(built.tier);
  try {
    return { ...(await runTask(ctx, accountBriefTask, built.input, { subject, rulesOnly: !claudeAllowed, fresh: job.manual })), lastError: null };
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

/**
 * The `playbooks.brief.draft` job (Rulings 2 to 6): under the account's advisory lock, reads the request number,
 * drafts with no row lock, writes the sections that are still as read, then settles the request number and queues
 * itself again if more requests arrived meanwhile.
 */
export async function runDraft(ctx: ModuleContext, job: DraftJob, now: Date): Promise<void> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(ctx, job.accountId)}))`);
  const row = await readBrief(ctx, job.accountId);
  if (!row) return;
  const seq = row.requestedSeq;
  let wrote = false;
  const built = !job.manual && row.frozenAt && row.draftedAt ? null : await buildBriefInput(ctx, job.accountId);

  if (built) {
    const read = new Map(
      (await ctx.tx.select().from(briefSection).where(and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, job.accountId)))).map((s) => [
        s.key,
        { version: s.version, origin: s.origin },
      ]),
    );
    const run = await draftOutput(ctx, built, job);
    const { output, openerFromRules } = clean(built, run, now);
    const origin: BriefOrigin = run.mode === 'rules' ? 'rules' : 'ai';
    const written: BriefKey[] = [];
    for (const key of BRIEF_KEYS) {
      const s = output.sections[OUTPUT_KEY[key]];
      const values = { body: s.text, citations: s.citations, origin, mode: run.mode, aiRunId: run.runId, offerId: built.offerId };
      if (await writeSection(ctx, job.accountId, key, read.get(key), values, job.includeEdited, now)) written.push(key);
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

  const settled = wrote || row.draftedAt ? 'ready' : 'not_drafted';
  const [after] = await ctx.tx
    .update(brief)
    .set({
      draftedSeq: seq,
      draftState: sql`case when ${brief.requestedSeq} > ${seq} then 'drafting' else ${settled}::text end`,
      updatedAt: now,
    })
    .where(briefWhere(ctx, job.accountId))
    .returning({ requestedSeq: brief.requestedSeq });
  if (after && after.requestedSeq > seq) await enqueueJob(ctx, briefDraftJob, { accountId: job.accountId, manual: false, includeEdited: [] });
}
