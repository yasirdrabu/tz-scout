import { z } from 'zod';
import { defineTask, runTask } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { log } from '@/platform/log';
import { errorText } from '@/platform/scrub-error';

const input = z.object({ industry: z.string().nullish(), relationship: z.string().nullish() });
const output = z.object({ industryKey: z.string().nullable(), relationshipKey: z.string().nullable() });
export type NormaliseInput = z.infer<typeof input>;
export type NormaliseResult = z.infer<typeof output>;

const NONE: NormaliseResult = { industryKey: null, relationshipKey: null };

export const arrivalNormaliseTask = defineTask({
  name: 'arrival_normalise',
  promptVersion: 'v1.0',
  model: 'claude-haiku-5-5',
  system:
    'You tidy up two free-text fields on a sales lead. Given an industry and a relationship to the person who introduced the lead, ' +
    'reply with JSON {"industryKey": string|null, "relationshipKey": string|null}. Use a short lowercase snake_case key. ' +
    'For the relationship prefer one of customer_referral, partner_referral, board_or_investor, employee_network, event_meeting. ' +
    'Use null when a field is empty or you cannot tell.',
  buildUser: (i: NormaliseInput) => `Industry: ${i.industry ?? ''}\nRelationship: ${i.relationship ?? ''}`,
  input,
  output,
  rules: () => NONE,
  mock: () => NONE,
  maxTokens: 200,
});

/** Never throws: any AI failure gives the null result and the caller falls back to `other`. */
export async function normaliseWithAi(ctx: ModuleContext, i: NormaliseInput): Promise<NormaliseResult> {
  try {
    const { output } = await runTask(ctx, arrivalNormaliseTask, i, { subject: { type: 'arrival', id: 'normalise' } });
    return output;
  } catch (e) {
    log.warn({ err: errorText(e) }, 'arrival_normalise: failed, using no keys');
    return NONE;
  }
}
