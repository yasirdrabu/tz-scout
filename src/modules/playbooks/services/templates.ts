import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { listBuyingRoles } from '@/modules/accounts';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import type { OwnerRole, StepChannel, StopWhen } from '../domain/plan';
import { accountPlan, offerPlaybook, outcome, playbookTemplate, templateStep } from '../db/schema';

export const TEMPLATE_STATUSES = ['draft', 'active', 'archived'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const STEP_CHANNELS = ['email', 'linkedin', 'call', 'meeting', 'task'] as const;
export const OWNER_ROLES = ['seller', 'leader', 'operator'] as const;
export const STOP_RULES = ['reply_or_meeting', 'meeting', 'never'] as const;

export const NEEDS_NAME = 'Give the playbook a name.';
export const NEEDS_STEP = 'Add at least one step.';
export const HAS_RUN = 'This playbook has run on accounts. Retire it instead.';

/** A step as a person sends it. `order` is optional: the array order wins when it is absent. */
export type StepInput = {
  order?: number;
  day: number;
  channel: StepChannel;
  ownerRole: OwnerRole;
  title: string;
  detail?: string | null;
  targetBuyingRoles?: string[];
  crmTask?: boolean;
  /** Email steps only; dropped for other channels. */
  subject?: string | null;
  body?: string | null;
};
export type TemplateInput = {
  name: string;
  description?: string | null;
  whenToUse?: string | null;
  status?: TemplateStatus;
  stopWhen?: StopWhen;
  steps?: StepInput[];
};
export type TemplatePatch = Partial<TemplateInput>;

export type StepView = Omit<typeof templateStep.$inferSelect, 'tenantId' | 'channel' | 'ownerRole'> & { channel: StepChannel; ownerRole: OwnerRole };
export type Template = typeof playbookTemplate.$inferSelect;
export type PlaybookResults = { finished: number; replied: number; meetings: number; won: number };
/** Rates look at plans that finished this far back. */
export const RESULTS_DAYS = 90;
export type RunsOn = { offerId: string; tier: string };
/** `steps` is the count here; `getTemplate` returns the step rows as `steps` and the count as `stepCount`. */
export type TemplateSummary = Template & {
  steps: number;
  /** The largest `day` in the current version (0 with no steps), so a day 0-to-21 playbook has `days` 21. */
  days: number;
  channels: Partial<Record<StepChannel, number>>;
  runsOn: RunsOn[];
  /** Plans on this template that are `active` right now. */
  running: number;
  /** Plans on this template that finished in the last 90 days, and how many of them had a reply, a meeting or a win (R3c-2 Ruling 6). */
  results: PlaybookResults;
};
export type TemplateDetail = Omit<TemplateSummary, 'steps'> & { steps: StepView[]; stepCount: number; stepsVersion: number };

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That playbook was not found.' });
const invalid = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });

async function load(ctx: ModuleContext, id: string, lock = false): Promise<Template> {
  const q = ctx.tx.select().from(playbookTemplate).where(and(eq(playbookTemplate.id, id), eq(playbookTemplate.tenantId, ctx.tenantId)));
  const [row] = await (lock ? q.for('update') : q);
  if (!row) throw notFound();
  return row;
}

async function stepsOf(ctx: ModuleContext, templateId: string, version: number): Promise<StepView[]> {
  const rows = await ctx.tx
    .select()
    .from(templateStep)
    .where(and(eq(templateStep.tenantId, ctx.tenantId), eq(templateStep.templateId, templateId), eq(templateStep.templateVersion, version)))
    .orderBy(asc(templateStep.order), asc(templateStep.id));
  return rows.map(({ tenantId: _t, ...r }) => r as StepView);
}

type Normal = Omit<StepView, 'id' | 'templateId' | 'templateVersion'>;

