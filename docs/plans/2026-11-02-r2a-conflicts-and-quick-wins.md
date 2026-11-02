# R2a: field conflicts, rescore progress, estimated value

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When two sources disagree about an account value, Scout flags it, shows both values, and lets a person keep one. Rescores show live progress. All accounts shows an estimated value when there is no deal.

**Architecture:** Conflicts live in the accounts module: a pure tolerance rule in `domain/`, an `accounts.conflict` table, detection inside `reproject` for the keys a new fact touched, and a people-only resolve route. Losing sources get `conflict_lost` feedback through an intake consumer. Rescore progress is a `scoring.rescore_run` row that the existing page/accounts jobs count into. Estimated value is a scoring batch read that routing's list rows fall back to.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest, React 19 + TanStack Query, msw, Playwright.

**Spec:** docs/spec/accounts/facts-provenance-and-conflicts.md (ACC-E3-S3, S4), docs/spec/accounts/index.md (table `conflict`, events, routes), docs/spec/scoring-and-matching/rescoring-and-weights.md (SCO-E5-S3-AC3, S4-AC1), docs/spec/scoring-and-matching/four-weight-model.md (revenue potential), docs/spec/web-ui/screens.md (§2 flags, §4a facts and Before you approve, §8 Value, §21f), docs/spec/web-ui/api-gaps.md. Code map: docs/plans/2026-11-02-r2a-conflicts-and-quick-wins.map.md (file:line references; read the section for your task).

## Rulings (Claude's calls, 2026-11-02; Task 9 writes them into the specs)

1. Tolerances are defaults in code only. No Settings table or screen in R2.
2. Only these keys can conflict: `employees` (count, more than 20% apart); `revenue_cents` (money, more than 25%); `contract_value_cents`, `budget_cents`, `price_cents` (money, more than 10%); `industry_key`, `hq_country` (category: different value); person `email`, `phone`, `mobile_phone`, `title` (different after normalising: trim, lower case; phones digits only). Every other key never conflicts. That includes ranges (`employees_min/max`, `revenue_min/max_cents`), lists and free text.
3. Percent difference is `|a - b| / max(|a|, |b|)`. 3,000 vs 3,500 employees = 14.3%, so no conflict. $20.9M vs $18.4M contract value = 12.0%, so it is a conflict.
4. A conflict opens when a live fact from a different source chain differs from the current value beyond tolerance. There is one open conflict per (account, person, key). Further disagreeing facts join its `fact_ids`.
5. A losing source re-sending the value it lost (same chain, equal value to one of its `archived` facts for that key) is stored as `archived` and opens nothing.
6. Resolving: `POST /api/v1/conflicts/{id}:resolve` `{kept_fact_id, note?}`, `review:act`, people only. It pins the kept fact, archives the conflict's other facts, and closes the conflict. Calling it on a resolved conflict switches the kept value: this is "Kept by {name} · Change". The previously archived fact becomes the pinned one, and the old pin is archived.
7. A person editing a key that has an open conflict closes it with `resolution: 'edited'`. The edit's fact is kept and the conflict's facts are archived. `losingSourceIds` is empty, so no source is penalised.
8. In R2, a lost conflict records `conflict_lost` feedback for each losing source's arrival only. The 0.01 trust drop arrives with trust from outcomes (R3b).
9. `conflict_explanation` never names a winner (ACC wins over the task catalog). There is no rules fallback. In `rules` or `mock` mode no explanation is stored or shown.
10. There is no backfill. Detection runs when facts arrive or are edited from this release on.
11. The queue count is `accounts.account_summary.open_conflict_count`, written in the same transaction as detect and resolve. `flag=conflicts` filters on it.
12. Rescore progress is tenant-wide: a count, no account data. The latest run is shown.
13. The estimated value is the best offer's `revenue_potential_cents` in USD (offers store USD cents). It shows only when the account has no won or open deal. The CSV value kind is `estimated`.
14. Warm-intro R2 items (Confirm flow, introducer rules screen, rescore on points change) are not in R2a. They become their own plan after R2a, because screens.md has no section for them yet.

