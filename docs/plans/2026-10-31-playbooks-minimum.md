# Playbooks (minimum) and the account page review view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scored account has a brief: Scout's recommendation and four sections (Overview,
Approach, Value angle, Risks), written by Claude for accounts worth the spend and assembled from rules
for the rest or when Claude is unavailable or capped. A person can edit a section, and the brief is
redrafted when facts, signals, people, the score or the lead offer change. The HubSpot push uses the
brief through CRM's `HandoffPackageProvider`: the note content, the opener as the first-touch task and
the follow-up sequence. Then the account page: header, stage tracker, the §4a review view and the
§4b assigned view (the parts current APIs support), reached from the queue peek, My accounts and All
accounts. That is the R1 "Playbooks (minimum)" row of the release plan, and the account page that
Decision 7 held back until it existed.

**Architecture:** One new module, Playbooks (`playbooks` schema), at the top of the module order. It
reads Accounts, Offers, Scoring, Routing and CRM through their `index.ts` and runs one AI task through
`runTask`. It implements CRM's `HandoffPackageProvider` (registered in `src/entry/compose.ts`). The
brief is drafted by a job with coalesced triggers. The new endpoints go under `/api/v1` through
`v1Route`, with the small read gaps the page needs in Scoring, Accounts and CRM. The page is a new
`web-ui/src/features/account` built on the existing primitives and the review dialogs.

**Tech Stack:** As the review flow plan. No new dependencies.

**Spec:** `docs/spec/playbooks/index.md`, `account-brief.md` (PLB-E3-S1, S2, S4; S3 is R2),
`account-page.md` (PLB-E4-S1; S2 and S3 are R2), `account-plans.md` (nothing: plans are R2; the package's
`planSteps` stays empty), `docs/spec/crm-sync/handoff-push.md` (note content), `docs/spec/ai-tasks/*`
(runner, rules fallback, catalog `account_brief`, prompt versions), `docs/spec/web-ui/screens.md` §4,
§4a, §4b, `docs/spec/web-ui/api-gaps.md` rows for §4 and §4a in accounts, routing, scoring, crm,
playbooks, and Decision 7, `docs/spec/architecture/{module-boundaries,data-conventions,events-and-async}.md`.
v1 reference: `reference/v1/src/ai/accountBrief.ts`, `prompts/accountBrief.v1.ts`, `outreachSequence.ts`.

## Scope

In: the Playbooks module (brief, sections and their history, drafting job, consumers, events), the
`account_brief` task with rules and mock, the handoff package, three playbooks endpoints, the page's
read gaps (score tiles, buying role labels, fact source names, CRM check card, HubSpot activity, handoff
`crm_url` and replies), the account page (§4 header, notices, stage tracker, §4a, §4b), links into it,
e2e, a seed backfill.

Out, by owner:
- **R2:** playbook templates, account plans and steps, the playbook section and preview, the playbook
  picker, the conflicts box and `Keep this one`, `Enrich`, committee gaps and `Find`, brief practice
  templates and custom fields, the `brief_sections`, `outreach_sequence` and `committee_gaps` tasks,
  per-person engagement, Meetings held and Buyers engaged tiles, "Waiting on enrichment", Revenue
  potential values, section History UI, Print brief, `get_account_brief` MCP tool.
- **R3:** source trust values and "{won} won of {sent} sent", outcomes, retros.
- **Later:** `npm run ai:check` against the live model (this plan adds the recorded-input checks in
  mock and rules only).

## Design

| Aggregate | Owner | Invariants it guards | Consistency boundary |
|---|---|---|---|
| Brief (brief row, its sections) | Playbooks | One brief per account; one row per (account, key); a section a person wrote is never overwritten by a draft unless asked; every change keeps the old version | `brief` row and section `version` (optimistic), advisory lock `plb:brief:<tenant>:<account>` held by the draft job |
| Section history | Playbooks | Append only, one row per (account, key, version) | Primary key |

Layers as in the other modules: `domain/` pure (rules brief, recommendation, buyer-safe check, package
builder, follow-up sequence, labels), `services/` transaction scripts, `tasks/` the AI task and its
prompt, `contracts/` (events, jobs, types), `db/`, `index.ts` facade.

Dependency direction: Playbooks calls Accounts, Offers, Scoring, Routing, CRM, AI and Tenancy
through `index.ts`. Nothing imports Playbooks except the composition root, the worker, the registry
and the HTTP routes. CRM reaches it only through its own port.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **R1 brief content.** `account_brief` (R1) writes Scout's recommendation (headline and detail),
   the sections `overview`, `approach`, `value_angle`, `risks` and `why_now`, the opener (subject and
   body) and who to approach first. The page shows the four sections in that order with the titles
   `Overview`, `Approach`, `Value angle`, `Risks`. `why_now` is stored as a section and used in the CRM
   note and the `why_now` property; the page's Why now is the signal list. The other default
   template sections (`what_they_do`, `potential_size`, `decision_makers`) and `brief_sections` stay R2.
   (Open question 1.)
2. **When it drafts, and with what.**
   - A brief is drafted for every account on its first `scoring.account.scored`. Claude is allowed when
     the tier is `act_now` or `good_fit`; for other tiers the run is rules only (new `RunOpts.rulesOnly`).
   - A redraft is requested by `scoring.account.scored` (any later score: the event fires only when
     priority, tier or best offer changed), `accounts.signal.recorded`, `accounts.fact.recorded` with
     `becameCurrent`, `accounts.person.added`, `accounts.person.updated`, and `routing.review.changed`
     when `leadOfferOverrideId` differs from the brief's `offer_id`. Same tier rule.
   - Automatic redrafts stop while the account has an open or accepted assignment (`brief.frozen_at`,
     set on `routing.assignment.created`, cleared on `.declined` and `.withdrawn`, which also request a
     redraft). The brief the AE and HubSpot got stays put. `POST :draft-brief` works at any time.
   - A manual draft allows Claude at any tier and runs with `fresh: true`.
