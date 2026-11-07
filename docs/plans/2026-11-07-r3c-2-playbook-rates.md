# R3c-2 Playbook Outcomes and Rates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replies, meetings and deals become outcomes tied to the playbook that ran, each crediting the steps done in the 14 days before it. The Playbooks list and page then show real Reply rate, Meeting rate and result tiles, plus a "What worked" table by step type.

**Architecture:**
- **Playbooks owns outcomes.** A new `playbooks.outcome` table is filled from three sources:
  - `crm.activity.observed` gives `reply` and `meeting`;
  - a new `crm.deal.changed` consumer gives `opportunity`, `won` and `lost`;
  - the existing no-reply check gives `no_response`.
- Each outcome attaches to the plan that ran, credits that plan's recent done steps, and publishes `playbooks.outcome.recorded`.
- A new `account_plan.finished_at` makes "finished in the last 90 days" a plain query, so the playbook rates are computed in playbooks at read time.
- Analytics consumes the event into `analytics.step_credit`. Its `whatWorked(ctx, filter)` serves `GET /analytics/what-worked`, which the playbook page reads.

**Tech Stack:** TypeScript, Hono `/api/v1`, Drizzle + Postgres RLS, outbox + NATS consumers, React 19 + TanStack Query, msw, vitest, Playwright.

**Spec:**
- `docs/spec/playbooks/outcomes-and-what-worked.md` (outcome kinds, 14-day credit, `ref` unique per kind).
- `docs/spec/playbooks/index.md` (event `playbooks.outcome.recorded`, consumed `crm.deal.changed`).
- `docs/spec/analytics/index.md` (`analytics.step_credit`, line 24).
- `docs/spec/analytics/flywheel-trends.md` (What worked roll-up 25-32, ANL-E4-S3 44-50).
- `docs/spec/web-ui/screens.md` §20 (776-795).
- Map: `docs/plans/2026-11-07-r3c-overview.map.md` §3.5, §5, owner questions 6-7.
- Mockup: `C:\Users\yasir\AppData\Local\Temp\claude\c--dev-tz-scout\5d5b32bf-3547-4ae0-9554-5906e0cd9276\scratchpad\mock\Taazaa Scout Operations.dc.html`, at 1730 (list footnote), 3254 (tiles) and 3297 (columns).

## Global Constraints

- **Owner defaults (2026-11-07):**
  - Outcomes come from events with 14-day step credit.
  - No manual outcomes and no what-worked score (PLB-E6-S1-AC2 and PLB-E6-S2 are out of scope).
  - Playbook rates count accounts that finished in the last 90 days. What worked counts outcomes per 10 steps.
- **Outcome kinds:** `reply`, `meeting`, `opportunity`, `won`, `lost`, `no_response`. The same CRM activity or deal never records the same kind twice: `(tenant_id, kind, ref)` is unique.
- **Credit:** the plan's steps with status `done` and `done_at` in `[occurredAt − 14 days, occurredAt]`, in equal shares. With none, `creditedStepIds` is `[]`, which means "no recent step".
- **List copy (§20, mockup 1730):**
  - Columns "Reply rate" and "Meeting rate" read "{n}%", or "–" (en dash) with nothing finished.
  - Footnote stays "Reply and meeting rates are for accounts that finished the playbook in the last 90 days."
- **Tiles (mockup 3254):**
  - `Running now` (existing), note "Accounts mid-playbook".
  - `Finished`: "{n}", note "Last 90 days".
  - `Replied`: "{x}%", note "{n} accounts" ("1 account").
  - `Booked a meeting`: "{x}%", note "{n} accounts".
  - `Won`: "{n}", note "{x}% of finished", or "None yet" with nothing finished.
  - Percent tiles read "–" with nothing finished. Percentages are whole numbers, rounded.
- **What worked (section on the playbook page):**
  - Title "What worked". Sub "Steps done in the last 90 days and the results they were credited with. A result credits the steps done in the 14 days before it."
  - Columns: Step type, Steps done, Replies, Meetings, Opportunities, Won. Each result cell shows "{n}" over "{x} per 10 steps", with x to one decimal.
  - Rows are in channel order Email, LinkedIn, Call, Meeting, Task; a channel with 0 steps done and 0 results is left out. A last row "No recent step" shows counts only.
  - Under 10 steps done, the per-10 line is muted and carries visually hidden text " (too few steps to compare)".
  - Empty state: "No steps done in the last 90 days."
  - The section shows only with `analytics:read`.