## Global Constraints

- Copy is fixed by the spec. Exact strings: "Only a person can settle a disagreement between sources." (403); "{n} conflicts to resolve" / "1 conflict to resolve" / "All facts agree"; "Sources disagree"; `Keep this one`; "Kept by {name} · Change"; toast "Kept {value} from {source}. Scout will use it in the brief and HubSpot."; checklist "Resolve 1 conflicting fact: {label}." / "Resolve {n} conflicting facts." with `Resolve`; after: "Facts agree. {label} set to {value}."; "Rescoring {total} accounts" and "{done} of {total} rescored"; value sub-label "Estimated".
- New tables carry `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy (map §1.10). Next migrations: accounts `0007_conflicts.sql`, scoring `0003_rescore_runs.sql`, generated with the module's drizzle config and RLS appended by hand.
- Events are `defineEvent(type, 1, zod)` in the module's `contracts/events.ts` and are published through the outbox in the same transaction. New consumers go in `src/entry/worker.ts`.
- Ids: conflict `cfl_`, rescore run `rsr_`.
- Web UI uses `apiFetch`, query keys `['account', tenant, id, 'conflicts']` and `['review-queue', tenant, 'rescore']`, and invalidates by prefix after mutations.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An account whose conflict facts move in a merge. Expected: the conflict follows the survivor (re-pointed like notes) and the count stays right on both summaries. Test in Task 2.
2. Two arrivals racing on the same key. Expected: one open conflict, not two. A partial unique index enforces it and `lockAccount` serialises it. Test in Task 2.
3. Resolving with a `kept_fact_id` not in the conflict, or on a hidden account. Expected: 400 and 404, and nothing changes. Test in Task 3.
4. A person-contact conflict (email) seen by a user without `people:read`. Expected: the conflict is omitted from `GET /accounts/{id}/conflicts`, the same as facts hide contact values. Test in Task 3.
5. A rescore run whose last message fails and retries. Expected: `done` never passes `total`, and `finished_at` is set once. Test in Task 7.

---

### Task 1: Tolerance rule (domain)

**Files:**
- Create: `src/modules/accounts/domain/conflicts.ts`
- Test: `tests/unit/accounts/conflicts.test.ts`

**Interfaces:**
- Produces: `toleranceFor(key: string): Tolerance | null` (null means the key never conflicts); `type Tolerance = {kind: 'count'|'money'|'category'|'contact', percent?: number}`; `differs(key: string, a: unknown, b: unknown): boolean`.

- [ ] **Step 1: Write the failing tests.** Cover every key in Ruling 2, plus:
  - `differs('employees', 3000, 3500) === false`
  - `differs('contract_value_cents', 2_090_000_000, 1_840_000_000) === true`
  - `differs('revenue_cents', 100, 124) === false` and `differs('revenue_cents', 100, 126) === true`
  - `differs('industry_key','transit','transit') === false`
  - `differs('email','A@x.gov ','a@x.gov') === false`
  - `differs('phone','(305) 555-0100','305.555.0100') === false`
  - `toleranceFor('description') === null`, `toleranceFor('technologies') === null`, `toleranceFor('employees_min') === null`, `toleranceFor('name') === null`
  - null or non-number values for count/money return `false`
- [ ] **Step 2:** Run `npx vitest run tests/unit/accounts/conflicts.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement per Rulings 2–3, with the key table as a `const` record.
- [ ] **Step 4:** Run again. Expected: PASS. Then run `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(accounts): the tolerance rule that decides when sources disagree`.

### Task 2: Conflict table, detection, events, summary count