3. **Coalescing.** `requestDraft(ctx, accountId)` upserts the brief row, increments
   `requested_seq`, and enqueues `playbooks.brief.draft` only when `draft_state` is not `drafting`
   (then sets it). The job reads `requested_seq` as S, drafts, writes, sets `drafted_seq = S`; if
   `requested_seq > S` it enqueues itself again, else sets `draft_state = 'ready'`. Ten signals in one
   arrival make at most two runs.
4. **Writes never beat a person.** The job reads each section's `version`, runs the task with no row
   lock, and writes with `WHERE version = <read>`. It skips sections with `origin = 'human'` unless the
   request named them with `include_edited`. A section skipped for a version change is left to the
   next request. Every write first copies the old row to `brief_section_history`.
5. **Failure falls back to rules.** When the live run ends in `ai_failed` or `invalid_output` (502),
   the job runs again with `rulesOnly`, stores that, and keeps `last_error` (300 characters). Rules
   never fail, so a scored account always has a brief within the 5 seconds of PLB-E3-S1-AC1.
6. **Citations and buyer-safe text.**
   - The output schema refines each section: text with a digit and no citations fails with
     `Cite the fact or signal ids for every number.`, so the runner asks once more (PLB-E3 "redrafted
     once").
   - After the run the service drops citation ids that were not in the input.
   - `isBuyerSafe(text, signals)` (pure) rejects an opener or follow-up that quotes a research-kind
     signal, a `risk` type signal (lawsuit, breach) or the words "researching", "lawsuit", "breach". A
     rejected opener is replaced by the rules opener and labelled `Assembled from rules`.
7. **Labels.** The API gives each piece `written_by` (`claude`, `sample`, `rules`, `person`) and
   `label`: `Written by Claude`, `Sample output` (mock mode, ai-tasks `AI_LABEL`), `Assembled from
   rules`, `Edited by {name}`. `{name}` is the member's name, or the API key's name for an agent
   (PLB-E3-S2-AC2). The page prints `label`.
8. **Written for another offer.** A section whose `offer_id` is not the brief's current lead offer (an
   edited one, or any while frozen) returns `written_for_offer_name`; the page shows
   `Written for {offer}` and `Redraft` (account-brief.md rule).
9. **The package reads, never writes.** `package(ctx, accountId, assignmentId)` reads the stored
   brief, score, offer, case studies, signals and matches. It never calls Claude and never writes
   (CRM calls it in the push and in every batch refresh). With no stored brief it builds the rules
   brief in memory. It returns null only when the account is missing.
10. **Follow-ups are rules in R1.** The sequence is built by a pure port of v1's
    `mockOutreachSequence` for the tenant's CRM `follow_up_days` (crm `getCrmSettings`). Purposes by
    position: the first is `New angle`, the last `Close the loop`, the others `Proof`; one day only is
    `Close the loop`. Each body ends with `(Assembled from rules)`. Day 0 is the first touch with the
    stored opener. The `outreach_sequence` task is R2. (Open question 4.)
11. **Section edits are a PUT** of the whole body: `PUT /api/v1/accounts/{id}/brief/sections/{key}`.
    The spec table's `PATCH` is corrected in Task 5. Redraft is the account action
    `POST /api/v1/accounts/{id}:draft-brief`, like `:assign` and `:push`. Hono matches
    `/accounts/:id`, so a `brief:regenerate` segment would need a special route.
12. **Two read gaps are actions too:** the CRM check refresh is `POST /api/v1/accounts/{id}:check-crm`,
    not `crm-check:refresh`.

## Open questions (each with the answer this plan builds; confirm before Task 2)

Confirmed by the user on 2026-10-31: Claude drafts for Act now and Good fit only (rules brief for every other scored account, Claude on a manual redraft); briefs use Sonnet 5.5 with a 10-cent cap per run; automatic redrafts stop once an account is assigned; one R1 task writes the recommendation, the four sections, why now, the opener and who to approach first (follow-ups rules-built until R2). The other answers below stand as the coordinator's calls.

1. **What does Claude write in R1?** account-brief.md says `account_brief` writes why now, the
   angle, the opener and who first, and the other core sections come from rules. Screens.md §4a tags
   each of Overview, Approach, Value angle and Risks with "Written by Claude" or "Assembled from rules".
   Built: Ruling 1, one task covering the recommendation and the four sections. Update
   account-brief.md "Drafting" and the catalog row for `account_brief`.
2. **Scout's recommendation** appears only in screens.md and api-gaps (Decision 7), not in the PLB
   spec. Built: part of the brief, written by Claude with rules, returned by `GET …/brief`. There is
   no separate endpoint.
3. **When to draft.** PLB index says on the first act now or good fit. The screens.md Building copy
   says once Scout has two signals. Decision 7 says the page opens filled. Built: Ruling 2, rules for
   every scored account and Claude for act now and good fit. The Building copy shows only before the
   first draft.
4. **Follow-up sequence.** PLB-E3-S4-AC2 puts it in the R1 package, but `outreach_sequence` is R2.
   Built: Ruling 10, rules only in R1.
5. **Edit verb and redraft path:** Ruling 11 (PUT; `:draft-brief`). The spec table is corrected in
   Task 5.
6. **"All facts agree" badge.** In R1, with conflicts out, it would claim agreement the API never
   checked. Built: no badge in R1.
7. **Notes "Scout uses these in the brief".** Accounts publishes no note event. Built: notes and
   insights are read at each draft, and adding a note does not trigger one. A note event can come later.
8. **Mock mode label.** `Sample output` (ai-tasks `AI_LABEL`) is not in screens.md's tag list.
   Built: the page prints the API's label.
9. **Operators** hold `playbooks:manage` but not `playbooks:write`, so they cannot edit a brief.
   Built: as the permission table says.

## Global Constraints

- Everything in the earlier plans' Global Constraints holds:
  - every `playbooks` table has `tenant_id` and forced RLS
  - module imports only through `index.ts` or `contracts/*` (the boundaries lint passes)
  - snake_case JSON, problem+json errors, copy exactly as written here and in screens.md, no em dashes
  - every POST and PUT through `v1Route` with bounded bodies; POSTs idempotent
  - domain functions take `now`
  - an integration test per endpoint: success, permission refusal, validation error, cross-tenant
    or hidden account 404