- **Wire format:** snake_case, ISO dates, integer cents.
- **Migrations:**
  - Generated with drizzle-kit (`drizzle/<module>.config.ts`). The backfill UPDATE goes in a `--custom` migration.
  - Every new table has `tenant_id`, RLS enabled and forced, and the tenant policy, like its neighbours.
- **Test env:** copy `C:\dev\tz-scout\.superpowers\sdd\2026-11-07-r3c-1-overview\test-env.md` into this plan's workspace and change the worktree to `C:\dev\tz-scout-rates`.
  - Run `db:migrate` only against that throwaway Postgres, never anything else.
  - Never touch `C:\dev\tz-scout`, other worktrees or ports 5432/4222/4250.

## Rulings (controller, 2026-11-07)

1. **The plan an outcome belongs to.** It's the account's plan with the latest `accepted_at ≤ occurredAt`, in any status. With no such plan the outcome isn't recorded: outcomes are about plays.
   - Cost if wrong: R3c-3's "on a plan vs not" needs outcomes without a plan. That would widen this rule; the table already allows a null `plan_id`.
2. **Meeting means booked.** The CRM activity `meeting` is the booking (R2d), and the tile reads "Booked a meeting". The activity's `externalId` is the ref, so a later update to the same meeting isn't a second outcome. The spec line "meeting held" is amended.
3. **Deal outcomes.**
   - `opportunity` is recorded once per plan, on the first deal event (open or won) for that plan; ref `{system}:{dealExternalId}`.
   - `won` is recorded on a deal whose status becomes `won`, and `lost` on one whose status becomes `lost`. Each is once per deal (the same ref) and carries `amountCents`.
   - `occurredAt` is `openedAt` for opportunity and `closedAt` for won and lost, falling back to `observedAt`.
4. **no_response.** It's recorded when `playbooks.plan.no_reply` fires (inside `checkNoReply`), with ref = plan id and `occurredAt` = that time.
5. **Finished.** `finished_at` is set once, the first time any of these happens:
   - the plan becomes `completed` or `stopped`;
   - its last open step closes while it is active.
   Abandoned plans never finish. Reopening a step doesn't clear it.
   - Backfill: for each plan, the least of: the plan_change `at` of its first `completed` or `stopped` row; `no_reply_at`; and, for an active plan with ≥1 step and none open, the greatest `done_at` (or `updated_at` when every step was skipped).
6. **Rates.**
   - Finished = plans on the template with `finished_at` in the last 90 days.
   - Replied / Booked / Won = those finished plans with at least one `reply` / `meeting` / `won` outcome on the plan, at any time.
   - Rates are tenant-wide, like `Running`: they're aggregate counts that name no account.
7. **Event payload.** It's spec'd as `outcomeId`, `accountId`, `kind`, `occurredAt`, `source`, `amountCents`, `creditedStepIds`. We add `planId` (nullable), `templateId` (nullable) and `creditedSteps: {stepId, channel}[]`, so Analytics needs no read-back. The spec table is amended. `source` is `crm` or `playbooks` (no_response).
8. **step_credit.**
   - One row per credited step per outcome. An outcome with no credited step writes one row with `step_id` and `step_type` null ("No recent step").
   - It's unique on `(tenant_id, outcome_id, step_id)` with NULLS NOT DISTINCT, so a replay adds nothing (ANL-E4-S3-AC3).
   - `practice_id` and `offer_id` come from the account's journey when the event arrives (null without one). `account_id` is stored for the data limit and for merges.
9. **What worked.**
   - Last 90 days by `occurred_at` for credits, and by `done_at` for steps done.
   - Step type = plan step channel. The data limit applies to both counts (`filterVisibleAccountIds`).
   - per 10 = `round(count / stepsDone × 10, 1)`, null when stepsDone is 0. MIN_STEPS = 10 for the muted state.
   - The filter in this plan is `templateId` only. Practice and offer filters arrive with the flywheel (R3c-3).
