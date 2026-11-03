# R2 warm intros: confirm, introducer rules, rescore on points change

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reviewer or the named introducer can confirm an agent-declared warm intro so that it counts in full. Owners and operators can set relationship points and per-introducer rules on a Settings tab. Any points change reprices the stored intros and rescores the accounts they touch.

**Architecture:** Intake stays the owner of warm-intro points. Confirming, saving settings, and repricing all happen in intake services. Each reprice stamps the changed `warm_intro` rows with a change id and publishes one event. Scoring consumes that event and `intake.warm_intro.confirmed`, and rescores through `startRescore`, so the R2a progress banner shows the run. The HTTP layer adds one settings PUT, a confirm action, and live intro fields on `/score`. The web UI gets the account-page line with `Confirm` and a new Settings tab.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest, React 19 + TanStack Query, msw, Playwright.

**Spec:** docs/spec/sources-and-intake/warm-intros.md (SRC-E5-S1-AC2, SRC-E5-S2-AC1), docs/spec/scoring-and-matching/priority-warm-intros-and-trust.md (SCO-E2-S2-AC2), docs/spec/architecture/event-catalog.md, docs/spec/web-ui/screens.md (§4a Before you approve, new §21i), docs/spec/web-ui/api-gaps.md. Code map: docs/plans/2026-11-02-r2-warm-intros.map.md (file:line references; read the section for your task).

## Rulings (Claude's calls, 2026-11-02; Task 6 writes them into the specs)

1. **Who edits.** The Settings tab and its API use `scoring:manage` (owners and operators by default), because warm-intro points are a scoring input like the weights. It is no longer platform-admin-only.
2. **Repricing.** When a relationship default or rule changes, the intros already recorded are repriced: `points` is recomputed with the current rule or default, and `effective_points` is halved unless confirmed. This replaces R1's "intros keep the points they were given", because SRC-E5-S2-AC1 requires affected accounts to rescore.
3. **Dedicated event.** A points change publishes `intake.warm_intro.repriced` v1 `{changeId}`, not `intake.source.trust_changed`. Introducers with only an email have no person source, and `accountIdsForSource` matches arrival senders, not introducers. SCO-E2-S2-AC2 allows "a dedicated SRC event". The `warm_intro_points` cause stays in the trust_changed enum but is never published.
4. **Affected accounts.** Every `warm_intro` row whose `points` or `effective_points` changed gets `repriced_change_id = changeId` (id prefix `wic_`). Scoring rescores the distinct `account_id`s with that change id. A later change overwrites the stamp, and that change starts its own rescore.
5. **Confirm.** `POST /api/v1/warm-intros/{id}:confirm` is people only. It is allowed for `review:act` or for the user whose id is the intro's `introducer_user_id`. The account must be visible to the caller (otherwise 404). Confirming sets `confirmed = true`, `effective_points = points`, `confirmed_by`, `confirmed_at`, writes audit `intake.warm_intro.confirm`, and publishes `intake.warm_intro.confirmed`. Scoring rescores that one account with cause `warm_intro`. Confirming an intro that is already confirmed returns it unchanged, with no event and no audit row.
6. **One save.** Settings save is one `PUT /api/v1/settings/warm-intros` carrying the whole config `{relationships:[{key, points}], rules:[{id?, introducer_user_id?, introducer_email?, introducer_name?, relationship_key, points}]}`. Rules in the body replace the stored rules: missing ids are deleted, and rules without an id are created. This mirrors Pipeline stages. The `PUT /settings/warm-intros/{key}` route is removed.
7. **Rules for anyone.** A rule names a workspace member (`introducer_user_id`) or an outside person (`introducer_email` plus `introducer_name`). The add form offers known introducers (from recorded intros) and members, or "Someone else" with name and email.
8. **The account-page line** comes from the live intake intro, not the stored score explanation, so it changes as soon as someone confirms. The score's own warm line, tiles and queue keep reading `account_score` and catch up when the rescore lands.
9. **Relationship labels are fixed.** The six keys and labels are not editable in R2; only their points are.