- New schema `playbooks` (Task 1):
  - bootstrap grants and default privileges
  - `MODULE_ORDER` (`… crm, intake, scoring, routing, playbooks`) and the migrate test's order
  - `drizzle/playbooks.config.ts`, Dockerfile `COPY`, RLS catalog test
  - `src/entry/registry.ts`, `src/entry/worker.ts`, `src/entry/compose.ts`
  - the NATS subject list already has `playbooks`
- No new id prefixes: the brief and its sections are keyed by account and key, history by version.
- Limits:
  - section body 4,000 characters
  - recommendation headline 120, detail 600
  - opener subject 90, body 700
  - task input caps: 20 signals (dated, newest first), 40 current facts, 15 people (no contact
    details), 10 notes plus the leader's insights, 3 case studies
- No number computed in the browser (C8); names, stages and labels from the API (C6, C7); polling
  per C14. Never touch `.env` or the dev `scout` database. Commit per task, `git add` specific paths,
  conventional messages with the Co-Authored-By line.

## Review Focus

1. **A person edits Overview while a draft job is running for the same account.** Expected: the
   person's text stays, labelled `Edited by {name}`; the draft writes only the other sections; history
   has the replaced versions. Test in Task 3.
2. **Claude is capped, has no key, or returns invalid output twice.** Expected: the brief is assembled
   from rules, every piece says `Assembled from rules`, the `ai_run` rows say `refused_by_cap` or
   `invalid_output` then `ok` in `rules` mode, and the page is never empty. Tests in Tasks 2 and 3.
3. **Twelve signals arrive in one arrival, then the account is assigned.** Expected: at most two draft
   runs; no automatic redraft after `routing.assignment.created`; the HubSpot note has the brief that
   was showing when the leader assigned. Tests in Tasks 3 and 4.
4. **The opener never quotes research intent, a lawsuit or a breach.** Neither do the follow-ups.
   Internal note sections may. Tests in Tasks 2 and 4.
5. **A seller outside the account's data limit, or another tenant, asks for the brief or edits it.**
   Expected: 404, never 403. Test in Task 5.

## File Structure

```
src/modules/playbooks/
  index.ts contracts/{events,jobs,types}.ts db/schema.ts db/migrations/
  domain/{labels,rules-brief,recommendation,buyer-safe,follow-ups,package}.ts
  tasks/account-brief.ts tasks/prompts/account_brief.v1.0.ts
  services/{inputs,brief,draft,edit,read,package,merge,backfill}.ts
  consumers.ts jobs.ts
src/modules/ai-tasks/runner.ts         RunOpts.rulesOnly
src/modules/scoring/services/explain.ts  score tiles, warm intro
src/modules/accounts/services/read.ts    role labels; buying role list
src/modules/crm/services/{checks,read,activity}.ts  check card with top open deal, activity feed, crm_url, replies
src/http/routes/v1/accounts/[id]/{brief,brief/sections/[key],crm-check,activity}/route.ts
src/http/routes/v1/buying-roles/route.ts
web-ui/src/features/account/           AccountPage, header, tracker, review view, assigned view, brief, rail
tests/unit/playbooks/  tests/integration/playbooks/  tests/integration/v1/playbooks.test.ts  tests/e2e/account.spec.ts
```

---

### Task 1: Playbooks module schema, contracts and wiring

**Files:**
- Create: `src/modules/playbooks/{index.ts,contracts/events.ts,contracts/jobs.ts,contracts/types.ts,db/schema.ts,db/migrations/*,consumers.ts,jobs.ts}`, `drizzle/playbooks.config.ts`
- Modify: `src/platform/db/bootstrap.sql`, `src/platform/db/migrate.ts`, `tests/integration/platform/migrate.test.ts`, `infra/docker/Dockerfile`, `src/entry/{registry,worker}.ts`, `tests/integration/platform/rls-catalog.test.ts`
- Test: `tests/integration/playbooks/schema.test.ts`

**Interfaces:**
- `playbooks.brief`: `tenant_id`, `account_id` (pk with tenant), `offer_id` (the lead offer it was
  written for), `mode` (`live`, `mock`, `rules`), `ai_run_id`, `recommendation_headline`,
  `recommendation_detail`, `recommendation_origin` (`ai`, `rules`), `opener_subject`, `opener_body`,
  `opener_origin`, `who_first_person_id`, `who_first_title`, `who_first_reason`, `draft_state`
  (`not_drafted`, `drafting`, `ready`), `requested_seq`, `drafted_seq`, `frozen_at`, `last_error`,
  `drafted_at`, `created_at`, `updated_at`.
- `playbooks.brief_section`: `tenant_id`, `account_id`, `key` (pk with both), `body`, `citations`
  (text[] of `fct_`, `sig_`, `per_` ids), `origin` (`ai`, `rules`, `human`), `mode` (`live`, `mock`,
  `rules`, null for human), `ai_run_id`, `offer_id`, `edited_by` (user id or `key:<id>`),
  `edited_by_name`, `edited_at`, `version` (int, from 1), `updated_at`.
- `playbooks.brief_section_history`: the section's columns plus `recorded_at`; pk
  (`tenant_id`, `account_id`, `key`, `version`).
- `contracts/types.ts`: `BRIEF_KEYS = ['overview', 'approach', 'value_angle', 'risks', 'why_now']`,
  `PAGE_SECTIONS` (the first four with titles `Overview`, `Approach`, `Value angle`, `Risks`),
  `SECTION_MAX = 4000`.
- `contracts/events.ts`: `playbooks.brief.updated { accountId, sectionKeys: string[], origin: 'ai' | 'rules' | 'human', mode }`.
- `contracts/jobs.ts`: `playbooks.brief.draft { accountId, manual: boolean, includeEdited: string[] }`,
  maxDeliver 3, timeoutMs 90,000.