10. **Merges.** Outcomes move to the survivor in `plansOnMerge`, and step_credit rows move in `mergeJourneys`. Refs are CRM ids, so they can't collide.
11. **Backfill.** The `backfill-outcomes <slug>` CLI replays existing data through `recordOutcome`, so events publish and Analytics fills `step_credit`:
    - CRM reply and meeting activity;
    - cached deals (opportunity from any deal, then won or lost by status);
    - plans with `no_reply_at`.
    It's safe to run again. Deploy note: run it once per workspace, after `backfill-journeys`.
12. **Out of scope:**
    - outcome lists on the account page;
    - manual outcomes;
    - the what-worked score;
    - practice and offer filters;
    - CSV export;
    - `jobs.history.republish` for outcomes.

## Review Focus

1. A redelivered `crm.activity.observed` or `crm.deal.changed` must not double an outcome or its credit rows. Tasks 2 and 4 test redelivery.
2. A reply that arrives after a plan was stopped or completed still belongs to that plan (Ruling 1). It must not be dropped because the plan is closed: today's `onCrmActivity` only looks at open plans. Task 2 tests a reply on a completed plan.
3. A step done exactly 14 days before the outcome is credited, and one done 14 days and 1 ms before isn't. A step done after the outcome is never credited. Task 1 tests the boundaries.
4. A playbook with plans finished more than 90 days ago, or only abandoned plans, shows "–" rates and "None yet", not 0%. Tasks 3 and 5 test this.
5. Under `own_accounts`, What worked counts only the seller's accounts in both numerator and denominator. Task 4 tests it.

---

### Task 1: Outcome table, finished_at, credit rule and recordOutcome

