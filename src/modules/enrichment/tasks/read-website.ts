import { defineTask, runTask, type RunOpts, type RunResult } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { WEBSITE_READ_WORST_CENTS } from '../domain/prices';
import {
  citedOnly,
  readWebsiteInputSchema,
  readWebsiteOutputSchema,
  rulesRead,
  type ReadWebsiteInput,
  type ReadWebsiteOutput,
} from '../domain/read-website';
import * as P from './prompts/read_website.v1.1';

/**
 * What a company's website says about it (Ruling 3). Five pages at the 6,000-character cap are about 9,000 input
 * tokens, so the worst case on Sonnet 5.5 is about 4.6 cents: the estimate's 5 cents is the per-run cap. With Claude on
 * mock or at its limit, the rules output is used (`mode: 'rules'`, labelled "Read by rules" by the caller).
 */
export const readWebsiteTask = defineTask({
  name: 'read_website',
  promptVersion: P.VERSION,
  model: 'claude-sonnet-5-5',
  system: P.SYSTEM,
  buildUser: P.user,
  input: readWebsiteInputSchema,
  output: readWebsiteOutputSchema,
  rules: (i: ReadWebsiteInput) => rulesRead(i),
  // The sample is the rules reading.
  mock: (i: ReadWebsiteInput) => rulesRead(i),
  maxTokens: 1200,
  maxCostCents: WEBSITE_READ_WORST_CENTS,
});

/** Runs `read_website` and keeps only the items that cite one of the pages it was given. */
export async function readWebsite(ctx: ModuleContext, input: ReadWebsiteInput, opts: RunOpts): Promise<RunResult<ReadWebsiteOutput>> {
  const r = await runTask(ctx, readWebsiteTask, input, opts);
  return { ...r, output: citedOnly(input, r.output) };
}