- [ ] **Step 1: Write failing tests.**
  - Every `playbooks` table is under forced RLS, and a row written as tenant A is not read as tenant B.
  - Migrate order ends `routing, playbooks`.
  - The job and event schemas parse a valid sample and reject a missing `accountId`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (`drizzle-kit generate` with the new config; policies as the crm migration).
- [ ] **Step 4:** Run, plus `platform/rls`, `platform/migrate`, `unit/boundaries`, `unit/entry-registry`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(playbooks): schema, contracts and wiring`.

### Task 2: The `account_brief` task, its rules and mock, and `rulesOnly`

**Files:**
- Create: `src/modules/playbooks/domain/{labels,rules-brief,recommendation,buyer-safe}.ts`, `src/modules/playbooks/tasks/account-brief.ts`, `src/modules/playbooks/tasks/prompts/account_brief.v1.0.ts`
- Modify: `src/modules/ai-tasks/runner.ts` (`RunOpts.rulesOnly`)
- Test: `tests/unit/playbooks/{rules-brief,recommendation,buyer-safe,account-brief-checks}.test.ts`, `tests/integration/ai/runner.test.ts`

**Interfaces:**
- `BriefInput` (Zod, the task's `input`):
  - `account { name, industry, employees, location, description, technologies[] }`
  - `offer { id, name, promise, priceMinCents, priceMaxCents, salesCycleDays, targetTitles[], targetBuyingRoles[], proofPoints[] } | null`
  - `practiceName`, `caseStudies [{ id, title, clientName, result }]`
  - `signals [{ id, type, kind, title, occurredAt, sourceName }]`, `facts [{ id, key, value }]`
  - `people [{ id, name, title, roleKeys[], roleLabels[], isPrimary }]`
  - `score { tier, tierLabel, priority, fit, intent, fitParts [{ label, points, max, note }], wouldRaise[] }`
  - `crm { exists, ownerName, lifecycle, openDeals } | null`, `warmIntro { introducerName } | null`
  - `notes [{ text, at }]`, `insights`
- `BriefOutput` (Zod, the task's `output`):
  - `recommendation { headline (≤120), detail (≤600) }`
  - `sections { overview, approach, valueAngle, risks, whyNow }`, each `{ text (≤4000), citations: string[] }`, with the uncited-number refine (Ruling 6)
  - `opener { subject (≤90), body (≤700) }`
  - `whoFirst { personId: string | null, title, reason }`
- `accountBriefTask = defineTask({ name: 'account_brief', promptVersion: 'v1.0', model: 'claude-sonnet-5-5', maxTokens: 3000, maxCostCents: 10, rules: rulesBrief, mock: rulesBrief-based sample, … })`.
  - The worst case at the input caps is about 6.4 cents (pricing.ts, Sonnet 5.5), so 10 is the per-run cap.
  - A tenant can lower it with `ai_setting.max_cost_cents_per_run`.
  - The gateway's usage cap (`blocked_by_cap`) and a missing key fall back to rules (runner).
  - Every run records `ai_run` with tokens and `cost_cents`, and `ai.run.completed` (runner).
- System prompt: v1's `accountBrief.v1` rules, plus the section instructions:
  - overview 3 to 5 sentences
  - approach: the motion and the first moves
  - value angle: what the offer does for them, with the closest case study
  - risks: timing, incumbents, process
  - why now: dated signals
  - every number cites its id, plain words, no em dashes, never quote research intent, lawsuits or
    breaches in the opener
- `rulesBrief(input, now): BriefOutput` (pure). Recommendation by case, first match wins:
  - CRM `open_deal` or `customer`: `Check with {owner} before assigning.` / `{owner} owns {an open deal | a customer record} on this company in HubSpot.` plus the why-now line.
  - `act_now` or `good_fit`: `Approve and assign to someone who covers {practice}.` / why-now line + `Warm intro available through {name}.` when there is one.
  - `watch`: `Keep it in review until a stronger signal arrives.` / `Fit is {fit} and buying intent is {intent}. {first wouldRaise}`
  - `not_fit`: `Send it back or decline it.` / the lowest fit part's note.
  
  Sections:
  - Overview: name, industry, location, staff (cited), description's first sentence, `Scout matched it to {offer} with a priority of {priority} ({tier label}).`
  - Approach: `Start with {who}, {title}.`, plus `Ask {introducer} for the intro.` when there is a warm intro, plus `Lead with: {offer promise}`.
  - Value angle: the promise and the first case study `{client}: {result}`, or the first proof point.
  - Risks: one line per rule hit:
    - an open deal: `{owner} owns an open deal in HubSpot.`
    - no person: `No buyer contact yet.`
    - no dated signal in 90 days: `No dated signal in the last 90 days, so timing is a guess.`
    - fit below 50: `Fit is below 50.`
    - none of these: `Nothing in the data Scout has. Add what you know.`
  - Why now: the two newest dated signals, `{title} ({Mon D, YYYY}, {source})`, or `No dated signals yet.`
  
  Opener: v1's public-hook opener. Who first: the primary person, else the first person holding one of
  the offer's `targetBuyingRoles`, else the offer's first target title with `personId` null.
- `isBuyerSafe(text, signals): boolean` (Ruling 6). `labelFor({ origin, mode, editedByName })` (Ruling 7).
- `RunOpts.rulesOnly?: boolean`: skips mock and live, runs rules (or the no-key error for a task without rules), records `mode: 'rules'`.

- [ ] **Step 1: Write failing tests.**
  - Rules: each recommendation case gives its exact headline; every number in rules text is cited; no
    signals gives `No dated signals yet.`; the risks fallback line; who first prefers primary, then
    the buying role, then the title.
  - Buyer-safe: an opener quoting a research signal's title, `lawsuit` or `breach` is rejected; a
    public leadership hook passes.
  - Checks (recorded inputs in `tests/unit/playbooks/fixtures/briefs/`, 6 accounts: transit agency
    with RFP, no people, intent only, open deal, customer, not a fit): the mock and rules outputs parse,
    every cited id is in the input, the opener is buyer safe, and the lengths are within limits.
  - Output refine: a section with `$250K` and no citations fails with the citation message.
  - Runner: `rulesOnly` records `mode: 'rules'` and makes no gateway call; with `max_cost_cents_per_run`
    1, a live run is `refused_by_cap` and the rules output is returned.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/unit/playbooks` and `tests/integration/ai`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(playbooks): account_brief task with rules fallback and rulesOnly runs`.

### Task 3: Drafting, triggers, edits and the brief read (services)

**Files:**
- Create: `src/modules/playbooks/services/{inputs,brief,draft,edit,read,merge,backfill}.ts`
- Modify: `src/modules/playbooks/{consumers,jobs,index}.ts`, `src/entry/{worker,seed}.ts`
- Test: `tests/integration/playbooks/{draft,triggers,edit,read,merge}.test.ts`

**Interfaces:**
- `buildBriefInput(ctx, accountId): Promise<{ input: BriefInput; offerId: string | null; tier } | null>`:
  - Accounts `getAccount`, `getFacts`, `getSignals`, `listNotes`
  - Routing `getAccountReview` (lead offer, insights)
  - Scoring `explainScore` for the lead offer
  - Offers `getOffer`, `matchCaseStudies`
  - CRM `companyChecks`
  - intake `sourceNames` for signal sources
- `requestDraft(ctx, accountId, { manual?, includeEdited? })`: Rulings 2 and 3.
- Job `playbooks.brief.draft`:
  - takes the advisory lock, builds the input
  - `runTask(accountBriefTask, input, { subject: { type: 'account', id }, rulesOnly: !claudeAllowed, fresh: manual })`
  - writes per Rulings 4 to 6, publishes `playbooks.brief.updated` with the keys it wrote
- `editSection(ctx, accountId, key, { body, ifVersion? })`: trims; 1 to 4,000 characters; history
  row; `origin: 'human'`, `edited_by`, `edited_by_name`, `version + 1`; publishes
  `playbooks.brief.updated { origin: 'human' }`. Creates the brief row when none exists.
- `getBrief(ctx, accountId): BriefView | null` (null for missing or hidden):
  `{ accountId, offerId, offerName, state, lastDraftedAt, recommendation, whoFirst, opener, whyNow, sections[] }`,
  each piece with `writtenBy`, `label`; sections also `title`, `citations`, `editedByName`,
  `editedAt`, `writtenForOfferName`, `version`.
- Consumers (all `orderedBy` account):
  - `playbooks.brief_on_scored`, `.brief_on_signal`, `.brief_on_fact`, `.brief_on_person_added`, `.brief_on_person_updated`, `.brief_on_review_changed`
  - `.brief_freeze` (assignment created), `.brief_unfreeze` (declined, withdrawn)
  - `.brief_on_merged`: the survivor keeps its brief, or takes the merged one's; the merged id's rows are deleted after their history is moved; then a redraft is requested
- `backfillBriefs(ctx)`: requests a rules draft for every scored account with no brief; called in
  `seed.ts` after scoring.

- [ ] **Step 1: Write failing tests.**
  - First `scoring.account.scored` with tier `watch`: brief `ready` in rules mode within one job, four page sections, labels `Assembled from rules`.
  - The same with `act_now` in mock mode: `Sample output`, `ai_run_id` set (PLB-E3-S1-AC2).
  - Twelve `accounts.signal.recorded` events for one account give at most two `ai_run` rows (Review Focus 3).
  - After `routing.assignment.created` a signal requests no draft; after `routing.assignment.declined` one runs.
  - Edit during a draft (stub the task to wait until the edit commits): the human text and label stay, the other sections are written, and history has version 1 of Overview (Review Focus 1).
  - Live failure (adapter returns invalid JSON twice) gives a rules brief and `last_error` (Review Focus 2).
  - Lead offer changed with an edited Approach: Approach keeps the text and returns `written_for_offer_name`; Overview is redrafted for the new offer.
  - `editSection`: empty body gives 400 `Write the section first, then save it.`; 4,001 characters give 400 `Keep it under 4,000 characters.`; a stale `ifVersion` gives 409 `Someone changed this section since you opened it. Reload to see their version.`; an API key editor shows `Edited by {key name}`.
  - Merge moves the brief to the survivor.
  - `getBrief` for a hidden account is null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/integration/playbooks`, `tests/unit/seed.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(playbooks): brief drafting, triggers, edits and read`.

