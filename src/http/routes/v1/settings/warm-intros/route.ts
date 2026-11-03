import { z } from 'zod';
import { getWarmIntroSettings, saveWarmIntroSettings } from '@/modules/intake';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

const rule = z.strictObject({
  id: z.string().nullish(),
  introducer_user_id: z.string().nullish(),
  introducer_email: z.string().nullish(),
  introducer_name: z.string().nullish(),
  relationship_key: z.string(),
  points: z.number(),
});
const body = z.strictObject({
  relationships: z.array(z.strictObject({ key: z.string(), points: z.number() })).max(50),
  rules: z.array(rule).max(500),
});
// `parseBody` camelCases only the top-level keys, so the rules arrive in snake_case.
type Body = { relationships: { key: string; points: number }[]; rules: z.infer<typeof rule>[] };

/** SRC-E5-S2: the Warm intros tab: relationship points, introducer rules, and the people a rule can name. People only (it lists member emails). */
export const GET = v1Route({ permission: 'scoring:manage', peopleOnly: true },async (_req, _principal, ctx) => getWarmIntroSettings(ctx));

/**
 * Saves the whole tab: rules in the body replace the stored ones, and the intros already recorded are repriced.
 * A bad body is a 400 with `errors[]` at the field (`rules[2].points`) and saves nothing.
 */
export const PUT = v1Route({ permission: 'scoring:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const b = await parseBody<Body>(req, body);
  const { settings, rescoringAccountCount } = await saveWarmIntroSettings(ctx, {
    relationships: b.relationships,
    rules: b.rules.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      introducerUserId: r.introducer_user_id ?? null,
      introducerEmail: r.introducer_email ?? null,
      introducerName: r.introducer_name ?? null,
      relationshipKey: r.relationship_key,
      points: r.points,
    })),
  });
  return { ...settings, rescoringAccountCount };
});