**Files:**
- Modify: `src/modules/accounts/db/schema.ts` (table `conflict`; `account_summary.open_conflict_count int not null default 0`)
- Create: `src/modules/accounts/db/migrations/0007_conflicts.sql` (+ journal/snapshot from drizzle-kit, RLS by hand)
- Create: `src/modules/accounts/services/conflicts.ts`
- Modify: `src/modules/accounts/services/facts.ts` (`recordFacts` Ruling 5; call detection from `reproject`)
- Modify: `src/modules/accounts/services/upsert.ts` (`UpsertResult.conflictIds`)
- Modify: `src/modules/accounts/services/merge.ts` (re-point conflicts, recount both summaries)
- Modify: `src/modules/accounts/contracts/events.ts` (`conflictDetected`, `conflictResolved`)
- Test: `tests/integration/accounts/conflicts.test.ts`, extend `tests/integration/accounts/merge.test.ts`

**Interfaces:**
- Consumes: `differs`, `toleranceFor` (Task 1); `pickCurrent` result inside `reproject`.
- Produces:
  - Table `accounts.conflict(id, tenant_id, account_id, person_id null, key, fact_ids text[], status 'open'|'resolved', resolution null|'kept'|'edited', kept_fact_id null, resolved_by null, resolved_at null, note null, explanation null, explanation_fact_ids text[] null, created_at)`, with a partial unique index on (tenant_id, account_id, coalesce(person_id,''), key) where status = 'open'.
  - `detectConflicts(ctx, accountId, groups: {personId: string|null, key: string, currentId: string, live: PickFact[]}[]): Promise<string[]>` returns conflict ids opened or extended.
  - Events `accounts.conflict.detected` `{conflictId, accountId, personId?, key, factIds[], sourceIds[]}` and `accounts.conflict.resolved` `{conflictId, accountId, key, keptFactId, archivedFactIds[], winningSourceIds[], losingSourceIds[], resolvedBy, resolution, note?}` (the latter is used by Task 3).
  - `recountOpenConflicts(ctx, accountId): Promise<void>` writes `account_summary.open_conflict_count`.

- [ ] **Step 1: Write the failing integration tests.**
  - An arrival from source A with `contract_value_cents` 2,090,000,000, then one from source B with 1,840,000,000: one open conflict with both fact ids, `open_conflict_count` 1, one `accounts.conflict.detected` in the outbox, and `upsertFromArrival(...).conflictIds` has its id.
  - The same with employees 3000 vs 3500: no conflict.
  - A third source with a third differing value: the same conflict, with 3 fact ids.
  - The same source sending a newer value: superseded, no conflict.
  - Two concurrent arrivals (`Promise.all`) disagreeing with the current value: exactly one open conflict.
  - Merge: survivor gets the conflict and count; merged account's count is 0.
- [ ] **Step 2:** Run `npx vitest run tests/integration/accounts/conflicts.test.ts` and confirm it fails.
- [ ] **Step 3:** Generate the migration with `npx drizzle-kit generate --config drizzle/accounts.config.ts`, then append RLS lines as in `0006_notes_and_lead_offer.sql`.
- [ ] **Step 4:** Implement detection.
  - In `reproject`, after `pickCurrent` per group, call `detectConflicts` only for groups whose key has a tolerance and whose live facts include a fact that is not superseded, comes from another chain, and `differs` from the current value. Skip when called from merge (flag argument).
  - Insert-or-extend uses `on conflict` against the partial unique index.
  - Publish `detected` only when the conflict opens or gains a fact.
