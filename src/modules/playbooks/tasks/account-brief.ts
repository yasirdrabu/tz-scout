import { defineTask } from '@/modules/ai-tasks';
import { briefInputSchema, briefOutputSchema, type BriefInput } from '../domain/brief-io';
import { rulesBrief } from '../domain/rules-brief';
import * as P from './prompts/account_brief.v1.0';

/**
 * Scout's recommendation, the brief sections, the opener and who to approach first (Ruling 1).
 * The worst case at the input caps is about 6.4 cents on Sonnet 5.5, so 10 is the per-run cap;
 * a tenant can lower it with `ai_setting.max_cost_cents_per_run`.
 */
export const accountBriefTask = defineTask({
  name: 'account_brief',
  promptVersion: P.VERSION,
  model: 'claude-sonnet-5-5',
  system: P.SYSTEM,
  buildUser: P.user,
  input: briefInputSchema,
  output: briefOutputSchema,
  rules: (i: BriefInput) => rulesBrief(i, new Date()),
  // The sample is the rules brief; its label says `Sample output`.
  mock: (i: BriefInput) => rulesBrief(i, new Date()),
  maxTokens: 3000,
  maxCostCents: 10,
});
