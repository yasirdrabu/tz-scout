// The `conflict_explanation` task's input and output.
import { z } from 'zod';

export const EXPLANATION_MAX = 200;

export const conflictExplanationInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  facts: z.array(
    z.object({
      id: z.string(),
      value: z.unknown(),
      observedAt: z.string(),
      sourceName: z.string().nullable(),
      url: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export type ConflictExplanationInput = z.infer<typeof conflictExplanationInputSchema>;

export const conflictExplanationOutputSchema = z.object({
  explanation: z.string().max(EXPLANATION_MAX),
  fact_ids: z.array(z.string()),
});
export type ConflictExplanationOutput = z.infer<typeof conflictExplanationOutputSchema>;