## Global Constraints

- **Exact copy, account page (§4a Before you approve).**
  - Confirmed: "Warm intro from {name} ({relationship label, first letter lower case}), +{points}". Example: "Warm intro from Ash Patel (someone on our team knows them), +8".
  - No introducer name: "Warm intro ({label}), +{points}".
  - Unconfirmed: the same text, then " · Unconfirmed, +{effective} of {full}", for example "… · Unconfirmed, +4 of 8", with a `Confirm` button. The button shows only when the API returns `can_confirm: true`.
  - Confirm toast: "Warm intro confirmed. It now counts all {full} points."
  - This line replaces "Warm intro available through {name}."
- **Exact copy, Settings §21i Warm intros.**
  - Intro: "Warm intros add points to an account's priority, from 0 to 20. An intro gets its relationship's points unless the introducer has a rule of their own. An intro an agent or vendor declared counts half until someone confirms it. Only the strongest intro on an account counts."
  - Table "Relationships": columns Relationship, Points, Intros.
  - Table "Introducer rules": lead "Give one person's intros more or fewer points than their relationship." Columns Introducer, Relationship, Points, Intros, plus a remove button with aria-label "Remove rule for {name}". Empty state: "No introducer rules yet. Every intro gets its relationship's points."
  - Add row: `Add a rule`, introducer select placeholder "Pick a person", option "Someone else" (shows Name and Email inputs), relationship select, points input.
  - Errors: "Points must be a whole number from 0 to 20."; "{name} already has a rule for {relationship}."; "Enter the person's name and email."
  - Buttons `Discard`, `Save warm intros`. Toast "Warm intros saved. Rescoring {n} accounts." ("Rescoring 1 account."), or "Warm intros saved." when nothing changed.
  - Footnote: "Saving rescores only the accounts whose intros change. Tiers someone set by hand stay as they are."
