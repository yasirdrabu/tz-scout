import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { tenantTimezone } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { accountReview, assignment, declineReasonDef, reviewStatusDef, routingSetting, statusChange } from '../db/schema';
import { DEFAULT_AUTO_ACCEPT_WORKING_DAYS, DEFAULT_REASONS, DEFAULT_STATUSES, seedRoutingDefaults } from '../defaults';
import { isFinal, isRequired, keyFor, STATUS_COLOR_OPTIONS, reasonEditProblems, statusEditProblems, type Problem, type ReasonEdit, type StatusEdit } from '../domain/review-settings';
import type { ReasonList } from '../domain/status-rules';
import { applyStatusChange, lockRow, requirePerson } from './review';
import { publishReviewSnapshot } from './snapshot';

export type StatusView = {
  key: string;
  label: string;
  order: number;
  color: string;
  description: string;
  setBy: string;
  /** Null is never; a final status (one that counts as reviewed) is never flagged. */
  flagAfterHours: number | null;
  countsAsReviewed: boolean;
  isDeclined: boolean;
  isInitial: boolean;
  returnsToSource: boolean;
  isFinal: boolean;
  /** Scout needs it (the first status, a reviewed or declined one, send back): it can be renamed and recolored, not archived. */
  required: boolean;
  archived: boolean;
  /** "In it now" and "{n} late", tenant-wide; null for a caller who can't manage settings. */
  inStatusCount: number | null;
  lateCount: number | null;
};

export type ReasonView = {
  key: string;
  label: string;
  appliesTo: ReasonList;
  noteRequired: boolean;
  order: number;
  archived: boolean;
  /** "{n} this quarter" (tenant timezone); null for a caller who can't manage settings. */
  usedThisQuarter: number | null;
};

export type ReviewSettings = {
  statuses: StatusView[];
  declineReasons: ReasonView[];
  /** 1 to 10 working days, or null when auto-acceptance is off. */
  autoAcceptWorkingDays: number | null;
  /** The colors a status can take, with their words (the editor's picker). */
  colors: { value: string; label: string }[];
  /** Bumped by every write to the statuses, reasons or auto-accept; the editor's save sends back the one it loaded. */
  version: number;
};

/** Whether the lists carry tenant-wide counts (only for people who manage settings). */
export type ListOptions = { counts?: boolean };

const invalid = (problems: Problem[]) => new ScoutError({ slug: 'validation', status: 400, title: problems[0]!.message, errors: problems });

const statusRows = (ctx: ModuleContext) =>
  ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, ctx.tenantId)).orderBy(asc(reviewStatusDef.order), asc(reviewStatusDef.key));
const reasonRows = (ctx: ModuleContext) =>
  ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId)).orderBy(asc(declineReasonDef.order), asc(declineReasonDef.label));

/** Accounts in each status now, and how many have been in it longer than its "Flag after". */
async function statusCounts(ctx: ModuleContext): Promise<Map<string, { n: number; late: number }>> {
  const rows = await ctx.tx
    .select({
      key: accountReview.statusKey,
      n: sql<number>`count(*)::int`,
      late: sql<number>`(count(*) filter (where ${reviewStatusDef.flagAfterHours} is not null and ${accountReview.statusChangedAt} < now() - make_interval(hours => ${reviewStatusDef.flagAfterHours})))::int`,
    })
    .from(accountReview)
    .innerJoin(reviewStatusDef, and(eq(reviewStatusDef.tenantId, accountReview.tenantId), eq(reviewStatusDef.key, accountReview.statusKey)))
    .where(and(eq(accountReview.tenantId, ctx.tenantId), isNull(accountReview.mergedInto)))
    .groupBy(accountReview.statusKey);
  return new Map(rows.map((r) => [r.key, { n: r.n, late: r.late }]));
}

/** How often each reason was picked since the start of the quarter in the tenant's timezone: status changes and seller declines. */
async function reasonCounts(ctx: ModuleContext): Promise<Map<string, number>> {
  const tz = await tenantTimezone(ctx);
  const since = sql`date_trunc('quarter', now() at time zone ${tz}) at time zone ${tz}`;
  const changes = await ctx.tx
    .select({ key: statusChange.reasonKey, n: sql<number>`count(*)::int` })
    .from(statusChange)
    .where(and(eq(statusChange.tenantId, ctx.tenantId), gte(statusChange.at, since), sql`${statusChange.reasonKey} is not null`))
    .groupBy(statusChange.reasonKey);
  const declines = await ctx.tx
    .select({ key: assignment.declineReasonKey, n: sql<number>`count(*)::int` })
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.status, 'declined'), gte(assignment.respondedAt, since)))
    .groupBy(assignment.declineReasonKey);
  const out = new Map<string, number>();
  for (const r of [...changes, ...declines]) if (r.key) out.set(r.key, (out.get(r.key) ?? 0) + r.n);
  return out;
}