### Task 4: The handoff package for the CRM push

**Files:**
- Create: `src/modules/playbooks/domain/{follow-ups,package}.ts`, `src/modules/playbooks/services/package.ts`
- Modify: `src/modules/playbooks/index.ts` (`playbooksHandoffPackage`), `src/entry/compose.ts`
- Test: `tests/unit/playbooks/{package,follow-ups}.test.ts`, `tests/integration/playbooks/handoff-package.test.ts`, `tests/integration/v1/compose.test.ts`

**Interfaces:**
- `playbooksHandoffPackage: HandoffPackageProvider`, registered with `registerHandoffPackageProvider` in compose (PLB-E3-S4-AC1).
- `buildPackage({ brief, account, score, offer, caseStudies, signals, matches, followUpDays, buyer, now }): HandoffPackage` (pure).
  - `sections`, in this order, each `{ key, label, html }`:

    | Key | Label | Content |
    |---|---|---|
    | `score` | `Score` | `{Tier label}: priority {p}, fit {f}, buying intent {i}.` |
    | `recommendation` | `Scout's recommendation` | headline and detail |
    | `why_now` | `Why now` | the section text, then each dated signal with its date and source link |
    | `how_to_approach` | `How to approach` | who first, then the Approach section, then the opener |
    | `overview` | `Overview` | the section |
    | `value_angle` | `Our value angle` | the section |
    | `risks` | `Risks and watch-outs` | the section |
    | `offer` | `The offer` | promise, price range, sales cycle in days, usual buyers, proof points, case studies |
    | `fit` | `Why it fits` | `{label}: {points} of {max}. {note}` per fit part |
    | `signals` | `Signals` | every scored signal, `{date} {title} ({source})` and the rule's text |
    | `research_topics` | `Research topics` | intent topics; internal only |
    | `other_offers` | `Other offers that fit` | up to 3 other matches with their totals |
    | `would_raise` | `What would make it stronger` | the would-raise lines |

    Every brief-made piece ends with its label line, for example `<em>Written by Claude</em>` or
    `<em>Edited by Dana Ruiz</em>`. Everything is escaped (`esc`). Sections with no data are left
    out. CRM drops from the bottom when over `NOTE_LIMIT`.
  - `properties`: `practice` (name), `best_offer` (lead offer name), `tier` (key), `fit`, `intent`, `priority`, `why_now` (plain text, 1,000 characters), `top_signals` (three newest titles joined by `; `), `research_topics` (joined by `, `).
  - `firstTouch`:
    - subject `First touch: {buyer} at {account}`, or `First touch: {account}`
    - body `Start with {buyer}, {title} ({email}).`, then a blank line, then `Opener ({label}):`, `Subject: {opener subject}` and the opener body
  - `followUps`: Ruling 10, subject `Follow-up {i} of {n} (day {d}): {purpose}, email {buyer or account}`.
  - `planSteps: []`.