/** Validated steps in order, numbered from 1. */
function normalise(steps: StepInput[]): Normal[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? a.i) - (b.s.order ?? b.i) || a.i - b.i)
    .map(({ s }, i) => {
      const title = s.title.trim();
      if (!title) throw invalid(`steps.${i}.title`, 'Give every step a title.');
      const email = s.channel === 'email';
      return {
        order: i + 1,
        day: s.day,
        channel: s.channel,
        ownerRole: s.ownerRole,
        title,
        detail: s.detail?.trim() || null,
        targetBuyingRoles: [...new Set(s.targetBuyingRoles ?? [])],
        crmTask: s.crmTask ?? true,
        subject: email ? s.subject?.trim() || null : null,
        body: email ? s.body?.trim() || null : null,
      };
    });
}

const sameSteps = (a: StepView[], b: Normal[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return (
      x.order === y.order &&
      x.day === y.day &&
      x.channel === y.channel &&
      x.ownerRole === y.ownerRole &&
      x.title === y.title &&
      x.detail === y.detail &&
      x.crmTask === y.crmTask &&
      x.subject === y.subject &&
      x.body === y.body &&
      x.targetBuyingRoles.join(',') === y.targetBuyingRoles.join(',')
    );
  });

/**
 * Every target buying role must be one of the workspace's active roles: 400 "Unknown buying role: {key}" at the step.
 * A key the template's current version already uses stays valid after its role is archived (`kept`).
 */
async function checkRoles(ctx: ModuleContext, steps: Normal[], kept: StepView[] = []): Promise<void> {
  if (!steps.some((s) => s.targetBuyingRoles.length > 0)) return;
  const known = new Set((await listBuyingRoles(ctx)).map((r) => r.key));
  for (const s of kept) for (const k of s.targetBuyingRoles) known.add(k);
  for (const [i, s] of steps.entries()) {
    const bad = s.targetBuyingRoles.find((k) => !known.has(k));
    if (bad !== undefined) throw invalid('steps.' + i + '.target_buying_roles', 'Unknown buying role: ' + bad);
  }
}

async function insertSteps(ctx: ModuleContext, templateId: string, version: number, steps: Normal[]): Promise<void> {
  if (steps.length === 0) return;
  await ctx.tx.insert(templateStep).values(steps.map((s) => ({ ...s, id: newId('pls'), tenantId: ctx.tenantId, templateId, templateVersion: version })));
}

const subjectOf = (id: string) => ({ type: 'playbook_template', id });

export async function createTemplate(ctx: ModuleContext, input: TemplateInput): Promise<TemplateDetail> {
  const name = input.name.trim();
  if (!name) throw invalid('name', NEEDS_NAME);
  const steps = normalise(input.steps ?? []);
  await checkRoles(ctx, steps);
  const status = input.status ?? 'draft';
  if (status === 'active' && steps.length === 0) throw invalid('status', NEEDS_STEP);
  const [row] = await ctx.tx
    .insert(playbookTemplate)
    .values({
      id: newId('plb'),
      tenantId: ctx.tenantId,
      name,
      description: input.description?.trim() || null,
      whenToUse: input.whenToUse?.trim() || null,
      status,
      stopWhen: input.stopWhen ?? 'reply_or_meeting',
      createdBy: ctx.actor.id,
      updatedBy: ctx.actor.id,
    })
    .returning();
  await insertSteps(ctx, row!.id, 1, steps);
  await audit(ctx, { action: 'playbooks.template.created', subject: subjectOf(row!.id), after: { name, status, steps: steps.length } });
  return getTemplate(ctx, row!.id);
}

/**
 * Edits a template. Name, description, when_to_use and stop_when never bump the version. A changed step set on a
 * `draft` replaces its steps in place; on an `active` or `archived` template it bumps `version` and writes the
 * new set under it, keeping the old rows (Ruling 6).
 */
