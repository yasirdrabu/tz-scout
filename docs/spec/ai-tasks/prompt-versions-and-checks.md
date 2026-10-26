# AI-E4 Prompt versions and checks

Release R1

## Rules

- Prompt files are named `<task>.v<major>.<minor>.ts`. Minor: wording changes that keep the output
  schema. Major: output schema changes; the owning module must accept both versions until stored
  outputs are migrated or regenerated.
- Each task has a small check set in `src/modules/ai-tasks/checks/<task>/`: 5 to 20 recorded inputs with
  assertions on the output (schema valid, required citations present, banned content absent such as
  research intent quoted in an opener, length limits).
- `npm run ai:check <task>` runs the set against the live model; CI runs it only on demand (it costs
  money). Mock and rules modes run in normal CI.
- Changing a prompt requires a passing check run noted in the pull request.

## Stories

### AI-E4-S1 Trace any text to its prompt
As an owner, I want to see which prompt version wrote a piece of text, so that a bad output can be
traced and fixed.
- AI-E4-S1-AC1 The run detail shows task, prompt version and model; the version maps to one file in
  the repo.

### AI-E4-S2 Check before changing a prompt
As a developer, I want a check set per task, so that a prompt change doesn't quietly break output.
- AI-E4-S2-AC1 `ai:check account_brief` reports pass or fail per recorded input with the failing
  assertion.
