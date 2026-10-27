import { defineTask, runTask } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { log } from '@/platform/log';
import { errorText } from '@/platform/scrub-error';
import {
  cleanMapping,
  mappingInput,
  mappingOutput,
  synonymMapping,
  type MappingColumn,
  type MappingInput,
} from '../import/synonyms';

export const csvColumnMappingTask = defineTask({
  name: 'csv_column_mapping',
  promptVersion: 'v1.0',
  model: 'claude-haiku-5-5',
  system:
    'You map the columns of a lead file to fields. For every header, give a target path, a confidence from 0 to 1 and a short reason. ' +
    'Allowed targets: account.name, account.website, account.domain, account.linkedin_url, account.country, account.region, account.city, ' +
    'account.industry, account.employees, account.notes, account.practice_hint, account.external_ref, account.custom_fields.<key>, ' +
    'people[0].first_name, people[0].last_name, people[0].name, people[0].email, people[0].title, people[0].phone, people[0].linkedin_url, ' +
    'signals[].occurred_at, signals[].title, signals[].url, signals[].type, research.<field>. ' +
    'Use null when no target fits. Reply with JSON {"columns": [{"header", "target", "confidence", "reason"}]}, one entry per header.',
  buildUser: (i: MappingInput) => `Headers: ${JSON.stringify(i.headers)}\nSample rows: ${JSON.stringify(i.sampleRows)}`,
  input: mappingInput,
  output: mappingOutput,
  rules: synonymMapping,
  mock: synonymMapping,
  maxTokens: 2000,
});

export type SuggestedMapping = { mapping: MappingColumn[]; origin: 'ai' | 'synonyms' };

/** One call per file. Falls back to header synonyms when Claude is missing, mocked or fails. */
export async function suggestMapping(
  ctx: ModuleContext,
  headers: string[],
  sampleRows: string[][],
): Promise<SuggestedMapping> {
  const input = { headers, sampleRows: sampleRows.slice(0, 5) };
  try {
    const { output, mode } = await runTask(ctx, csvColumnMappingTask, input, { subject: { type: 'import', id: 'mapping' } });
    if (mode === 'live') return { mapping: cleanMapping(output).columns, origin: 'ai' };
  } catch (e) {
    log.warn({ err: errorText(e) }, 'csv_column_mapping: failed, using header synonyms');
  }
  return { mapping: cleanMapping(synonymMapping(input)).columns, origin: 'synonyms' };
}