- [ ] **Step 5:** Run the tests, `npm run test:unit`, and `npx vitest run tests/integration/accounts tests/integration/platform/rls-catalog.test.ts`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(accounts): detect conflicting facts and count them on the account`.

### Task 3: Resolve, read, audit, edit closes, source feedback

**Files:**
- Modify: `src/modules/accounts/services/conflicts.ts` (`listConflicts`, `resolveConflict`, `closeByEdit`)
- Modify: `src/modules/accounts/services/edit.ts` (call `closeByEdit` for edited keys), `src/modules/accounts/index.ts` (exports)
- Create: `src/http/routes/v1/accounts/[id]/conflicts/route.ts`, `src/http/routes/v1/conflicts/[id]/route.ts`; modify `src/http/routes.ts`
- Modify: `src/modules/intake/services/feedback.ts` (`recordConflictLost`), `src/modules/intake/consumers.ts` (`intakeConflictFeedback`), `src/entry/worker.ts`
- Test: `tests/integration/v1/conflicts.test.ts`, `tests/integration/intake/conflict-feedback.test.ts`, extend `tests/integration/v1/people-only.test.ts`

**Interfaces:**
- Consumes: the Task 2 table and events.
- Produces:
  - `GET /api/v1/accounts/{id}/conflicts` (`accounts:read`) returns `{data: [{id, key, label, person_id, status, resolution, kept_fact_id, resolved_by_name, resolved_at, note, explanation, facts: [{id, value, observed_at, source_names{person,agent,vendor}, trust, status}]}]}`. It returns open conflicts plus those resolved in the last 30 days, open first. Person contact keys are omitted without `people:read`.
  - `POST /api/v1/conflicts/{id}:resolve` `{kept_fact_id: string, note?: string (≤ 1000)}` returns 200 with the conflict view. It uses `v1Route({permission: 'review:act', peopleOnly: 'Only a person can settle a disagreement between sources.'})`. Errors: 404 for hidden or missing, 400 when `kept_fact_id` is not in the conflict.
  - `resolveConflict(ctx, id, keptFactId, note?)` locks the account, pins the kept fact, archives the others, sets status, calls `reproject(key)`, `audit({action: 'accounts.conflict.resolve', subject: {type:'conflict', id}, after: {keptFactId, archivedFactIds, note}})`, publishes `accountUpdated` + `conflictResolved`, and recounts.
  - `recordConflictLost(ctx, {accountId, factArrivalIds: string[], winnerSourceName, causeEventId})` writes one `conflict_lost` feedback row per losing source's arrival (note = the winner's source name).

- [ ] **Step 1: Write the failing tests.**
  - Resolve keeps B: B is pinned and current, A is archived, the account column equals B's value, the count is 0, one audit row with the note, and `resolved` lists A's source as losing.
  - Resolving again with A switches the pin (Ruling 6).
  - An API key gets 403 with the exact copy.
  - A foreign `kept_fact_id` gets 400; a hidden account gets 404.
  - A seller without `people:read` doesn't see an email conflict.
  - `editAccount` on the key closes the conflict with `resolution 'edited'` and empty losing ids.
  - After `runOutbox`, a `conflict_lost` feedback row exists for A and none for B.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Route files follow `accounts/[id]/facts/route.ts` and `idAndAction`, and both are added to `routes.ts`.
- [ ] **Step 4:** Run `npx vitest run tests/integration/v1/conflicts.test.ts tests/integration/intake tests/integration/v1/people-only.test.ts tests/unit/http/routes.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): keep one value of a conflict; losing sources hear about it`.

### Task 4: Conflict explanation (AI task)

**Files:**
- Create: `src/modules/accounts/tasks/conflict-explanation.ts`, `src/modules/accounts/tasks/prompts/conflict-explanation.v1.0.ts`, `src/modules/accounts/contracts/jobs.ts` (`conflictExplainJob`), `src/modules/accounts/jobs.ts` handler (or the module's existing job registration)
- Modify: `src/modules/accounts/services/conflicts.ts` (enqueue on open/extend)
- Test: `tests/integration/accounts/conflict-explanation.test.ts`

**Interfaces:**
- Consumes: `defineTask`, `runTask` from `@/modules/ai-tasks` (map §1.8); the `briefDraftJob` pattern.
- Produces: `conflict.explanation` and `explanation_fact_ids`, set only when `runTask` mode is `live`. Output schema `{explanation: string (≤ 200 chars), fact_ids: string[]}`. The system prompt forbids naming which value is right (Ruling 9). Model `claude-sonnet-5-5`.

- [ ] **Step 1:** Write the failing tests.
  - In test mode (mock), the job runs and `explanation` stays null.
  - With `runTask` stubbed to return mode `live`, the explanation and fact ids are stored, and the ids must be a subset of the conflict's fact ids (others are dropped).
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. The job is enqueued in the detection transaction (`enqueueJob`), not run inline.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): one line on why two sources may differ`.