/** The review statuses in order, archived ones included (REV-E1-S4, Decision 2). */
export async function listStatuses(ctx: ModuleContext, opts: ListOptions = {}): Promise<StatusView[]> {
  const counts = opts.counts ? await statusCounts(ctx) : null;
  return (await statusRows(ctx)).map((s) => ({
    key: s.key,
    label: s.label,
    order: s.order,
    color: s.color,
    description: s.description,
    setBy: s.setBy,
    flagAfterHours: s.flagAfterHours,
    countsAsReviewed: s.countsAsReviewed,
    isDeclined: s.isDeclined,
    isInitial: s.isInitial,
    returnsToSource: s.returnsToSource,
    isFinal: isFinal(s),
    required: isRequired(s),
    archived: !!s.archivedAt,
    inStatusCount: counts ? (counts.get(s.key)?.n ?? 0) : null,
    lateCount: counts ? (counts.get(s.key)?.late ?? 0) : null,
  }));
}

/** Every reason (send back, review decline, seller decline), in order, archived ones included. */
export async function listReasons(ctx: ModuleContext, opts: ListOptions = {}): Promise<ReasonView[]> {
  const counts = opts.counts ? await reasonCounts(ctx) : null;
  return (await reasonRows(ctx)).map((r) => ({
    key: r.key,
    label: r.label,
    appliesTo: r.appliesTo as ReasonList,
    noteRequired: r.noteRequired,
    order: r.order,
    archived: !!r.archivedAt,
    usedThisQuarter: counts ? (counts.get(r.key) ?? 0) : null,
  }));
}

/** The statuses, reasons and the auto-accept setting, with counts (the settings screen). */
export async function getReviewSettings(ctx: ModuleContext): Promise<ReviewSettings> {
  const [setting] = await ctx.tx
    .select({ days: routingSetting.autoAcceptWorkingDays, version: routingSetting.version })
    .from(routingSetting)
    .where(eq(routingSetting.tenantId, ctx.tenantId));
  return {
    statuses: await listStatuses(ctx, { counts: true }),
    declineReasons: await listReasons(ctx, { counts: true }),
    autoAcceptWorkingDays: setting ? setting.days : DEFAULT_AUTO_ACCEPT_WORKING_DAYS,
    colors: STATUS_COLOR_OPTIONS,
    version: setting?.version ?? 0,
  };
}

/** Marks the review settings changed, so a save from an older load is refused. */
async function bumpVersion(ctx: ModuleContext): Promise<void> {
  await ctx.tx
    .insert(routingSetting)
    .values({ tenantId: ctx.tenantId, autoAcceptWorkingDays: DEFAULT_AUTO_ACCEPT_WORKING_DAYS, version: 1 })
    .onConflictDoUpdate({ target: routingSetting.tenantId, set: { version: sql`${routingSetting.version} + 1`, updatedAt: new Date() } });
}

/** Moves every account in an archived status to the first status, one status change each, in account id order. */
async function moveOutOf(ctx: ModuleContext, archived: { key: string; label: string }, by: string): Promise<void> {
  const [initial] = (await statusRows(ctx)).filter((s) => s.isInitial && !s.archivedAt);
  if (!initial) return;
  const rows = await ctx.tx
    .select({ accountId: accountReview.accountId })
    .from(accountReview)
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.statusKey, archived.key), isNull(accountReview.mergedInto)))
    .orderBy(asc(accountReview.accountId));
  for (const { accountId } of rows) {
    const row = await lockRow(ctx, accountId);
    if (!row || row.statusKey !== archived.key) continue;
    if (await applyStatusChange(ctx, row, { to: initial.key, note: `${archived.label} was archived.` }, by)) await publishReviewSnapshot(ctx, accountId);
  }
}

/**
 * Saves the whole status list in the order given (Decision 2): renames, colors, "What it means", "Set by"
 * and "Flag after"; a status without a key is added; archiving one moves its accounts to the first
 * status. The statuses Scout needs can't be archived and their meaning never changes. Audited.
 */
