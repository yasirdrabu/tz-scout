import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FunnelStages } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { pipelineStage } from '../db/schema';
import { DEFAULT_STAGES, TRIGGERS, type PipelineStage } from '../domain/pipeline';

type StageRow = typeof pipelineStage.$inferSelect;

const triggers: readonly string[] = TRIGGERS.map((t) => t.key);
const toStage = (r: StageRow): PipelineStage => {
  if (!triggers.includes(r.trigger)) throw new Error(`Unknown stage trigger ${r.trigger}`);
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    kind: r.kind as PipelineStage['kind'],
    position: r.position,
    trigger: r.trigger as PipelineStage['trigger'],
    hubspotStage: r.hubspotStage,
    quarterTarget: r.quarterTarget,
    locked: r.locked as PipelineStage['locked'],
  };
};

/**
 * The workspace's live stages, flow then exits, each in order. A workspace without any (its defaults not
 * delivered yet) has the defaults, so nothing is ever without a pipeline.
 */
export async function loadStages(ctx: ModuleContext): Promise<PipelineStage[]> {
  const rows = await ctx.tx
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.tenantId, ctx.tenantId), isNull(pipelineStage.archivedAt)))
    .orderBy(sql`${pipelineStage.kind} = 'exit'`, asc(pipelineStage.position));
  return rows.length > 0 ? rows.map(toStage) : DEFAULT_STAGES;
}

/** Every stage's name by key, archived stages included: history of a deleted stage still needs a name. */
export async function loadStageNames(ctx: ModuleContext): Promise<Map<string, string>> {
  const rows = await ctx.tx.select({ key: pipelineStage.key, name: pipelineStage.name }).from(pipelineStage).where(eq(pipelineStage.tenantId, ctx.tenantId));
  return new Map((rows.length > 0 ? rows : DEFAULT_STAGES).map((s) => [s.key, s.name]));
}

/** Intake's `FunnelStages`: the source funnel counts "Assigned" as at or past the stage an acceptance moves to. */
export const routingFunnelStages: FunnelStages = {
  stages: async (ctx) => {
    const stages = await loadStages(ctx);
    const accepts = stages.find((s) => s.trigger === 'ae_accepts');
    return stages.map((s) => ({ key: s.key, assigned: !!accepts && s.kind === 'flow' && s.position >= accepts.position }));
  },
};

export type StagesView = {
  stages: (PipelineStage & { triggerLabel: string })[];
  triggers: { key: string; label: string; limit: string }[];
};

/** The live stages, flow then exits, with each trigger's label, and the list of triggers to pick from (REV-E5 "Editing"). */
export async function listStages(ctx: ModuleContext): Promise<StagesView> {
  const label = new Map<string, string>(TRIGGERS.map((t) => [t.key, t.label]));
  return {
    stages: (await loadStages(ctx)).map((s) => ({ ...s, triggerLabel: label.get(s.trigger)! })),
    triggers: TRIGGERS.map((t) => ({ ...t })),
  };
}