### Task 5: Queue count and conflicts filter

**Files:**
- Modify: `src/modules/accounts/services/search.ts` (`SearchRow.openConflictCount`; filter `hasOpenConflicts`), `src/modules/routing/services/queue.ts:128` (`conflictCount: r.openConflictCount`; `flag === 'conflicts'` maps to `hasOpenConflicts`), `src/http/routes/v1/review-queue/filters.ts` (accept `conflicts`)
- Test: `tests/integration/v1/review-reads.test.ts` (replace the `conflict_count: 0` assertion), `tests/integration/routing/queue.test.ts`

- [ ] **Step 1:** Write the failing test. An account with an open conflict shows `conflict_count: 1`. `?flag=conflicts` returns only accounts with open conflicts. After resolving, the count is 0.
- [ ] **Step 2:** Run it and confirm it fails. **Step 3:** Implement. **Step 4:** Run the two test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(review): the queue counts open conflicts and filters by them`.

### Task 6: Web UI conflicts on the account page

**Files:**
- Modify: `web-ui/src/features/account/api.ts` (`Conflict` type, `conflictsQuery`, `resolveConflict`), `web-ui/src/features/account/ReviewView.tsx` (`AccountFacts` badge and side-by-side rows; `BeforeYouApprove` conflict line + `Resolve` scrolls to and focuses the fact), `web-ui/src/features/account/testing.ts` (msw handlers)
- Test: `web-ui/src/features/account/conflicts.test.tsx`

**Interfaces:**
- Consumes: the Task 3 routes.

- [ ] **Step 1: Write the failing tests.**
  - With one open conflict, these show: the badge "1 conflict to resolve", "Sources disagree", both values with source name and date, two `Keep this one` buttons, the checklist line "Resolve 1 conflicting fact: Contract value." and a `Resolve` button that moves focus to the fact row.
  - Clicking `Keep this one` posts `kept_fact_id`, shows the toast copy, and then renders "Kept by {name} · Change" with the other value dimmed. The checklist reads "Facts agree. Contract value set to $18.4M."
  - With none, "All facts agree" shows. An explanation shows only when present.
  - Mutations invalidate `['account', tenant, id]` and `['review-queue', tenant]`.
- [ ] **Step 2:** Run `npm --prefix web-ui test -- conflicts` and confirm it fails.
- [ ] **Step 3:** Implement with the existing tokens and components (match `AccountFacts` rows; amber chip like `RowFlags`). Money is formatted with the existing helper.
- [ ] **Step 4:** Run `npm --prefix web-ui test` and `npm --prefix web-ui run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): see and settle conflicting facts on the account page`.

### Task 7: Rescore progress

**Files:**
- Modify: `src/modules/scoring/db/schema.ts` (`rescore_run`), create `src/modules/scoring/db/migrations/0003_rescore_runs.sql`
- Modify: `src/modules/scoring/contracts/jobs.ts` (optional `runId` on both jobs), `src/modules/scoring/services/rescore.ts` (`startRescore` creates the run and returns `{jobId, runId}`; `rescorePage` adds to `total` and sets `paging_done` on the last page; `rescoreAccounts` adds its message's processed count once and sets `finished_at` when `paging_done && done >= total`)
- Create: `src/modules/scoring/services/rescore-runs.ts` (`latestRescore(ctx)`), `src/http/routes/v1/scoring/rescores/latest/route.ts`; modify `src/http/routes.ts`, `src/http/routes/v1/rescore/route.ts` (add `rescore_id`)
- Modify: `web-ui/src/features/review/api.ts` (`rescoreQuery`, refetch every 3 s while running), `web-ui/src/features/review/RescoreBanner.tsx` (running state)
- Test: extend `tests/integration/scoring/rescore.test.ts`, `tests/integration/v1/scoring.test.ts`; `web-ui/src/features/review/queue.test.tsx`

**Interfaces:**
- Produces:
  - Table `scoring.rescore_run(id, tenant_id, cause, filter jsonb, requested_by null, total int default 0, done int default 0, paging_done bool default false, started_at, finished_at null)`.
  - `GET /api/v1/scoring/rescores/latest` (`review:act` or `scoring:manage`) returns `{data: {id, cause, total, done, started_at, finished_at} | null}` (the latest run started in the last 24 h).
  - Counting is idempotent per job message: increment through a `processed_event`-style key or a guarded update, so a retried message doesn't double count (Review Focus 5).

- [ ] **Step 1: Write the failing tests.**
  - 450 accounts gives a run with total 450. After all jobs, done is 450 and `finished_at` is set.
  - A retried accounts message leaves done at 450.
  - The route returns the shape. A seller without either permission gets 403.
  - UI: while running, "Rescoring 450 accounts" and "120 of 450 rescored" show. When finished, the banner returns to the last-rescore summary.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Run the migration, then generate it with `drizzle/scoring.config.ts` and add RLS.
- [ ] **Step 4:** Run `npx vitest run tests/integration/scoring tests/integration/v1/scoring.test.ts` and `npm --prefix web-ui test -- queue`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): show how far a rescore has got`.

