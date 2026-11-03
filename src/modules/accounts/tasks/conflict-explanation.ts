import { defineTask } from '@/modules/ai-tasks';
import {
  conflictExplanationInputSchema,
  conflictExplanationOutputSchema,
  type ConflictExplanationInput,
} from '../domain/conflict-explanation-io';
import * as P from './prompts/conflict-explanation.v1.0';

/**
 * One sentence on why two sources may differ (Ruling 9). There are no rules: without live Claude nothing is stored,
 * and the mock's empty sample is never shown.
 */
export const conflictExplanationTask = defineTask({
  name: 'conflict_explanation',
  promptVersion: P.VERSION,
  model: 'claude-sonnet-5-5',
  system: P.SYSTEM,
  buildUser: (i: ConflictExplanationInput) => P.user(i),
  input: conflictExplanationInputSchema,
  output: conflictExplanationOutputSchema,
  maxTokens: 300,
  maxCostCents: 2,
});