- `package(ctx, accountId, assignmentId)`: reads only (Ruling 9).

- [ ] **Step 1: Write failing tests.**
  - Unit: section order and labels; an edited section carries `Edited by`; a rules package marks every AI-shaped part `Assembled from rules` (PLB-E3-S4-AC3); a research-intent signal and a lawsuit appear in `signals` but not in `firstTouch` or `followUps` (AC4).
  - Follow-ups: days `[3, 7, 14]` give New angle, Proof, Close the loop; `[5]` gives Close the loop.
  - Integration: with the provider registered, a push to the mock HubSpot writes a note that starts with `Score` and contains `Scout's recommendation`, the edited Overview text and `Open in Scout`; the first-touch task body has the opener; the follow-up tasks follow the tenant's days.
  - The package makes no `ai_run` row and no write (row counts unchanged).
  - With no brief, the package is a rules package.
  - Compose registers the provider (`handoffPackageProvider()` is not the default).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/unit/playbooks`, `tests/integration/playbooks`, `tests/integration/crm`, `tests/integration/v1/compose.test.ts`. Expected: PASS (existing CRM note and task tests still pass with no provider).
- [ ] **Step 5:** Commit `feat(playbooks): handoff package for the CRM push`.

### Task 5: Brief endpoints

**Files:**
- Create: `src/http/routes/v1/accounts/[id]/brief/route.ts`, `src/http/routes/v1/accounts/[id]/brief/sections/[key]/route.ts`
- Modify: `src/http/routes.ts`, `src/http/routes/v1/accounts/[id]/route.ts` (`draft-brief` action), `docs/spec/playbooks/index.md` (API table: PUT and `:draft-brief`), `docs/spec/web-ui/api-gaps.md` (playbooks row 4a READY)
- Test: `tests/integration/v1/playbooks.test.ts`, `tests/integration/v1/route-access.test.ts`

**Interfaces:**
- `GET /api/v1/accounts/{id}/brief` (`playbooks:read`). 404 for a missing or hidden account. 200:
  ```
  { account_id, offer_id, offer_name, state: "not_drafted"|"drafting"|"ready", last_drafted_at,
    recommendation: { headline, detail, written_by, label } | null,
    who_first: { person_id, title, reason, written_by, label } | null,
    opener: { subject, body, written_by, label } | null,
    why_now: { body, citations, written_by, label } | null,
    sections: [{ key, title, body, citations, written_by: "claude"|"sample"|"rules"|"person", label,
                 edited_by_name, edited_at, written_for_offer_name, version }] }
  ```
  `sections` holds the four page sections in order, also before drafting (`body: null`).
- `PUT /api/v1/accounts/{id}/brief/sections/{key}` (`playbooks:write`), body `{ body: string, if_version?: number }` (strict, 16 KB): 200 with the section. 404 `That brief section doesn't exist.` for a key outside the four, plus Task 3's 400 and 409.
- `POST /api/v1/accounts/{id}:draft-brief` (`playbooks:write`, idempotent), body optional `{ include_edited?: string[] }` (page keys): 202 `{ state: "drafting" }`.