### Task 8: Estimated value on All accounts

**Files:**
- Modify: `src/modules/scoring/services/read.ts` (`revenuePotentials(ctx, accountIds): Promise<Map<string, {cents: number, band: 'low'|'medium'|'high'}>>`), `src/modules/scoring/index.ts`, `src/modules/routing/services/pipeline.ts` (fallback `value: {amountCents, currency: 'USD', kind: 'estimated', dealName: null}`; CSV value kind `estimated`)
- Modify: `web-ui/src/features/accounts/api.ts` (kind union), `web-ui/src/features/accounts/AllAccountsScreen.tsx` (sub-label "Estimated")
- Test: `tests/integration/v1/accounts.test.ts`, `web-ui/src/features/accounts/all-accounts.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - An account with no deal and a best offer with deal size shows `value.kind 'estimated'` and the scoring `revenue_potential_cents`.
  - An account with an open deal still shows `open_deal`.
  - The CSV row has `estimated`.
  - UI: the cell shows the amount with "Estimated".
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** Run the test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): All accounts shows an estimated value when there is no deal`.

### Task 9: Specs, end-to-end, full suites

**Files:**
- Modify docs:
  - `docs/spec/accounts/facts-provenance-and-conflicts.md`: Rulings 1–10 as rules, marked "(Claude's call, 2026-11-02)".
  - `docs/spec/ai-tasks/task-catalog.md`: the `conflict_explanation` row. It never names a winner and has no rules fallback.
  - `docs/spec/web-ui/api-gaps.md`: conflict rows READY; `:672` revenue tile READY; `:624` estimated READY; rescore progress READY.
  - `docs/spec/web-ui/screens.md`: §4a conflict copy; §8 "Estimated"; §21f progress copy.
  - `docs/spec/sources-and-intake/warm-intros.md`: a note that the R2 items are planned after R2a.
- Create: `tests/e2e/conflicts.spec.ts`

- [ ] **Step 1:** Write the e2e test.
  - The leader sends two arrivals for one account through the API, from two sources, with contract values $20.9M and $18.4M.
  - The queue row shows "1 conflict". The account page shows "1 conflict to resolve".
  - `Keep this one` on $18.4M shows the toast. After a reload, "All facts agree" shows and the queue row has no chip.
- [ ] **Step 2:** Run `npm run e2e -- conflicts`. Expected: PASS.
- [ ] **Step 3:** Update the docs above.
- [ ] **Step 4:** Run the full suites: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:int`, `npm --prefix web-ui test`, `npm run e2e`. Expected: all pass.
- [ ] **Step 5:** Commit `docs(spec): R2a conflicts, rescore progress and estimated value` and `test(e2e): settle a conflict between two sources`.