export async function saveStatuses(ctx: ModuleContext, edits: StatusEdit[]): Promise<StatusView[]> {
  const by = requirePerson(ctx);
  const rows = await ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, ctx.tenantId)).orderBy(asc(reviewStatusDef.order)).for('update');
  const problems = statusEditProblems(rows, edits);
  if (problems.length > 0) throw invalid(problems);
  const before = await listStatuses(ctx);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const taken = new Set(rows.map((r) => r.key));
  const nowArchived: { key: string; label: string }[] = [];
  const now = new Date();
  for (const [i, e] of edits.entries()) {
    const values = {
      label: e.label.trim(),
      color: e.color,
      description: e.description?.trim() ?? '',
      setBy: e.setBy,
      flagAfterHours: e.flagAfterHours,
      order: i + 1,
    };
    const row = e.key ? byKey.get(e.key) : undefined;
    if (!row) {
      const key = keyFor(values.label, taken);
      taken.add(key);
      await ctx.tx.insert(reviewStatusDef).values({ id: newId('rsd'), tenantId: ctx.tenantId, key, ...values });
      continue;
    }
    const archivedAt = e.archived ? (row.archivedAt ?? now) : null;
    if (archivedAt && !row.archivedAt) nowArchived.push({ key: row.key, label: values.label });
    await ctx.tx
      .update(reviewStatusDef)
      .set({ ...values, archivedAt })
      .where(and(eq(reviewStatusDef.tenantId, ctx.tenantId), eq(reviewStatusDef.key, row.key)));
  }
  for (const s of nowArchived) await moveOutOf(ctx, s, by);
  await bumpVersion(ctx);
  const after = await listStatuses(ctx, { counts: true });
  await audit(ctx, { action: 'routing.statuses.updated', subject: { type: 'routing_setting', id: ctx.tenantId }, before: { statuses: before }, after: { statuses: after.map(({ inStatusCount: _n, lateCount: _l, ...s }) => s) } });
  return after;
}

/** Saves every reason (send back, review decline, seller decline) in the order given. A reason without a key is added. Audited. */
export async function saveReasons(ctx: ModuleContext, edits: ReasonEdit[]): Promise<ReasonView[]> {
  requirePerson(ctx);
  const rows = await ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId)).for('update');
  const problems = reasonEditProblems(
    rows.map((r) => ({ ...r, appliesTo: r.appliesTo as ReasonList })),
    edits,
  );
  if (problems.length > 0) throw invalid(problems);
  const before = await listReasons(ctx);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const taken = new Set(rows.map((r) => r.key));
  const now = new Date();
  for (const [i, e] of edits.entries()) {
    const values = { label: e.label.trim(), appliesTo: e.appliesTo, noteRequired: e.noteRequired, order: i + 1 };
    const row = e.key ? byKey.get(e.key) : undefined;
    if (!row) {
      const key = keyFor(values.label, taken);
      taken.add(key);
      await ctx.tx.insert(declineReasonDef).values({ id: newId('drd'), tenantId: ctx.tenantId, key, ...values });
      continue;
    }
    await ctx.tx
      .update(declineReasonDef)
      .set({ ...values, archivedAt: e.archived ? (row.archivedAt ?? now) : null })
      .where(and(eq(declineReasonDef.tenantId, ctx.tenantId), eq(declineReasonDef.key, row.key)));
  }
  await bumpVersion(ctx);
  const after = await listReasons(ctx, { counts: true });
  await audit(ctx, { action: 'routing.reasons.updated', subject: { type: 'routing_setting', id: ctx.tenantId }, before: { reasons: before }, after: { reasons: after.map(({ usedThisQuarter: _n, ...r }) => r) } });
  return after;
}

/**
 * `Restore defaults`: the seeded statuses and reasons get their default words, order and colors back
 * and are live again; anything the tenant added is archived (its accounts move to the first status);
 * auto-accept goes back to 2 working days.
 */
export async function resetReviewSettings(ctx: ModuleContext): Promise<ReviewSettings> {
  requirePerson(ctx);
  await seedRoutingDefaults(ctx);
  const defaultStatusKeys = new Set<string>(DEFAULT_STATUSES.map((s) => s.key));
  const extraStatuses = (await statusRows(ctx)).filter((s) => !defaultStatusKeys.has(s.key));
  await saveStatuses(ctx, [
    ...DEFAULT_STATUSES.map((s) => ({ key: s.key, label: s.label, color: s.color, description: s.description, setBy: s.setBy, flagAfterHours: s.flagAfterHours })),
    ...extraStatuses.map((s) => ({ key: s.key, label: s.label, color: s.color, description: s.description, setBy: s.setBy, flagAfterHours: isFinal(s) ? null : s.flagAfterHours, archived: true })),
  ]);
  const defaultReasonKeys = new Set<string>(DEFAULT_REASONS.map((r) => r.key));
  const extraReasons = (await reasonRows(ctx)).filter((r) => !defaultReasonKeys.has(r.key));
  await saveReasons(ctx, [
    ...DEFAULT_REASONS.map((r) => ({ key: r.key, label: r.label, appliesTo: r.appliesTo, noteRequired: r.noteRequired })),
    ...extraReasons.map((r) => ({ key: r.key, label: r.label, appliesTo: r.appliesTo, noteRequired: r.noteRequired, archived: true })),
  ]);
  await setAutoAcceptWorkingDays(ctx, DEFAULT_AUTO_ACCEPT_WORKING_DAYS);
  return getReviewSettings(ctx);
}