- [ ] **Step 1: Write failing tests.** For each endpoint:
  - success
  - no permission (a member with only `accounts:read`) is 403
  - bad body is 400
  - another tenant's account and an account outside a seller's data limit are 404
  - a section PUT by an API key with `playbooks:write` shows the key's name
  - `:draft-brief` twice with one idempotency key enqueues once
  - route-access lists the three with their permissions
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and correct the two spec rows.
- [ ] **Step 4:** Run `tests/integration/v1`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(playbooks): brief endpoints`.

### Task 6: The page's read gaps (scoring, accounts, crm)

**Files:**
- Modify: `src/modules/scoring/services/explain.ts`, `src/modules/accounts/services/read.ts` (+ `listBuyingRoles`), `src/modules/crm/services/{checks,read}.ts`, `src/modules/crm/db/schema.ts` + migration (top open deal on `company_check`), `src/modules/crm/index.ts`, `src/http/routes/v1/accounts/[id]/{facts/route.ts,route.ts}`, `src/http/routes.ts`, `docs/spec/web-ui/api-gaps.md` (rows to READY)
- Create: `src/modules/crm/services/activity.ts`, `src/http/routes/v1/accounts/[id]/{crm-check,activity}/route.ts`, `src/http/routes/v1/buying-roles/route.ts`
- Test: `tests/integration/v1/{scoring,accounts,crm}.test.ts`, `tests/unit/crm/activity.test.ts`, `tests/unit/scoring/tiles.test.ts`

**Interfaces:**
- `GET /api/v1/accounts/{id}/score` adds `tiles` and `warm_intro`:
  - `tiles`: five entries `{ key, label, value: number | null, max: 100 | null, note }`, in order
    `priority`, `fit`, `intent`, `revenue_potential`, `source_trust`
  - `warm_intro`: `{ introducer_name, points } | null`

  Notes:

  | Tile | Note |
  |---|---|
  | priority | `Act now needs a priority of {total}, fit {fit} and buying intent {intent}.` |
  | fit | the highest-scoring fit part's note |
  | intent | the newest intent line's text, or `No dated signals yet.` |
  | revenue_potential | value null, `Arrives with enrichment` |
  | source_trust | value null, `Not enough data yet` |
- Account read and `GET /accounts/{id}/people`: `roles[]` gains `label`. `GET /api/v1/buying-roles` (`accounts:read`): `{ data: [{ key, label }] }`, active ones by sort.
- `GET /api/v1/accounts/{id}/facts`: each fact gains `source_names { person, agent, vendor }`, resolved through intake `sourceNames` in the route.
- `GET /api/v1/accounts/{id}/crm-check` (`accounts:read`): `{ exists, owner_name, lifecycle, open_deals, open_deal: { name, amount_cents, currency, last_activity_at } | null, checked_at, hubspot_url }`, or `{ exists: null, checked_at: null }` when never checked. `POST /api/v1/accounts/{id}:check-crm` (`accounts:read`, people only) refreshes now and returns the same. 503 `crm_unavailable` when HubSpot does not answer.
- `GET /api/v1/accounts/{id}/handoffs`: each handoff gains `crm_url`, and `follow_through.counts` gains `replies`.
- `GET /api/v1/accounts/{id}/activity?cursor` (`accounts:read`), newest first, 25 a page:
  - CRM rows: `{ data: [{ id, kind, at, summary }], next_cursor, synced_at }`. Summaries:
    - `email`: `Email sent`
    - `reply`: `Reply received`
    - `call`: `Call logged`
    - `meeting`: `Meeting held`
    - `task_done`: `Task done`
  - Scout rows (kind `scout`) from the handoff:
    - `Scout sent the account to HubSpot with {seller} as owner and logged the brief.`
    - `Scout sent the account to HubSpot and left {owner} as owner.`
    - `Scout took the account back: {reason}.` from `undone`
  - `synced_at` is `follow_through.checked_at`.

- [ ] **Step 1: Write failing tests.** For each endpoint: success, permission refusal, cross-tenant 404, and a seller reading their own account. Plus:
  - tiles for an unscored offer
  - a seller (no `arrivals:read`) gets fact source names
  - `:check-crm` against the mock with `open-deal.example` returns the deal name and amount
  - the activity page cursor works
  - `replies` counts only `reply`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/integration/v1`, `tests/integration/crm`, `tests/integration/scoring`, `tests/unit`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): score tiles, role labels, fact sources, CRM check card and activity for the account page`.

### Task 7: Account page, header, stage tracker and review view (web-ui)

**Files:**
- Create: `web-ui/src/features/account/{api.ts,AccountPage.tsx,AccountHeader.tsx,StageTracker.tsx,ReviewView.tsx,BriefCard.tsx,ScoreStrip.tsx,RightRail.tsx,Account.module.css,testing.ts,account-page.test.tsx,brief.test.tsx}`
- Modify: `web-ui/src/routes/workspace.tsx` (`accountRoute` with `validateSearch` `from` and the queue filters), `web-ui/src/features/review/{PeekDrawer.tsx,AssignDialog.tsx,SendBackDialog.tsx}` (dialogs take `DialogAccount`, the fields they use, not a `QueueRow`), `web-ui/src/features/accounts/{MyAccountsScreen,AllAccountsScreen}.tsx` (links carry `from`)
- Test: the two new test files, the existing peek, my-accounts and all-accounts tests (link targets)

**Interfaces:**
- Route `/t/:tenant/accounts/:id?from=queue|my|all` plus the queue's `tier, practice, offer, source, status` when `from=queue`.
- Queries: `GET /accounts/{id}`, `/review`, `/score`, `/facts`, `/brief`, `/notes`, `/crm-check`, `/handoffs` (after assignment). `/review` and `/brief` refetch every 30 s, and `/brief` every 5 s while `state` is `drafting`.
- Header (§4):
  - breadcrumb `{Review queue | My accounts | All accounts} / {name}`
  - with `from=queue` and the queue list in the TanStack cache: `{i} of {n}`, `Previous`, `Next`. Hidden on a direct link.
  - initials tile, name, status pill from `/review` with `changed_by_name`, `{industry} · {location} · {domain}`, Practice and Best offer pills from `lead_offer`
  - origin line `From {source} ({via}) · Batch {id} · Arrived {date}`
  - buttons `Send back` and `Approve and assign` by `review:act` and `assign:act`. `Enrich` is not rendered.
- Notices:
  - `Declined by {AE} on {date}: {reason}. Assign someone else or send it back.`
  - the two-companies notice from `/handoffs.conflict`
  - `HubSpot needs a decision` with the API message
- Stage tracker: `review.stages` with dates, current marked, `Waiting on you` on the review step for a principal with `review:act` while the stage is `arrived`, `Next` on the next step.
- §4a sections:
  1. Recommendation (sparkle): `brief.recommendation`, hidden while null.
  2. Before you approve: only the warm intro row, `Warm intro available through {name}.`; the card is hidden without one. Conflicts and committee rows are R2 and not rendered.
  3. Score strip: the five `tiles`, bar only when `value` is not null.
  4. Why now: `{n} signals · newest first`, dated signals, each with its date, text and source link.
  5. Account facts: rows of label, value and `{source} · {date}`. The conflict badge is not rendered in R1 (Open question 6).
  6. Brief: `Last drafted {when}`, the four sections with `label`. `Edit` (by `playbooks:write`) opens a textarea with `Save` and `Cancel` and the hint `Saving marks this section as edited by you.`. Save sends `if_version`; the toast is `{Title} saved`; a 409 shows the API's words. `Written for {offer}` with `Redraft` asks first: `Redraft {Title}?` / `Scout rewrites this section for {offer}. Your edited version stays in the history.` with `Redraft` and `Cancel`; it calls `:draft-brief` with `include_edited: [key]`. While drafting: `Scout is redrafting this brief`.
  7. Playbook preview: not rendered (R2).
  8. Right rail:
     - Buying committee: people with role labels and `decision_note`. `Add a person` opens a form with name, title, email and a role from `/buying-roles`, and posts to `/accounts/{id}/people` (`people:write`). Gap rows and `Find` are not rendered.
     - Notes ("Scout uses these in the brief"): the peek's notes list and the §4a placeholder.
     - Where it came from: `review.sources` with owner names. The Batch and Source record tiles are not rendered.
     - In HubSpot: `Company exists. Open deal owned by {owner}: {deal}, {amount}, last activity {date}.`, `Company exists with no owner and no open deal. Scout can set the owner.`, `Company exists, owned by {owner}.` or `Not in HubSpot yet.`
- States (§4): Building card and section empties exactly as screens.md, when `brief.state` is `not_drafted` with no sections. Loading skeleton `Loading the brief, signals and buying committee`. Error `This account didn't open` with `Try again`, `Open next account` (from the queue only) and `{account id} · Error ref {ref}`. 404 `This account isn't in your workspace, or you don't have access to it.` with a link back.
- C14: when a refetch shows a new status or assignment made by someone else, the actions are replaced by `{Assigned | Sent back | Declined} by {name} a moment ago`.
- After `Send back` from the page, the next queue account opens (or the queue when there is none). After `Approve and assign`, the page shows §4b.

