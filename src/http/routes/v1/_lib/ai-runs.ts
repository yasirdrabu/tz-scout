import { redactPersonalText } from '@/lib/redact-text';
import { RUN_STATUSES, runStatus, type AiRunRow, type RunStatus } from '@/modules/ai-tasks';
import { ScoutError } from '@/platform/errors';

/** `?status=`: succeeded, failed or stopped_by_limit; anything else is a 400. */
export function runStatusParam(raw: string | null): RunStatus | undefined {
  if (!raw) return undefined;
  if ((RUN_STATUSES as readonly string[]).includes(raw)) return raw as RunStatus;
  throw new ScoutError({
    slug: 'validation',
    status: 400,
    title: 'Check the request.',
    errors: [{ path: 'status', message: `Status must be one of ${RUN_STATUSES.join(', ')}.` }],
  });
}

const subjectOf = (r: AiRunRow) => (r.inputRef as { subject?: { type: string; id: string } } | null)?.subject ?? null;

/** A run as the lists show it: `status` is the screen status, `outcome` the stored one. */
export function runRow(r: AiRunRow) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    task: r.task,
    promptVersion: r.promptVersion,
    mode: r.mode,
    model: r.model,
    status: runStatus(r.status),
    outcome: r.status,
    subject: subjectOf(r),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    costCents: r.costCents,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  };
}

/**
 * One run with what came back. Scout keeps no input, only the subject and a fingerprint
 * (`input_hash`). Email addresses and phone numbers in the error are masked.
 */
export function runDetail(r: AiRunRow) {
  return {
    ...runRow(r),
    inputHash: r.inputHash,
    output: r.output ?? null,
    error: r.error === null ? null : redactPersonalText(r.error),
  };
}