const autoAcceptProblem = (days: number | null): Problem | null =>
  days !== null && (!Number.isInteger(days) || days < 1 || days > 10) ? { path: 'auto_accept_working_days', message: 'Pick 1 to 10 working days, or turn it off.' } : null;

/** `version` is the one the editor loaded (`ReviewSettings.version`). */
export type ReviewSettingsEdit = { version: number; statuses?: StatusEdit[]; reasons?: ReasonEdit[]; autoAcceptWorkingDays?: number | null };

/**
 * The editor's one save (Ruling 19): statuses, reasons and auto-accept together, in that order, in the
 * caller's transaction. Every part is checked before anything is written, so one bad part saves
 * nothing and the problems of all parts come back together at their paths. Audited per part.
 */
export async function saveReviewSettings(ctx: ModuleContext, edit: ReviewSettingsEdit): Promise<ReviewSettings> {
  requirePerson(ctx);
  if (edit.statuses === undefined && edit.reasons === undefined && edit.autoAcceptWorkingDays === undefined) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Nothing to save.' });
  }
  // Locked first, so two saves from the same load can't both pass the check.
  const [setting] = await ctx.tx.select({ version: routingSetting.version }).from(routingSetting).where(eq(routingSetting.tenantId, ctx.tenantId)).for('update');
  if ((setting?.version ?? 0) !== edit.version) {
    throw new ScoutError({ slug: 'conflict', status: 409, title: 'Someone else changed these. Reload to see their changes.' });
  }
  const problems: Problem[] = [];
  if (edit.statuses) {
    const rows = await ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, ctx.tenantId)).for('update');
    problems.push(...statusEditProblems(rows, edit.statuses));
  }
  if (edit.reasons) {
    const rows = await ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId)).for('update');
    problems.push(...reasonEditProblems(rows.map((r) => ({ ...r, appliesTo: r.appliesTo as ReasonList })), edit.reasons));
  }
  const days = edit.autoAcceptWorkingDays === undefined ? null : autoAcceptProblem(edit.autoAcceptWorkingDays);
  if (days) problems.push(days);
  if (problems.length > 0) throw invalid(problems);
  if (edit.statuses) await saveStatuses(ctx, edit.statuses);
  if (edit.reasons) await saveReasons(ctx, edit.reasons);
  if (edit.autoAcceptWorkingDays !== undefined) await setAutoAcceptWorkingDays(ctx, edit.autoAcceptWorkingDays);
  return getReviewSettings(ctx);
}

/** Sets how many working days a pending assignment waits before it is accepted for the seller; null turns it off. Audited. */
export async function setAutoAcceptWorkingDays(ctx: ModuleContext, days: number | null): Promise<ReviewSettings> {
  requirePerson(ctx);
  const problem = autoAcceptProblem(days);
  if (problem) throw invalid([problem]);
  // Locked, so two changes can't both audit the same "before".
  const [current] = await ctx.tx.select({ days: routingSetting.autoAcceptWorkingDays }).from(routingSetting).where(eq(routingSetting.tenantId, ctx.tenantId)).for('update');
  const before = current ? current.days : DEFAULT_AUTO_ACCEPT_WORKING_DAYS;
  await ctx.tx
    .insert(routingSetting)
    .values({ tenantId: ctx.tenantId, autoAcceptWorkingDays: days })
    .onConflictDoUpdate({ target: routingSetting.tenantId, set: { autoAcceptWorkingDays: days, updatedAt: new Date() } });
  await bumpVersion(ctx);
  if (before !== days) {
    await audit(ctx, {
      action: 'routing.settings.updated',
      subject: { type: 'routing_setting', id: ctx.tenantId },
      before: { autoAcceptWorkingDays: before },
      after: { autoAcceptWorkingDays: days },
    });
  }
  return getReviewSettings(ctx);
}

/** Labels of the given reason keys, for showing a reason someone picked. */
export async function reasonLabels(ctx: ModuleContext, keys: string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ key: declineReasonDef.key, label: declineReasonDef.label })
    .from(declineReasonDef)
    .where(and(eq(declineReasonDef.tenantId, ctx.tenantId), inArray(declineReasonDef.key, keys)));
  return new Map(rows.map((r) => [r.key, r.label]));
}