- [ ] **Step 1: Write failing tests (MSW).**
  - The header with the breadcrumb from each `from`; `{i} of {n}` and Next go to the next queue row; it is hidden on a direct link.
  - Tracker labels come from the API, with `Waiting on you` for a reviewer only.
  - Recommendation and the four brief tags (`Written by Claude`, `Assembled from rules`, `Edited by Dana Ruiz`).
  - Edit, Save: the PUT body has `if_version`, the toast says `Overview saved` and the tag becomes `Edited by {me}`.
  - A 409 shows the API title. Edit is hidden without `playbooks:write`.
  - `Written for` with Redraft confirms and posts `include_edited`.
  - The score strip shows `Arrives with enrichment` and `Not enough data yet`.
  - The warm intro row, or no card.
  - The HubSpot card's four variants.
  - `Add a person` posts its role key.
  - The Building, loading, error and not-found states.
  - The "Assigned by Dana a moment ago" swap.
  - The peek's `Open full page` link carries `from=queue` and the filters; My and All carry `from=my` and `from=all`.
- [ ] **Step 2:** Run `npm test` in `web-ui`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck`, `npm run lint` in `web-ui`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): account page header, stage tracker and review view with the editable brief`.

### Task 8: Assigned view, e2e and verification

**Files:**
- Create: `web-ui/src/features/account/{AssignedView.tsx,assigned.test.tsx}`, `tests/e2e/account.spec.ts`
- Modify: `web-ui/src/features/account/{AccountPage,AccountHeader}.tsx`, `web-ui/src/routes/screens.ts` (account tag), `docs/spec/migration-and-rollout/release-plan.md` (the R1 checklist line on the package)

**Interfaces:**
- The header after assignment:
  - status pill: the handoff state chip, with `In HubSpot · {seller}` when it is `in_crm`
  - origin line `Assigned to {AE} by {leader} on {date}`
  - buttons `Reassign` (the Assign dialog), `Open in HubSpot` (`crm_url`, new tab, only when present) and `Retry sending` (failed, `crm:push`)
- §4b:
  1. Outcome tiles: only Replies `{replies} of {emails}` with `Emails sent since {handoff date}`, and Opportunity (`Not yet`, or the open deal's name and value from `/handoffs.deals`). Meetings held and Buyers engaged are not rendered (R2).
  2. Playbook: not rendered (R2).
  3. HubSpot activity, `Synced {when}`: the `/activity` rows, `Show more` by cursor. Empty: `No HubSpot activity yet. Replies, emails and meetings show here as HubSpot records them.`
  4. Review record, `Approved by {name} on {date}` from `review.approved`: the scores from `tiles`, each brief section cut to its first sentence, and `Show the full brief, signals and facts`, which expands §4a sections 3 to 6 in place, read only.
  5. Right rail:
     - Assignment: AE, `Accepted {when}`, `Accepted automatically {when}` (`accepted_how` `crm_activity` or `auto_timeout`) or `Waiting for {AE} to accept`, the quoted assigner note, the handoff chip
     - Buying committee: no engagement column (R2)
- e2e `account.spec.ts`:
  - `a leader opens an account from the queue, edits a brief section, approves and assigns`:
    - send an account (as in `review.spec.ts`)
    - queue, row, peek, `Open full page`: the URL has `from=queue`, the breadcrumb says `Review queue`
    - wait for the brief: Overview's tag is `Assembled from rules` or `Sample output`
    - Edit Overview, type a line, Save: toast `Overview saved`, tag `Edited by Zach`
    - reload: the text and tag stay
    - `Approve and assign`, pick the AE, assign: toast `Sending {name} to HubSpot.`, the page shows the assigned view with the assignment card `Waiting for Ash … to accept`
    - poll until the chip says `In HubSpot`
    - through the API, `GET /accounts/{id}/handoffs` is `completed`
  - `an AE opens a new assignment from My accounts and sees the review record`: breadcrumb `My accounts`, `Approved by`, `Show the full brief, signals and facts` expands.

- [ ] **Step 1: Write failing tests:** the assigned view tests (MSW) for every line above, plus the e2e specs.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Verify everything.**
  - root `npm run lint`, `npm test`, `npm run build`
  - `web-ui` `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
  - `npm run e2e` (all specs, review.spec.ts included)

  Expected: all PASS.
- [ ] **Step 5:** Commit `feat(web-ui): assigned view and the account page e2e`.