export async function updateTemplate(ctx: ModuleContext, id: string, patch: TemplatePatch): Promise<TemplateDetail> {
  const before = await load(ctx, id, true);
  const set: Partial<typeof playbookTemplate.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid('name', NEEDS_NAME);
    set.name = name;
  }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.whenToUse !== undefined) set.whenToUse = patch.whenToUse?.trim() || null;
  if (patch.stopWhen !== undefined) set.stopWhen = patch.stopWhen;
  if (patch.status !== undefined) set.status = patch.status;

  const current = await stepsOf(ctx, id, before.version);
  const next = patch.steps === undefined ? null : normalise(patch.steps);
  if (next) await checkRoles(ctx, next, current);
  const changedSteps = next !== null && !sameSteps(current, next);
  if ((patch.status ?? before.status) === 'active' && (changedSteps ? next! : current).length === 0) throw invalid('status', NEEDS_STEP);

  let version = before.version;
  if (changedSteps) {
    if (before.status === 'draft') {
      await ctx.tx.delete(templateStep).where(and(eq(templateStep.templateId, id), eq(templateStep.templateVersion, version)));
    } else {
      version += 1;
      set.version = version;
    }
    await insertSteps(ctx, id, version, next!);
  }
  const changed = Object.keys(set);
  if (set.status === 'archived' && before.status !== 'archived') await clearOfferMaps(ctx, id);
  if (changed.length > 0 || changedSteps) {
    await ctx.tx
      .update(playbookTemplate)
      .set({ ...set, updatedBy: ctx.actor.id, updatedAt: new Date() })
      .where(eq(playbookTemplate.id, id));
    await audit(ctx, {
      action: 'playbooks.template.updated',
      subject: subjectOf(id),
      before: { status: before.status, version: before.version },
      after: { changed: [...changed, ...(changedSteps ? ['steps'] : [])], status: set.status ?? before.status, version },
    });
  }
  return getTemplate(ctx, id);
}

async function summaries(ctx: ModuleContext, rows: Template[]): Promise<TemplateSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const steps = await ctx.tx.select().from(templateStep).where(and(eq(templateStep.tenantId, ctx.tenantId), inArray(templateStep.templateId, ids)));
  const maps = await ctx.tx.select().from(offerPlaybook).where(and(eq(offerPlaybook.tenantId, ctx.tenantId), inArray(offerPlaybook.templateId, ids)));
  const running = await ctx.tx
    .select({ templateId: accountPlan.templateId, n: sql<number>`count(*)::int` })
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.status, 'active'), inArray(accountPlan.templateId, ids)))
    .groupBy(accountPlan.templateId);
  // Tenant-wide like `running`: counts only, no account named.
  const since = new Date(Date.now() - RESULTS_DAYS * 86_400_000);
  const had = (kind: string) =>
    sql<number>`(count(*) filter (where exists (select 1 from ${outcome} o where o.tenant_id = playbooks.account_plan.tenant_id and o.plan_id = playbooks.account_plan.id and o.kind = ${kind})))::int`;
  const results = await ctx.tx
    .select({ templateId: accountPlan.templateId, finished: sql<number>`count(*)::int`, replied: had('reply'), meetings: had('meeting'), won: had('won') })
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), inArray(accountPlan.templateId, ids), gte(accountPlan.finishedAt, since)))
    .groupBy(accountPlan.templateId);
  return rows.map((t) => {
    const mine = steps.filter((s) => s.templateId === t.id && s.templateVersion === t.version);
    const channels: Partial<Record<StepChannel, number>> = {};
    for (const s of mine) channels[s.channel as StepChannel] = (channels[s.channel as StepChannel] ?? 0) + 1;
    return {
      ...t,
      steps: mine.length,
      days: mine.reduce((m, s) => Math.max(m, s.day), 0),
      channels,
      runsOn: maps
        .filter((m) => m.templateId === t.id)
        .map((m) => ({ offerId: m.offerId, tier: m.tier }))
        .sort((a, b) => a.offerId.localeCompare(b.offerId) || a.tier.localeCompare(b.tier)),
      running: running.find((r) => r.templateId === t.id)?.n ?? 0,
      results: ((r) => ({ finished: r?.finished ?? 0, replied: r?.replied ?? 0, meetings: r?.meetings ?? 0, won: r?.won ?? 0 }))(results.find((x) => x.templateId === t.id)),
    };
  });
}

