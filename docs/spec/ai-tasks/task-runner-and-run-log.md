# AI-E1 Task runner and run log

Release R0

## Rules

- A task is defined by: `name`, `promptVersion`, `model` default, `system` prompt, `buildUser(input)`,
  input Zod schema, output Zod schema, optional `rules(input)` fallback, optional `mock(input)`,
  `maxTokens`, `maxCostCents`.
- Output is requested as structured output (JSON schema derived from the Zod schema, objects closed)
  and validated with Zod. One automatic retry on invalid output, with the validation errors fed back.
  A second failure is stored with status `invalid_output` and returned as an error.
- Every call, including rules and mock runs, writes an `ai_run` row. Live runs record tokens and cost
  (cost from a price table per model, in cents, rounded up).
- Prompt caching is used for the system prompt and any large shared context (offer catalogue,
  playbook template).
- Each run is a call through `gateway.call(ctx, 'anthropic', ...)`, so tenant caps apply; a run refused
  by a cap is stored as `refused_by_cap` and falls back to rules when the task has them.
- Text written by AI and shown in the UI carries a small "Written by Claude" or "Assembled from rules"
  label that links to the run (who triggered it, when, prompt version, model).
- Personal data sent to Claude is limited to what the task needs; the input schema is the allow list.

## Stories

### AI-E1-S1 Run a task
As a module developer, I want one call to run a task with validation and logging, so that every AI
feature behaves the same.
- AI-E1-S1-AC1 `runTask` with valid input returns validated output and a run id; an `ai_run` row exists
  with input hash, model, tokens and cost.
- AI-E1-S1-AC2 Given the model returns output that fails the schema twice, then the run is stored as
  `invalid_output` and the caller gets an error naming the task.

### AI-E1-S2 Same input, same run
As an owner, I want repeated identical requests not to be charged twice, so that costs stay down.
- AI-E1-S2-AC1 Given an ok run with the same task, prompt version and input hash in the last 24 hours,
  `runTask` returns that run's output without a new call unless `fresh: true` is passed.

### AI-E1-S3 See AI runs
As an owner, I want a list of AI runs with cost, so that I can see what Claude is used for.
- AI-E1-S3-AC1 Admin → AI shows runs filterable by task, status, mode and date, with totals of tokens
  and cost per task this month.
- AI-E1-S3-AC2 Each run opens to show the input (redacted of emails and phones), output, prompt
  version, model and duration.
