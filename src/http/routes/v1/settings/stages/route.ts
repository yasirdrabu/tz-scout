import { z } from 'zod';
import { listStages, saveStages, TRIGGERS, type PipelineStageInput, type Trigger } from '@/modules/routing';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

const stage = z.strictObject({
  key: z.string().optional(),
  name: z.string(),
  description: z.string().nullish(),
  kind: z.enum(['flow', 'exit']),
  trigger: z.enum(TRIGGERS.map((t) => t.key) as [Trigger, ...Trigger[]]),
  hubspot_stage: z.string().nullish(),
  quarter_target: z.number().nullish(),
});
const body = z.strictObject({ stages: z.array(stage).max(50) });
// `parseBody` camelCases only the top-level keys, so the stages arrive in snake_case.
type Body = { stages: z.infer<typeof stage>[] };

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => listStages(ctx));

/**
 * REV-E5: replaces the whole stage list (existing stages by `key`, new ones without). A bad list is a 400
 * with `errors[]` at the field and saves nothing. Deleting a stage moves its accounts. Returns the new list.
 */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const b = await parseBody<Body>(req, body);
  return saveStages(
    ctx,
    b.stages.map((s): PipelineStageInput => ({
      ...(s.key ? { key: s.key } : {}),
      name: s.name,
      description: s.description ?? null,
      kind: s.kind,
      trigger: s.trigger,
      hubspotStage: s.hubspot_stage ?? null,
      quarterTarget: s.quarter_target ?? null,
    })),
  );
});