- **Errors (API).** 403 confirm: "Only a reviewer or {name}, who made the intro, can confirm it." 400 validation uses the shared `errors[]` shape with paths such as `rules[2].points`.
- **Migrations.** Next intake migration is `0006_warm_intro_r2.sql`, generated with the module's drizzle config. Check `meta/_journal.json` for the real next number. Changes:
  - `warm_intro_rule` gets `id text primary key` (backfill `'wir_' || gen_random_uuid()` style, matching `newId`'s format, or with `newId` in a script; the implementer chooses);
  - `warm_intro` gets `confirmed_at timestamptz null` and `repriced_change_id text null` with an index on `(tenant_id, repriced_change_id)`.
  - RLS is unchanged; existing tables keep their policies.
- **Ids:** rule `wir_`, change `wic_`, registered in `src/platform/ids.ts`.
- **Events** are `defineEvent(type, 1, zod)` in `src/modules/intake/contracts/events.ts`, published through the outbox in the same transaction. New consumers go in `scoringConsumers`, and the worker list in `src/entry/worker.ts` picks them up.
- **Web UI** uses `apiFetch`. The settings query key is `['settings', tenant, 'warm-intros']`. After a confirm, invalidate `['account', tenant, id]` by prefix.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two intros on one account, the weaker one confirmed.** The account's points stay the strongest intro's, and the line shows the strongest intro. Test in Task 1.
2. **A rule and a default for the same relationship.** Editing the default does not reprice intros the rule covers, so their accounts are not stamped and not rescored. Test in Task 1.
3. **Introducer confirming their own intro without `review:act`.** Allowed. A different seller gets 403 with the exact copy, and a caller who can't see the account gets 404. Test in Task 3.
4. **Duplicate rule in one save** (same introducer and relationship twice). 400 naming the person and relationship, and nothing is saved. Test in Task 1 (service) and Task 3 (route).
5. **A merge after repricing.** Intros follow the survivor (the existing merge re-point), and a later reprice rescores the survivor, not the merged-away account. Test in Task 2.

---

### Task 1: Intake services: reprice, confirm, settings, events

**Files:**
- Create: `src/modules/intake/db/migrations/0006_warm_intro_r2.sql` (+ meta snapshot and journal)
- Modify: `src/modules/intake/db/schema.ts`, `src/modules/intake/domain/warm-intro.ts`, `src/modules/intake/services/warm-intros.ts`, `src/modules/intake/services/settings.ts`, `src/modules/intake/contracts/events.ts`, `src/modules/intake/index.ts`, `src/platform/ids.ts`
- Test: `tests/unit/intake/warm-intro.test.ts`, `tests/integration/intake/warm-intro-settings.test.ts` (new), `tests/integration/intake/warm-intro-confirm.test.ts` (new)

**Interfaces:**
- Produces (exported from `@/modules/intake`):
  - `pickRule(rules, {userId, email})` (domain, pure): a user match wins over an email match.
  - `getWarmIntroSettings(ctx): Promise<WarmIntroSettings>`, where `WarmIntroSettings = { relationships: {key, label, points, introCount}[]; rules: {id, introducerUserId, introducerEmail, introducerName, relationshipKey, points, introCount}[]; introducers: {userId: string|null, email: string|null, name: string|null, introCount: number}[] }`. `introducers` lists distinct introducers from recorded intros plus workspace members, with no duplicates; a member who also introduced appears once.
  - `saveWarmIntroSettings(ctx, input): Promise<{settings: WarmIntroSettings; rescoringAccountCount: number}>`. It validates, replaces rules, updates defaults, reprices, audits (`intake.relationship_default.set` per changed default, and `intake.warm_intro_rule.create|update|delete`), and publishes `warmIntroRepriced {changeId}` only when at least one row changed.
  - `repriceWarmIntros(ctx): Promise<{changeId: string; accountIds: string[]}>`, internal to intake. It recomputes every tenant row (the table is small) and stamps the changed ones.
  - `confirmWarmIntro(ctx, warmIntroId, {canReview: boolean}): Promise<WarmIntroView>`. It throws ScoutError not_found, or forbidden with the Global Constraints copy.
  - `accountIdsForWarmIntroChange(ctx, changeId, {afterId?, limit}): Promise<string[]>`, ordered by account id for paging like `accountIdsForSource`.
  - `WarmIntroView` gains `introducerEmail`, `relationshipLabel`, `confirmedAt`.
  - Events `warmIntroConfirmed` (`intake.warm_intro.confirmed` `{warmIntroId, accountId, arrivalId, relationshipKey, points, changeId}`; confirm sets the row's `repriced_change_id` to a fresh `wic_` id) and `warmIntroRepriced` (`intake.warm_intro.repriced` `{changeId}`).
- Removes: `setRelationshipDefault` (replaced by save). The implementer checks every caller first: routes, MCP and tests.

- [ ] **Step 1: Failing unit tests.** `pickRule`: a user rule beats an email rule; no match gives undefined.
- [ ] **Step 2: Failing integration tests.**
  - Save: a default change reprices unconfirmed and confirmed intros (8 → 10: effective 5 and 10).
  - A rule beats a default edit; rule-covered rows are not stamped (Review Focus 2).
  - Deleting a rule falls back to the default.
  - Duplicate rule gives 400 `"{name} already has a rule for {relationship}."` and nothing is saved.
  - Points 21 or 2.5 give 400 at path `relationships[i].points` or `rules[i].points`.
  - Unknown relationship key gives 400.
  - The event is published once, with a change id, only when rows changed, and `rescoringAccountCount` counts distinct accounts.
  - Audit rows are written.
  - Confirm:
    - halves become full, and the event and audit row are written;
    - a second confirm is a no-op;
    - a named introducer with `canReview: false` is allowed;
    - another user is forbidden with the copy;
    - the weaker of two intros confirmed leaves `getWarmIntro` returning the stronger (Review Focus 1).
- [ ] **Step 3: Implement** the migration, schema and services above. Reuse `warmIntroFullPoints`/`warmIntroPoints`. Lock the tenant's settings rows (`FOR UPDATE` on `relationship_default`) during save, so two saves serialise. Confirm locks the intro row. Update the stale doc comments in settings.ts.
- [ ] **Step 4: Run** `npx vitest run tests/unit/intake tests/integration/intake`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(intake): warm intro confirm, introducer rules and repricing`.

### Task 2: Scoring rescoring on confirm and reprice

**Files:**
- Modify: `src/modules/scoring/consumers.ts`, `src/modules/scoring/contracts/jobs.ts` (RescoreFilter), `src/modules/scoring/services/rescore.ts` (`pageIds`), `src/entry/worker.ts` if it lists consumers by name
- Test: `tests/integration/scoring/rescore.test.ts`

**Interfaces:**
- Consumes: Task 1's `warmIntroConfirmed`, `warmIntroRepriced`, `accountIdsForWarmIntroChange`.
- Produces:
  - `RescoreFilter` gains `warmIntroChangeId?: string`, used alone like the other filters.
  - Consumer `scoring.rescore_warm_intro_confirmed` → `startRescore(ctx, {warmIntroChangeId: e.data.changeId}, 'warm_intro')`. Confirm stamps its row with a fresh change id too (Task 1), so both events use one path.
  - Consumer `scoring.rescore_warm_intro_repriced` → `startRescore(ctx, {warmIntroChangeId}, 'warm_intro')`.
- [ ] **Step 1: Failing tests.**
  - After confirm plus consumers, the account's `account_score.warm_points` goes from 4 to 8, and a rescore run finishes 1/1.
  - After a default change, only stamped accounts are rescored: run total = `rescoringAccountCount`.
  - Merge (Review Focus 5): reprice after merging A into B rescores B, and A is not listed.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/scoring`. **Step 4: Commit** `feat(scoring): rescore when warm intros are confirmed or repriced`.

### Task 3: HTTP routes

**Files:**
- Modify: `src/http/routes/v1/settings/warm-intros/route.ts`, `src/http/routes/v1/accounts/[id]/score/route.ts` (or wherever `/score` builds `warm_intro`), `src/http/routes.ts`
- Create: `src/http/routes/v1/warm-intros/[id]/route.ts` (`:confirm`)
- Delete: `src/http/routes/v1/settings/warm-intros/[key]/route.ts`
- Test: `tests/integration/v1/warm-intro-settings.test.ts` (new; model on `stage-settings.test.ts`), `tests/integration/v1/warm-intro-confirm.test.ts` (new), plus updates to `account-page.test.ts`, `people-only.test.ts` and `route-access.test.ts` as they enumerate routes

**Interfaces:**
- `GET /api/v1/settings/warm-intros` (`scoring:manage`) returns `{relationships, rules, introducers}` in snake case.
- `PUT` (`scoring:manage`, people only) takes Ruling 6's body and returns `{relationships, rules, introducers, rescoring_account_count}`.
- `POST /api/v1/warm-intros/{id}:confirm` (people only; `accounts:read` at the route; `canReview = can(principal, 'review:act')`; account visibility checked as other account routes do) returns `{warm_intro}`.
- `/score`'s `warm_intro` becomes `{warm_intro_id, introducer_name, relationship_key, relationship_label, points, full_points, confirmed, can_confirm}` from live `getWarmIntro`, or null. `points` is the effective points. `can_confirm` = not confirmed, and (review:act, or caller is the introducer) and a person principal.
- [ ] **Step 1: Failing tests.**
  - Operator GET/PUT is 200.
  - Seller is 403.
  - Agent key PUT is 403 people only.
  - Validation 400 paths and copy.
  - Confirm:
    - reviewer is 200;
    - the introducer without review:act is 200;
    - another seller is 403 with the exact copy;
    - a hidden account is 404;
    - an unknown id is 404;
    - an agent key gets the people-only 403.
  - `/score` shows `can_confirm` true for a reviewer and false for another seller.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/v1`. **Step 4: Commit** `feat(http): warm intro settings and confirm routes`.

### Task 4: Web UI account page line and Confirm

**Files:**
- Modify: `web-ui/src/features/account/ReviewView.tsx` (`BeforeYouApprove`), `web-ui/src/features/account/api.ts` (`AccountScore.warm_intro`, `confirmWarmIntro` mutation), `web-ui/src/features/account/testing.ts`
- Test: `web-ui/src/features/account/warm-intro.test.tsx` (new); update `account-page.test.tsx`

- [ ] **Step 1: Failing tests.**
  - The confirmed line shows the exact copy.
  - The no-name variant shows the exact copy.
  - Unconfirmed with `can_confirm` shows " · Unconfirmed, +4 of 8" and `Confirm`. Clicking posts to `/api/v1/warm-intros/{id}:confirm`, shows the toast, and refetches the score.
  - Unconfirmed without `can_confirm` shows no button.
  - A failed confirm shows the API message.
  - `account-page.test.tsx` assertions are updated from "Warm intro available through Ash Patel."
- [ ] **Step 2: Implement.** The button follows the existing `textButton` pattern and is disabled while the request is pending. **Step 3: Run** `cd web-ui && npx vitest run src/features/account`. **Step 4: Commit** `feat(web-ui): warm intro line with Confirm on the account page`.

### Task 5: Web UI Settings, Warm intros tab

**Files:**
- Create: `web-ui/src/features/settings/warm-intros/{api.ts, draft.ts, WarmIntros.tsx, WarmIntros.module.css, warm-intros.test.tsx}`
- Modify: `web-ui/src/app/nav.ts` (`SETTINGS_TABS`: `{ tab: 'warm-intros', label: 'Warm intros', section: '21i', tag: 'R2', rule: { all: ['scoring:manage'] } }` placed after Scoring weights), `web-ui/src/features/settings/SettingsScreen.tsx` (`SCREENS`)

- [ ] **Step 1: Failing tests.** Copy the stages tests' setup.
  - The tab renders both tables with the exact copy.
  - A user without `scoring:manage` doesn't see the tab.
  - Editing points enables `Discard` and `Save warm intros`.
  - Points outside 0..20 show the error and block saving.
  - Adding a rule for a member and for "Someone else" (name and email required) works.
  - A rule can be removed.
  - Save sends the whole body and shows "Warm intros saved. Rescoring 3 accounts.", or "Warm intros saved." when the count is 0.
  - A duplicate-rule 400 shows the API message.
  - `Discard` restores the loaded values.
- [ ] **Step 2: Implement** following `features/settings/stages` (draft helpers, Discard/Save). **Step 3: Run** `cd web-ui && npx vitest run src/features/settings`. **Step 4: Commit** `feat(web-ui): Settings, Warm intros tab`.

### Task 6: Specs, end-to-end, full suites

**Files:**
- Modify: docs/spec/sources-and-intake/warm-intros.md (release note: R2 shipped; Rulings 1-9), docs/spec/sources-and-intake/source-registry-and-trust.md and docs/spec/scoring-and-matching/priority-warm-intros-and-trust.md (the dedicated event), docs/spec/architecture/event-catalog.md (add `intake.warm_intro.repriced`; confirmed's consumer), docs/spec/web-ui/api-gaps.md (rows for the three routes and `/score` fields), docs/spec/web-ui/screens.md (§21 tab list, §4a line; §21i is already written by this plan's commit)
- Create: `tests/e2e/warm-intros.spec.ts`

- [ ] **Step 1: E2E.** Declare an agent intro through the arrival API. The account page shows "Unconfirmed, +{h} of {f}". Click `Confirm`, and the line loses "Unconfirmed". Open Settings, Warm intros, change that relationship's points, and save; the toast names 1 account.
- [ ] **Step 2: Full suites.** `npm run lint`, `npm run typecheck`, unit, integration, `cd web-ui && npm test`, e2e. All must be green.
- [ ] **Step 3: Commit** `docs(spec): R2 warm intros` and `test(e2e): warm intro confirm and settings`.
