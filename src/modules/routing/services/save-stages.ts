import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { stagesChanged } from '../contracts/events';
import { accountReview, pipelineStage, routingSetting, stageChange } from '../db/schema';
import { DEFAULT_STAGES, planDeletion, validateStages, type PipelineStage, type PipelineStageInput } from '../domain/pipeline';
import { listStages, loadStages, type StagesView } from './pipeline-stages';
import { requirePerson } from './review';
import { publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

const inputOf = (s: PipelineStage): PipelineStageInput => ({
  key: s.key,
  name: s.name,
  description: s.description,
  kind: s.kind,
  trigger: s.trigger,
  hubspotStage: s.hubspotStage,
  quarterTarget: s.quarterTarget,
});

const brief = (s: { key: string; name: string; kind: string; trigger: string; hubspotStage: string | null; quarterTarget: number | null }) => ({
  key: s.key,
  name: s.name,
  kind: s.kind,
  trigger: s.trigger,
  hubspotStage: s.hubspotStage,
  quarterTarget: s.quarterTarget,
});

/**
 * Saves the workspace's whole stage list (REV-E5 "Editing"): validates it (400 with each field's sentence,
 * nothing saved), archives the stages left out and moves their accounts (cause `stage_deleted`), then
 * upserts the rest in order. Existing stages are named by key, new ones have none; a deleted stage listed
 * again comes back. Audits `routing.stages.changed` with before and after and publishes the event.
 */
export async function saveStages(ctx: ModuleContext, input: PipelineStageInput[]): Promise<StagesView> {
  const by = requirePerson(ctx);
  // Locked, so two saves cannot both audit the same "before".
  await ctx.tx.select({ t: routingSetting.tenantId }).from(routingSetting).where(eq(routingSetting.tenantId, ctx.tenantId)).for('update');
  // A workspace whose defaults were never delivered starts from them.
  await ctx.tx.insert(pipelineStage).values(DEFAULT_STAGES.map((s) => ({ id: newId('pst'), tenantId: ctx.tenantId, ...s }))).onConflictDoNothing();
  const prev = await loadStages(ctx);
  const rows = await ctx.tx.select().from(pipelineStage).where(eq(pipelineStage.tenantId, ctx.tenantId));
  const archivedKeys = rows.filter((r) => r.archivedAt).map((r) => r.key);

  const problems = validateStages(input, prev, archivedKeys);
  // The API speaks snake_case: `stages.3.hubspotStage` is `stages.3.hubspot_stage` to the caller.
  const errors = problems.map((p) => ({ ...p, path: p.path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) }));
  if (errors.length > 0) throw new ScoutError({ slug: 'validation', status: 400, title: errors[0]!.message, errors });

  const plan = planDeletion(prev, input);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Names move around within one save (a swap), so a changed name goes through a placeholder first.
  for (const s of input) {
    const row = s.key ? byKey.get(s.key) : undefined;
    if (row && row.name.toLowerCase() !== s.name.trim().toLowerCase()) {
      await ctx.tx.update(pipelineStage).set({ name: `~${row.id}` }).where(eq(pipelineStage.id, row.id));
    }
  }
  const archiveRows = plan.archived.map((k) => byKey.get(k)!);
  if (archiveRows.length > 0) await ctx.tx.update(pipelineStage).set({ archivedAt: new Date() }).where(inArray(pipelineStage.id, archiveRows.map((r) => r.id)));

  const counts = { flow: 0, exit: 0 };
  for (const s of input) {
    const row = s.key ? byKey.get(s.key) : undefined;
    const fields = {
      name: s.name.trim(),
      description: s.description?.trim() || null,
      kind: s.kind,
      position: counts[s.kind]++,
      trigger: s.trigger,
      hubspotStage: s.hubspotStage?.trim() || null,
      quarterTarget: s.quarterTarget ?? null,
      archivedAt: null,
    };
    if (row) await ctx.tx.update(pipelineStage).set(fields).where(eq(pipelineStage.id, row.id));
    else await ctx.tx.insert(pipelineStage).values({ id: newId('pst'), tenantId: ctx.tenantId, key: newId('stg'), ...fields });
  }

  // Accounts on a deleted stage move on, each with a history row.
  const touched: string[] = [];
  for (const key of plan.archived) {
    const stuck = await ctx.tx
      .select({ accountId: accountReview.accountId })
      .from(accountReview)
      .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.stage, key)))
      .orderBy(asc(accountReview.accountId));
    for (const { accountId } of stuck) {
      const history = (
        await ctx.tx
          .select({ from: stageChange.fromStage })
          .from(stageChange)
          .where(and(eq(stageChange.tenantId, ctx.tenantId), eq(stageChange.accountId, accountId), ne(stageChange.fromStage, key)))
          .orderBy(desc(stageChange.at), desc(stageChange.id))
      ).map((h) => h.from);
      const to = plan.moveTo(key, history);
      if (await moveStage(ctx, accountId, [{ kind: 'by_hand', to }], `stage_deleted:${key}`, { by, note: 'Stage deleted' })) touched.push(accountId);
    }
  }
  for (const accountId of touched) await publishReviewSnapshot(ctx, accountId);

  const after = await listStages(ctx);
  await audit(ctx, {
    action: 'routing.stages.changed',
    subject: { type: 'routing_setting', id: ctx.tenantId },
    before: { stages: prev.map(brief) },
    after: { stages: after.stages.map(brief) },
  });
  await publish(ctx, stagesChanged, { by, stages: after.stages.map((s) => ({ key: s.key, name: s.name, kind: s.kind })), archived: plan.archived });
  return after;
}

/** `Restore defaults` (REV-E5): the default list again; deleted defaults come back under their keys, added stages go by the deletion rules. */
export const restoreDefaults = (ctx: ModuleContext): Promise<StagesView> => saveStages(ctx, DEFAULT_STAGES.map(inputOf));