**Files:**
- Modify: `src/modules/playbooks/db/schema.ts` (new `outcome` table; `accountPlan.finishedAt`), plus a generated migration `0008_*` and a custom migration `0009_finished_at_backfill.sql` (Ruling 5's UPDATE).
- Modify: `src/modules/playbooks/contracts/events.ts` (`outcomeRecorded`), `src/modules/playbooks/index.ts` (export it, `OUTCOME_KINDS`, `recordOutcome`).
- Create: `src/modules/playbooks/domain/credit.ts`, `src/modules/playbooks/services/outcomes.ts`.
- Modify: `src/modules/playbooks/services/plans.ts`:
  - `move()` sets `finishedAt` when the new status is `completed` or `stopped` and it's null.
  - New `checkFinished(ctx, planId)`, called at the start of `checkNoReply`, sets it when the plan is active, has ≥1 step and none open.
- Test: `src/modules/playbooks/domain/credit.test.ts`, `tests/integration/playbooks/outcomes.test.ts`.

**Interfaces:**
- Produces:
  - `outcome` columns: `id` (`out_`), `tenant_id`, `account_id`, `plan_id` (nullable), `template_id` (nullable), `kind`, `ref`, `source`, `occurred_at`, `amount_cents` (nullable), `credited_step_ids text[]`, `created_at`.
  - Indexes on `outcome`: unique `(tenant_id, kind, ref)`; an index on `(tenant_id, plan_id)`; a check on `kind`.
  - `OUTCOME_KINDS = ['reply','meeting','opportunity','won','lost','no_response'] as const`, `type OutcomeKind`.
  - `creditedSteps(steps: {id: string; channel: string; status: string; doneAt: Date | null}[], at: Date): {stepId: string; channel: string}[]`. It returns the done steps with `at − 14d ≤ doneAt ≤ at`, ordered by doneAt then id. `CREDIT_WINDOW_MS = 14 * 86_400_000`.
  - `recordOutcome(ctx, input: {accountId: string; kind: OutcomeKind; ref: string; occurredAt: Date; source: 'crm' | 'playbooks'; amountCents?: number | null; planId?: string}): Promise<{id: string} | null>`.
    - Without `planId` it picks the plan (Ruling 1); null means no plan or a duplicate ref.
    - For `opportunity` it returns null when the plan already has one.
    - It inserts with ON CONFLICT DO NOTHING on `(tenant_id, kind, ref)`. It publishes `outcomeRecorded` only when the row was inserted, with subject `{type: 'account', id: accountId}`.
  - Event `outcomeRecorded` = `defineEvent('playbooks.outcome.recorded', 1, {outcomeId, accountId, planId: nullable, templateId: nullable, kind, occurredAt, source, amountCents: nullable, creditedStepIds: string[], creditedSteps: {stepId, channel}[]})`.

- [ ] **Step 1: Write the failing unit tests** in `credit.test.ts`:
  - `credits a done step exactly 14 days before`;
  - `skips a step done 14 days and 1 ms before`;
  - `skips a step done after the outcome`;
  - `skips skipped and open steps`;
  - `returns [] when nothing is recent`.
  Use `at = new Date('2026-11-07T12:00:00Z')`.
- [ ] **Step 2: Write the failing integration tests** in `outcomes.test.ts`:
  - `records a reply on the plan accepted before it and credits its recent steps`: it asserts the row, `credited_step_ids`, and one published event with `creditedSteps[0].channel`.
  - `the same kind and ref twice records once and publishes once`.
  - `no plan accepted before occurredAt records nothing`.
  - `picks the later of two plans by accepted_at`.
  - `a second opportunity on the same plan records nothing`.
  - `finished_at is set on complete and on stop, and once`.
  - `finished_at is set when the last open step closes on an active engaged plan`.
  - `abandon leaves finished_at null`.
  - `RLS: another tenant cannot read outcome rows`.
- [ ] **Step 3: Run them** with `npx vitest run --project unit src/modules/playbooks/domain/credit.test.ts` and `npx vitest run --project integration tests/integration/playbooks/outcomes.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the schema, the generated migration (`npx drizzle-kit generate --config drizzle/playbooks.config.ts`) and the custom backfill migration (`--custom --name finished_at_backfill`), `credit.ts`, `outcomes.ts`, the event, and the `plans.ts` changes. `recordOutcome` locks the chosen plan row (`for update`) before the opportunity check and the step read.
- [ ] **Step 5: Run the tests again, plus** `tests/integration/playbooks` as a whole. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(playbooks): outcome table, finished_at and 14-day step credit`.

### Task 2: Record outcomes from CRM activity, deals and no-reply

**Files:**
- Modify: `src/modules/playbooks/services/crm-activity.ts`. For `reply` and `meeting`, call `recordOutcome({kind, ref: \`${system}:${externalId}\`, source: 'crm', occurredAt})` before the open-plan lookup, so a closed plan still gets its outcome (Review Focus 2). Then the existing engaged and stop logic runs unchanged.
- Create: `src/modules/playbooks/services/deal-outcomes.ts` (`onDealChanged(e, ctx)`, Ruling 3).
- Modify: `src/modules/playbooks/consumers.ts`. Add `outcomesOnDealChanged` (`event: dealChanged`, ordered by account) and register it in `playbooksConsumers` and `index.ts`.
- Modify: `src/modules/playbooks/services/plans.ts`. `checkNoReply` records `no_response` (`ref: planId`, `source: 'playbooks'`, `planId`).
- Modify: `src/modules/playbooks/services/start.ts`. `plansOnMerge` moves outcome rows to the survivor.
- Test: `tests/integration/playbooks/outcome-sources.test.ts`.

**Interfaces:**
- Consumes `recordOutcome` and `outcomeRecorded` (Task 1).
- Produces the consumer `outcomesOnDealChanged`, and `onDealChanged(e: {data: z.output<typeof dealChanged.data>}, ctx): Promise<void>`. That function resolves a merged account via `resolveAccountId`, like `onCrmActivity`.

- [ ] **Step 1: Write the failing tests:**
  - `a reply after accept records reply with credit`.
  - `a reply before accept records nothing`.
  - `a reply on a completed plan still records on that plan`.
  - `a meeting records meeting once even when its activity is observed again`.
  - `task_done and email record nothing`.
  - `first open deal records opportunity; a second deal does not`.
  - `a deal going open→won records won with amountCents and occurredAt = closedAt`.
  - `a deal arriving already won records opportunity and won`.
  - `a redelivered won deal records won once`.
  - `lost records lost`.
  - `the last step closing with no reply records no_response with ref = planId`.
  - `merge moves outcomes to the survivor`.
- [ ] **Step 2: Run** `npx vitest run --project integration tests/integration/playbooks/outcome-sources.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run the tests again, plus** `tests/integration/playbooks` and `tests/integration/crm`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(playbooks): record reply, meeting, deal and no-response outcomes`.

### Task 3: Playbook rates on the API and the outcome backfill

**Files:**
- Modify: `src/modules/playbooks/services/templates.ts`.
  - `TemplateSummary` gains `results: {finished: number; replied: number; meetings: number; won: number}` (Ruling 6, 90 days back from now).
  - Use one grouped query per kind set over `ids`, alongside the existing `running` query. `TemplateDetail` inherits it.
- Modify: `src/http/routes/v1/playbooks/schemas.ts` and any response schema or OpenAPI entry that lists `running`, so `results` goes out in snake_case.
- Modify: `src/modules/crm/services/read.ts`.
  - Add `listOutcomeActivity(ctx): Promise<{accountId; system; externalId; kind: 'reply' | 'meeting'; occurredAt: Date}[]>`.
  - Add `openedAt` to `listDeals`'s rows. Export both from `crm/index.ts`.
- Create: `src/modules/playbooks/services/backfill-outcomes.ts`, with `backfillOutcomes(ctx): Promise<number>`, which returns the outcomes recorded (Ruling 11).
- Modify: `src/entry/cli.ts`: the `backfill-outcomes <slug>` command and its help line "Record a workspace's playbook outcomes (replies, meetings, deals, no response) from its CRM history and plans".
- Test: `tests/integration/playbooks/rates.test.ts`, `tests/integration/playbooks/backfill-outcomes.test.ts`.

**Interfaces:**
- Consumes `recordOutcome` (Task 1).
- Produces the list and detail JSON field `results: {finished, replied, meetings, won}`. Task 5 reads it.

- [ ] **Step 1: Write the failing tests:**
  - `results counts plans finished in the last 90 days, and replied, meetings and won among them`.
  - `a plan finished 91 days ago and an abandoned plan count nothing`.
  - `a template with no finished plans returns zeros`.
  - `GET /api/v1/playbooks and /playbooks/:id include results`.
  - `backfillOutcomes records replies, meetings, opportunity, won and no_response, and a second run records 0`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run the tests again, plus** `tests/integration/playbooks` and the playbooks route tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(playbooks): finished, replied, booked and won per playbook; backfill-outcomes`.

### Task 4: step_credit and What worked in Analytics

**Files:**
- Modify: `src/modules/analytics/db/schema.ts` (the `step_credit` table, Ruling 8), plus a generated migration.
- Modify: `src/modules/analytics/consumers.ts`:
  - `analyticsStepCredit` (event `outcomeRecorded`, ordered by account), registered in `analyticsConsumers`.
  - `mergeJourneys` in `services/journeys.ts` also moves `step_credit.account_id`.
- Create: `src/modules/analytics/services/what-worked.ts`, `src/modules/analytics/domain/what-worked.ts`.
- Modify: `src/modules/playbooks/services/facts.ts`.
  - Add `listDoneSteps(ctx, w: {from: Date; to: Date}): Promise<{accountId; templateId; channel; doneAt: Date}[]>`.
  - Export it from `playbooks/index.ts`.
- Create: `src/http/routes/v1/analytics/what-worked/route.ts` (`GET`, `analytics:read`, query `template_id` optional), registered next to the other analytics routes.
- Test: `src/modules/analytics/domain/what-worked.test.ts`, `tests/integration/analytics/what-worked.test.ts`.

**Interfaces:**
- Consumes `outcomeRecorded` (Task 1).
- `step_credit` columns: `tenant_id`, `outcome_id`, `outcome_kind`, `step_id` (null for no recent step), `step_type` (null likewise), `playbook_template_id`, `practice_id`, `offer_id`, `account_id`, `occurred_at`.
- Produces `whatWorked(ctx, filter: {templateId?: string}): Promise<WhatWorked>`, where:
  - `WhatWorked = {rows: WhatWorkedRow[]; noRecentStep: Counts; minSteps: 10}`;
  - `WhatWorkedRow = {stepType: StepChannel; stepsDone: number; counts: Counts; per10: {reply: number | null; meeting: number | null; opportunity: number | null; won: number | null}}`;
  - `Counts = {reply: number; meeting: number; opportunity: number; won: number}`.
  Rows follow channel order `email, linkedin, call, meeting, task` and leave out all-zero channels (Global Constraints). The pure `rollUp(credits, doneSteps): WhatWorked` lives in `domain/what-worked.ts`.
- Route response: `{rows: [{step_type, steps_done, counts: {reply, meeting, opportunity, won}, per_10: {...}}], no_recent_step: {...}, min_steps: 10, updated_at}`. `updated_at` is the latest `step_credit` row's `occurred_at`, or null.

- [ ] **Step 1: Write the failing unit tests:**
  - `per10 rounds to one decimal`;
  - `per10 is null with 0 steps done`;
  - `rows keep channel order and drop all-zero channels`;
  - `no_response and lost credits are not counted in rows`;
  - `a step credited by two outcomes counts once per outcome`.
- [ ] **Step 2: Write the failing integration tests:**
  - `an outcome event writes one row per credited step with practice and offer from the journey`;
  - `an outcome with no credited step writes one null-step row`;
  - `a replayed event adds no rows`;
  - `whatWorked matches a hand count for scripted outcomes` (ANL-E4-S3-AC2);
  - `templateId filters`;
  - `under own_accounts only the seller's accounts count, both sides`;
  - `credits older than 90 days are left out`;
  - `GET /api/v1/analytics/what-worked returns snake_case and 403 without analytics:read`;
  - `merge moves credit rows`;
  - `RLS: another tenant reads no rows`.
- [ ] **Step 3: Run** `npx vitest run --project unit src/modules/analytics/domain/what-worked.test.ts` and `npx vitest run --project integration tests/integration/analytics/what-worked.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the changes listed under Files.
- [ ] **Step 5: Run the tests again, plus** `tests/integration/analytics`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(analytics): step credit from outcomes and the what-worked roll-up`.

### Task 5: Web UI rates, tiles and What worked, plus docs and e2e

**Files:**
- Modify: `web-ui/src/features/playbooks/api.ts`. Add `results` to the playbook types, plus `useWhatWorked(templateId)` calling `GET /analytics/what-worked?template_id=` with the `WhatWorked` type.
- Modify: `web-ui/src/features/playbooks/PlaybookList.tsx` (Reply rate and Meeting rate cells), `PlaybookView.tsx` (tiles and the What worked section; remove the note "Results appear once accounts have finished the playbook."), `Playbooks.module.css` (only what the section needs).
- Delete: `web-ui/src/features/playbooks/NotYet.tsx` once nothing imports it.
- Modify: `web-ui/src/features/playbooks/testing.ts` and the msw handlers in `web-ui/src/test/server.ts` (results on the fixtures, plus a what-worked handler).
- Test: `web-ui/src/features/playbooks/playbooks.test.tsx` (extend it), `tests/e2e/playbook-rates.spec.ts`.
- Docs:
  - `docs/spec/playbooks/index.md`: event payload, Ruling 7.
  - `docs/spec/playbooks/outcomes-and-what-worked.md`: meeting = booked, Ruling 2; deal rules, Ruling 3; "As built (R3c-2)" with the out-of-scope list.
  - `docs/spec/analytics/index.md`: step_credit's null-step row and `account_id`.
  - `docs/spec/web-ui/screens.md` §20: an "As built (R3c-2)" paragraph with the copy above.
  - `docs/spec/web-ui/api-gaps.md`: `GET /analytics/what-worked`, `results`.

**Interfaces:**
- Consumes `results` (Task 3) and `GET /analytics/what-worked` (Task 4).

- [ ] **Step 1: Write the failing web tests:**
  - `list shows 40% and 20% for finished 5, replied 2, meetings 1`.
  - `list shows – with nothing finished`.
  - `tiles show Finished 5 / Last 90 days, Replied 40% / 2 accounts, Booked a meeting 20% / 1 account, Won 1 / 20% of finished`.
  - `with nothing finished, tiles show – and Won None yet`.
  - `What worked lists Email then Call with "3" over "1.5 per 10 steps"`.
  - `under 10 steps the per-10 line is muted with the hidden text`.
  - `No recent step row shows counts`.
  - `empty state copy`.
  - `the section is hidden without analytics:read`.
- [ ] **Step 2: Run** `cd web-ui && npx vitest run src/features/playbooks`. Expected: FAIL.
- [ ] **Step 3: Implement** the UI and docs.
- [ ] **Step 4: Run the tests again, plus** the whole web suite (`cd web-ui && npx vitest run`), `npm run lint` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Write the e2e test** `tests/e2e/playbook-rates.spec.ts`. It seeds a plan whose steps are done, a CRM reply, then the plan is completed. It asserts:
  - the list's Reply rate reads "100%";
  - the playbook page's Replied tile reads "100%" and "1 account";
  - What worked shows a "Replies" count of 1.
  Run it per test-env.md. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(web-ui): playbook reply and meeting rates, result tiles and what worked`.