export async function listTemplates(ctx: ModuleContext, filter: { status?: TemplateStatus } = {}): Promise<TemplateSummary[]> {
  const rows = await ctx.tx
    .select()
    .from(playbookTemplate)
    .where(and(eq(playbookTemplate.tenantId, ctx.tenantId), filter.status ? eq(playbookTemplate.status, filter.status) : undefined))
    .orderBy(asc(playbookTemplate.name), asc(playbookTemplate.id));
  return summaries(ctx, rows);
}

/** One template with the steps of `version` (the current one by default). An unknown version is a 404. */
export async function getTemplate(ctx: ModuleContext, id: string, version?: number): Promise<TemplateDetail> {
  const row = await load(ctx, id);
  if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > row.version)) throw notFound();
  const [summary] = await summaries(ctx, [row]);
  const steps = await stepsOf(ctx, id, version ?? row.version);
  const { steps: count, ...rest } = summary!;
  return { ...rest, steps, stepCount: count, stepsVersion: version ?? row.version };
}

/** A copy as a draft named "{name} (copy)", with the current version's steps. */
export async function duplicateTemplate(ctx: ModuleContext, id: string): Promise<TemplateDetail> {
  const from = await load(ctx, id);
  const steps = await stepsOf(ctx, id, from.version);
  const copy = await createTemplate(ctx, {
    name: `${from.name} (copy)`,
    description: from.description,
    whenToUse: from.whenToUse,
    stopWhen: from.stopWhen as StopWhen,
    status: 'draft',
    steps,
  });
  await audit(ctx, { action: 'playbooks.template.duplicated', subject: subjectOf(copy.id), after: { from: id } });
  return copy;
}

/** An archived template cannot fill a tier; running plans keep their copy. */
async function clearOfferMaps(ctx: ModuleContext, id: string): Promise<void> {
  await ctx.tx.delete(offerPlaybook).where(and(eq(offerPlaybook.tenantId, ctx.tenantId), eq(offerPlaybook.templateId, id)));
}

/** The template stops being chosen; running plans are untouched. */
export async function archiveTemplate(ctx: ModuleContext, id: string): Promise<TemplateDetail> {
  const before = await load(ctx, id, true);
  if (before.status !== 'archived') {
    await ctx.tx
      .update(playbookTemplate)
      .set({ status: 'archived', updatedBy: ctx.actor.id, updatedAt: new Date() })
      .where(eq(playbookTemplate.id, id));
    await clearOfferMaps(ctx, id);
    await audit(ctx, { action: 'playbooks.template.archived', subject: subjectOf(id), before: { status: before.status }, after: { status: 'archived' } });
  }
  return getTemplate(ctx, id);
}

/** Deletes a template nothing has used: no plan ever, no offer mapping. Otherwise 409 (Ruling 6). */
export async function deleteTemplate(ctx: ModuleContext, id: string): Promise<void> {
  const before = await load(ctx, id, true);
  const [plan] = await ctx.tx.select({ id: accountPlan.id }).from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.templateId, id))).limit(1);
  const [map] = await ctx.tx
    .select({ offerId: offerPlaybook.offerId })
    .from(offerPlaybook)
    .where(and(eq(offerPlaybook.tenantId, ctx.tenantId), eq(offerPlaybook.templateId, id)))
    .limit(1);
  if (plan || map) throw new ScoutError({ slug: 'playbook-has-run', status: 409, title: HAS_RUN });
  await ctx.tx.delete(templateStep).where(and(eq(templateStep.tenantId, ctx.tenantId), eq(templateStep.templateId, id)));
  await ctx.tx.delete(playbookTemplate).where(eq(playbookTemplate.id, id));
  await audit(ctx, { action: 'playbooks.template.deleted', subject: subjectOf(id), before: { name: before.name, status: before.status } });
}
