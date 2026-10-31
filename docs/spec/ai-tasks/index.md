# AI: AI tasks

Module code AI · Schema `ai` · Releases R0 (runner, log, fallback), tasks by the release of the
module that uses them

## Purpose

The single path for every Claude call (carried from v1): one task per file, versioned prompts,
structured output checked with Zod, and every call logged. When there is no API key, tasks that can
run on rules do, and say so ("Assembled from rules").

Other modules own **what** a task is for and when it runs; AI owns **how** it runs.

## Owns

| Table | Key fields |
|---|---|
| `ai_run` | `id` (`run_`), `tenant_id`, `task` (e.g. `account_brief`), `prompt_version` (e.g. `v1.2`), `mode` (live, rules, mock), `model`, `input_hash` (sha256 of the canonical input), `input_ref` (json: the module and subject ids the input came from), `status` (ok, invalid_output, error, refused_by_cap), `output` (json, validated), `error`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_cents`, `duration_ms`, `actor` (user, key or system), `correlation_id`, `created_at` |
| `ai_setting` | `tenant_id`, `task`, `model` (override), `enabled`, `max_cost_cents_per_run` |

Prompts are code, not data: `src/modules/ai-tasks/prompts/<task>.v<major>.<minor>.ts`. Each run stores
the version so any output can be traced to the exact prompt.

## Depends on

- INT: the Anthropic adapter through `gateway.call` (credentials, caps, call log).

## Epics

| Epic | File | Release |
|---|---|---|
| AI-E1 Task runner and run log | [task-runner-and-run-log.md](task-runner-and-run-log.md) | R0 |
| AI-E2 Rules fallback | [rules-fallback.md](rules-fallback.md) | R0 |
| AI-E3 Task catalog | [task-catalog.md](task-catalog.md) | per task |
| AI-E4 Prompt versions and checks | [prompt-versions-and-checks.md](prompt-versions-and-checks.md) | R1 |

## Public interface

- `runTask(ctx, task, input, { subject, allowRules = true }) → { output, runId, mode }`
- `runTaskAsync(ctx, task, input, { subject, replyEvent })` publishes `jobs.ai.run` and, when done,
  publishes the caller's reply event with the run id (for long tasks).
- `getRun(ctx, runId)` for "how was this written" links.

## Events

| Event | Data |
|---|---|
| `ai.run.completed` | `runId`, `task`, `promptVersion`, `mode`, `model`, `status`, `inputTokens`, `outputTokens`, `costCents`, `subject` (`{ type, id }`), `correlationId` |

ANL turns `costCents` into automatic cost lines (agent compute). Consumes nothing.

## API endpoints

None. AI output reaches the API through the owning module's resources (a brief is part of
`GET /api/v1/accounts/{id}/brief`).

## MCP tools

None directly.

## Models (defaults, overridable per task and tenant)

| Use | Model |
|---|---|
| Long reasoning and writing (briefs, proposals, diagnosis, win analysis, retro) | `claude-opus-5-5` |
| Everyday structured tasks (call prep, outreach sequences, statements, segments, conflict explanation) | `claude-sonnet-5-5` |
| Cheap high-volume tasks (CSV column mapping, research note, classification) | `claude-haiku-5-5` |

## Open questions

- Should tenants bring their own Anthropic key (yes, per D18 the key is per tenant) or use a Taazaa
  key billed back? Spec's call: per-tenant key; Taazaa's tenant uses Taazaa's key.
