# Taazaa Scout R1b Scoring and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every account intake creates is scored against the approved offers it could buy, explained line by line, put in a review queue with a status, and reviewed, sent back, declined or assigned to a seller who accepts or declines. Every move is tracked as a stage that people and agents can read.

**Architecture:** Two new modules on R1a: Scoring and matching (`scoring` schema) and Review and routing (`routing` schema). Offers gains signal rules. Scoring is driven by events and computes everything with pure domain functions ported from v1. Routing owns review statuses, assignments and stages, and reaches the CRM only through a port that R1c fills in. Accounts keeps `account_summary` current by consuming scoring and routing events, guarded by per-account versions, and the review queue is built on accounts' search so data limits stay in one place.

**Tech Stack:** As R1a. No new dependencies.

**Spec:** `docs/spec/scoring-and-matching/` (SCO-E1, E2 without revenue potential, E3, E4, E5 without the weights editor screen), `docs/spec/review-and-routing/` (REV-E1 with default statuses, E2, E3 preflight through a port, E4 stages that don't need the CRM), `docs/spec/offers-and-practices/signal-rules.md` (OFF-E4-S1, S2), `docs/spec/sources-and-intake/` (SRC-E1-S4 feedback, SRC-E2-S3-AC1 stage counts, SRC-E3-S4-AC1), `docs/spec/accounts/` (ACC-E1-S3-AC3, ACC-E8 columns, own_accounts past owners), `docs/spec/tenancy-and-access/roles-and-data-scopes.md`, `docs/spec/architecture/*`. v1 reference at commit `c3c2124` (`src/lib/matching.ts`, `src/lib/signalRules.ts`, `tests/unit/matching.test.ts`).

## Scope

In: the two modules, offer signal rules, their events and jobs, every service behind a `/v1` endpoint (agent endpoints from the spec, plus people-only endpoints the front end will call), tenant defaults, read-model updates in accounts and intake, a backfill for accounts created under R1a, seed data.

Out, by owner plan:
- **R1c:** a real ownership preflight (CRM implements `OwnershipPreflight`), the "no CRM owner set" block, implied acceptance from CRM activity, stages `engaged`, `opportunity`, `won`, `lost`, handoff status on the tracker, notifying the assigner of a failed handoff, `crm_status` exclusions, the REV-E4-S2-AC1 `crm:push` extras.
- **R1d:** MCP tools (`explain_score`, `get_account_status`, `list_my_submissions`), the SCO-E5 throughput target (10,000 accounts in 5 minutes) and SCO-E5-S1-AC1 p95 latency, measured with the R1d throughput test.
- **R2:** revenue potential (SCO-E2-S4), the weights editor screen and preview (the profile API is in R1b), configurable review statuses and decline reasons (REV-E1-S4; the release plan's R1 row says "configurable statuses", REV-E1 puts them in R2, and this plan follows REV-E1), the playbook picker (`templateId` is always null), conflict flags and `accounts.conflict.resolved` rescoring, conflict-lost feedback, enrichment flags, signal rules suggested by wins, changing introducer points (SCO-E2-S2-AC2).
- **R3:** trust scores and `intake.source.trust_changed` producers (the event is defined now and consumed; nothing publishes it until R3), so the trust modifier is 0 and the low-trust flag never fires in R1b; decline-reason reporting (REV-E2-S3-AC3); `jobs.history.republish`; `score_change` retention (2 years).
- **Front end:** every screen, and in-app notifications (REV-E2-S2-AC1, REV-E2-S4-AC1 "notifies"); the events they would come from are published here.

## Design

| Aggregate | Owner | Invariants it guards | Consistency boundary |
|---|---|---|---|
| Account score (account_score, offer_match rows, score_change) | Scoring | One current score per account; matches only for approved offers; best offer never archived or draft; an unchanged inputs hash on the same day writes nothing and publishes nothing; every real change writes one `score_change` and bumps `account_score.version` | Advisory lock `scoring:<account>` on the resolved (survivor) id |
| Scoring profile | Scoring | Fit part maxes add to 100; weights not both 0; ranges valid; every change bumps `version` | Single-row write |
| Account review (account_review, status_change, assignment, stage_change) | Routing | One review row per account; at most one open assignment; a declined account can't be assigned; stages move forward except the listed returns; every write bumps `account_review.version` and writes one history row | Row lock on `account_review` (`select … for update`) |
| Signal rules | Offers | Points 0 to 100; "why" required; a change publishes `offers.offer.changed` with `affectsMatching: true` | The offer row |
| Account summary (read model) | Accounts | Applies a scoring or routing event only if its version is newer than the one stored | Account lock |
| Source feedback | Intake | One row per (source, arrival, kind, cause event) | `processed_event` plus a unique index |

Layers as in R1a: `domain/` pure (scoring math, tiers, floors, explanations, stage transitions, working days), `services/` transaction scripts, `contracts/` (events, jobs, DTO types, ports), `db/`, `index.ts` facade.

Dependency direction: offers ← accounts ← intake ← scoring ← routing; routing also calls accounts and scoring. Lower modules learn about higher ones only by consuming events through their `contracts/events.ts` (the published language, which the ACC and SRC indexes list and the lint rule allows), and through ports they define (`ReviewStatusValidator` in intake, implemented by routing). `contracts/events.ts` files import only zod, platform and lower contracts.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **Accounts keeps `account_summary` from two snapshot events.** `scoring.account.scored` already carries the score fields; it gains `version` (`account_score.version`). Routing publishes `routing.review.changed { accountId, version, snapshot }` after every write to an account's review (creation, status, assignment, flags, stage, merge), where `snapshot` is the full state accounts needs: `reviewStatusKey`, `ownerUserId`, `ownerHistoryUserIds`, `hasOpenAssignment`, `stage`, `reviewFlags`. Each write bumps `account_review.version` once and publishes one snapshot. Accounts consumes only these two events and overwrites its columns when the event's version is newer than the stored `score_version` / `review_version`, so out-of-order or retried delivery can't leave stale or half-applied state. The finer routing events (`status.changed`, `assignment.*`, `stage.changed`) are still published for other consumers. The summary's fit and intent can lag, because `scored` fires only when priority, tier or best offer changes (the spec's choice).
2. **The primary contact rule reads the best offer's target titles itself**: `repickPrimary` reads `account_summary.best_offer_id` and that offer's `targetTitles` through offers `getOffer`, so every caller (person edits, arrivals, merges, the scored consumer) gets the same answer.
3. **`own_accounts` covers current and past owners**: `account_summary.owner_history_user_ids text[]` (GIN index), appended when an assignment ends.
4. **The ownership preflight is a port** `OwnershipPreflight` in `routing/contracts/ports.ts`, default `{ result: 'new', message: 'New in the CRM' }`. The spec graph has REV call CRM directly; R1c may keep the port (CRM implements it) or replace it with a direct call, and decides then.
5. **Initial review status** is `intake.arrival.resolved.initialReviewStatusKey` when it names an active status, else `unvetted`. Intake validates a source's `initial_review_status_key` through `ReviewStatusValidator` (intake's port, routing implements; with none registered, any key is accepted).
6. **Auto-acceptance** is a service `autoAccept(ctx, now)` run by an hourly per-tenant schedule. Working days are Monday to Friday in the tenant's timezone, holidays ignored in R1b. `routing_setting.auto_accept_working_days` (1 to 10, or null for off), default 2. At most 500 assignments per run.
7. **"New from <source>"** on an assigned account is `account_review.flags.newFrom = { sourceId, at }`, set when a resolved arrival attaches to an account with an open assignment, cleared by `POST /v1/accounts/{id}:seen` from the assigned seller.
8. **The queue is built on accounts `search`** (B5): accounts gains filters `reviewStatusKeys`, `arrivedSince`, `accountIds` (at most 1,000, for the batch filter from intake), `reviewFlags`, `queueDefault` (Ruling 15), and a `countAccounts` call; `account_summary` gains `review_flags text[]` and `has_open_assignment boolean` from routing events. Routing hydrates insights and flag details for the page. The low-trust flag is R3.
9. **Intake reads account status from accounts**: `getSummaries(ctx, ids)` (at most 1,000) for batch stage counts and arrival detail; owner names through tenancy `members`. No intake read model of routing state.
10. **Scoring locks and writes on the resolved id**: resolve merged ids first, lock, then read. A rescore job scores each account in its own savepoint (`ctx.tx.transaction`), loads the profile and approved offers once, has `timeoutMs` 300,000, and takes at most 200 ids per message (the spec's 500 is a ceiling; a smaller page shortens how long account locks are held). A retry is safe because of the inputs hash.
11. **One arrival scores once**: `accounts.fact.recorded`, `accounts.signal.recorded` and `accounts.account.updated` gain an optional `arrivalId`; scoring's consumers of accounts events skip events that carry one, because `intake.arrival.resolved` scores the account. An arrival rejected as `excluded` (the account was still upserted) is scored from `intake.arrival.rejected` when it carries an `accountId`.
12. **Revenue potential stays null** in R1b (nullable columns exist so R2 adds no migration).
13. **`PUT /v1/scoring/profile` is in R1b** (`scoring:manage`, which owners, leaders and operators hold), with validation, ranges and the audit entry; only the screen and preview wait for R2.
14. **Assigning a declined account is refused** (409 `Reopen it before assigning.`); "Approve and assign" picks the first status by order that counts as reviewed and is not declined; changing the status to a declined one first withdraws an open assignment, then moves the status and stage to declined.
15. **The default queue view** is accounts with no open assignment and (a status that does not count as reviewed, or the `declined_by_seller` flag) (REV-E2-S3-AC2), as one combined `queueDefault` search filter. The flag clears when the account is assigned again.
16. **A withdrawn assignment returns the stage to `reviewed`**, like a decline (both end an open assignment the leader must act on again). REV-E4 lists only the decline; Task 18 updates `stage-tracking-and-status.md`. `nextStage(declined, withdraw)` does nothing.
17. **Sellers act on their own assignments by ownership, not visibility**: accept, decline and `markSeen` check `assignment.seller_user_id` equals the actor (another seller gets 404), because a seller limited to `own_accounts` only sees the account once the summary consumer has run.
18. **Rescore progress (SCO-E5-S4-AC1 "progress is visible") is R2**, with the weights screen that shows it; `POST /v1/rescore` returns 202 with a job id in R1b.

## Global Constraints

- Everything in R1a's Global Constraints holds: every table in `scoring` and `routing` has `tenant_id` and forced RLS; module imports only through `index.ts` or `contracts/*`; prefixed ULIDs; snake_case JSON; problem+json errors; no em dashes in copy; every POST/PUT/PATCH through `v1Route` with bounded bodies and idempotency.
- New schema `scoring` (Task 2) and `routing` (Task 11): bootstrap grants and default privileges, `MODULE_ORDER` (`… intake, scoring, routing`) and the migrate test's order, `drizzle/<schema>.config.ts`, Dockerfile `COPY`, RLS catalog test, `src/entry/registry.ts`, `src/entry/compose.ts` for port registrations.
- New id prefixes, added to `src/platform/ids.ts` in the first task that uses each: `sr_` (signal rule, Task 1), `om_` (offer match), `scc_` (score change) (Task 2), `rsd_` (review status def), `rsc_` (review status change), `stc_` (stage change), `drd_` (decline reason def) (Task 11), `fb_` (source feedback, Task 17). `asg_` exists in data conventions.
- Scoring defaults (`scoring_profile`): `fit_weight` 0.55, `intent_weight` 0.45, fit part maxes industry 30, size 25, revenue 20, region 10, buyer 15, `half_life_days` 45, `max_signal_age_days` 365, tier thresholds (not a fit: fit < 40; act now: fit ≥ 60, intent ≥ 35, total ≥ 60, at least one research or trigger hit; good fit: fit ≥ 60), `warm_intro_cap` 20, `trust_modifier_max` 5, `trust_neutral` 0.6, `research_floor_days` 180. Ranges: weights 0 to 1, not both 0; half-life 1 to 365; thresholds 0 to 100; warm cap 0 to 20; trust max 0 to 10.
- Scoring math as SCO-E1 to E3: `match_total = round((fit × fit_weight + intent × intent_weight) / (fit_weight + intent_weight))`; hard-miss cap 45; total capped at fit when fit < 50; recency `0.5 ^ (age / half-life)`, 0 past `max_signal_age_days`, 1 for tech, growth and workforce, and a signal with no date uses its recorded day; research intensity `(score − 0.40) / 0.40` clamped 0 to 1, with research scores normalised to 0 to 1 in one place (values above 1 are divided by 100); rule factor strongest + 30% second + 15% third, capped 1, research rules strongest only; rule points rounded to one decimal; intent capped 100 and rounded; `trust_modifier = clamp(round((trust − trust_neutral) × 25), −trust_modifier_max, trust_modifier_max)`, rounding half away from zero and never `-0`; priority clamped 0 to 100; no warm or trust adjustment when the account's final tier (after floors) is `not_fit`.
- Domain functions take `now` as an argument; tests never depend on the clock.
- Default review statuses: `unvetted` (Unvetted), `needs_review` (Needs review), `reviewed` (Reviewed, counts as reviewed), `declined` (Declined, counts as reviewed, declined). Review decline reasons: Not a fit, Already a customer, Open deal elsewhere, Duplicate, Bad data, Wrong timing, Other (note required). Assignment decline reasons: Not my territory, Too much on my plate, Already talking to them, Not a fit, Other (note required).
- Copy (exact): `Pick a reason`, `Say what the source should fix`, `Add a note for Other.`, `Add a note saying why you're reopening it.`, `Reopen it before assigning.`, `Pick a review status from your list.`
- Limits: signal rules 50 per offer, 30 keywords per rule, keyword 60 characters, label 120, why 500; notes, decline notes, assignment notes and insights 4,000 characters; pages 1 to 200 (default 50), score history default 10 and at most 50; bulk at most 50 accounts.
- Stages: `arrived`, `reviewed`, `assigned`, `engaged`, `opportunity`, `won`; exits `lost`, `declined`. R1b moves `arrived`, `reviewed`, `assigned`, `declined`, and the returns: a declined or withdrawn assignment goes back to `reviewed`; reopening a declined account goes back to `arrived`.

## Review Focus

1. **The same account is rescored by several events at once** (an arrival plus a trust change plus a profile change). Expected: one consistent score, one `score_change` per real change, no lost update. Test in Task 7.
2. **An offer is archived while it is the best offer of many accounts, including accounts with no practice.** Expected: none keeps an archived best offer, and an account with no other approved offer gets tier `not_fit` with a reason. Test in Task 8.
3. **Two leaders assign the same account at the same moment.** Expected: one open assignment; the other replaced or refused; both recorded. Test in Task 13.
4. **A seller declines, then a late or retried event for that account arrives** (an old `assignment.created`, an `accepted` retried after a decline). Expected: the summary's owner, status and stage stay right. Tests in Tasks 12 and 14.
5. **An agent asks for the status, score or feedback of an account outside its data limit, or by an arrival id that isn't its own.** Expected: not found, never forbidden. Tests in Tasks 10, 16 and 17.

---

## File Structure

```
src/modules/offers/                 + signal_rule table, domain/signal-rules.ts, services/signal-rules.ts, default rules
src/modules/accounts/               + ScoringView columns, listAccountIds, getSummaries, search filters, version-guarded consumers
src/modules/intake/                 + trust_changed event, chainsForAccount, accountIdsForSource, ReviewStatusValidator port, feedback
src/modules/scoring/
  index.ts contracts/{events,jobs,types}.ts db/schema.ts db/migrations/
  domain/{fit,intent,combine,tiers,best-offer,priority,explain,inputs-hash}.ts
  services/{profile,score,rescore,read}.ts jobs.ts consumers.ts defaults.ts
src/modules/routing/
  index.ts contracts/{events,jobs,ports,types}.ts db/schema.ts db/migrations/
  domain/{stages,working-days,status-rules}.ts
  services/{stage,review,queue,assign,respond,read,settings}.ts jobs.ts consumers.ts defaults.ts
src/app/v1/                         scoring, review-queue, assignments, feedback, signal-types, offers/{id} actions, accounts/{id} additions
tests/integration/helpers/publish.ts   publishes an event into the outbox for consumer tests
```

---

### Task 1: Signal rules in Offers

**Files:**
- Create: `src/modules/offers/domain/signal-rules.ts`, `src/modules/offers/services/signal-rules.ts`, a drizzle-generated offers migration
- Modify: `src/modules/offers/db/schema.ts`, `src/modules/offers/defaults.ts`, `src/modules/offers/index.ts`, `src/platform/ids.ts`, `src/entry/seed.ts`, `src/app/v1/offers/[id]/route.ts` (POST becomes `byAction`), new `src/app/v1/offers/[id]/signal-rules/route.ts`, new `src/app/v1/signal-types/route.ts`
- Test: `tests/unit/offers/signal-rules.test.ts`, `tests/integration/offers/signal-rules.test.ts`, `tests/integration/v1/signal-rules.test.ts`

**Interfaces:**
- Table `signal_rule` (`id` `sr_`, `tenant_id`, `offer_id`, `type`, `label`, `weight` 0 to 100, `match` text[], `min_value` numeric null, `why`, `enabled`, `origin` (`default`, `manual`), `sort`).
- `DEFAULT_SIGNAL_RULES` (per offer slug) and `GENERIC_SIGNAL_RULES` ported from `c3c2124:src/lib/signalRules.ts`.
- `signalRuleProblems(rules): { path; message }[]`: the limits in Global Constraints; weight 0 to 100; type one of the nine signal types; `Add why this signal matters.`
- Services: `listSignalRules(ctx, offerId)`; `replaceSignalRules(ctx, offerId, rules)` (publishes `offers.offer.changed` with `changed: ['signal_rules']`, `affectsMatching: true`; audited); `resetSignalRules(ctx, offerId)` (the slug's defaults or the generic set); `listApprovedOffers(ctx, { practiceIds? })` (the spec's name: approved offers with fit criteria and enabled rules, all practices when the list is empty or absent, ordered by `approved_at` then id).
- Seed: Taazaa offers get their default rules (idempotent).
- Routes: `GET /v1/offers/{id}/signal-rules` (`offers:read`); `PUT /v1/offers/{id}/signal-rules` (`scoring:manage`); `POST /v1/offers/{id}:reset-signal-rules` (`scoring:manage`, alongside `:approve` on `offers:manage` through `byAction`); `GET /v1/signal-types` (`offers:read`, OFF-E4-S2: each type's label, kind, what it is and how to read it, from accounts' `SIGNAL_TYPES`, exported from the accounts index in this task). Offers validates rule types against its own list of the nine type keys (offers may not import accounts, which already imports offers).

- [ ] **Step 1: Write failing tests.**
  - Unit: each validation message and limit.
  - Integration: OFF-E4-S1-AC0 (403 without `scoring:manage`); AC2 (event with `affectsMatching`); AC3 (reset restores `modernization-blueprint` defaults; an offer with no defaults gets the generic set); AC4 (empty `why` refused); `listApprovedOffers` leaves out drafts, archived offers and disabled rules, ordered by approval; seed twice gives the same count; OFF-E4-S2-AC1 lists nine types with plain explanations.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): signal rules per offer and the signal guide`.

### Task 2: Scoring module schema, contracts and tenant defaults

**Files:**
- Create: `src/modules/scoring/{index.ts,contracts/events.ts,contracts/jobs.ts,contracts/types.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`, `drizzle/scoring.config.ts`, `tests/integration/helpers/publish.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, `src/platform/ids.ts`, `src/entry/worker.ts`, RLS catalog test (add `scoring`)
- Test: `tests/integration/scoring/defaults.test.ts`

**Interfaces:**
- Tables `scoring_profile`, `offer_match`, `account_score`, `score_change` with the SCO index fields and `tenant_id`. `account_score` adds `version int`, `trust_source_id`, `warm_introducer_name`, and nullable `revenue_potential_cents`, `revenue_band`. Unique `offer_match (tenant_id, account_id, offer_id)`; index `offer_match (tenant_id, offer_id)`; index `score_change (tenant_id, account_id, at desc)`.
- Events: `scoring.account.scored` (index data plus `version`), `scoring.rules.changed`.
- Jobs: `scoring.rescore.accounts { accountIds: string[] (1 to 200), cause }` (timeout 300,000 ms); `scoring.rescore.page { filter, cause, afterId? }` (pages 200 ids per message through the id-listing calls from Task 6 and re-enqueues itself with the cursor); `scoring.ageing { afterId? }`.
- `publishTestEvent(tenantId, def, data)` test helper writes an outbox row for consumer tests.
- Consumer `scoring.tenant_defaults` on `tenancy.tenant.created`: the default profile and the nightly ageing schedule (02:00 UTC). `seedScoringDefaults(ctx)`.

- [ ] **Step 1: Write failing tests.** Defaults created once with the Global Constraints values; RLS isolation; a `rescore.accounts` job with 201 ids is refused by the schema.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls` and `platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): schema, contracts and tenant defaults`.

### Task 3: Fit, intent and match total (pure)

**Files:**
- Create: `src/modules/scoring/domain/{fit,intent,combine}.ts`
- Test: `tests/unit/scoring/{fit,intent,combine}.test.ts`

**Interfaces:**
- Input types in `contracts/types.ts`: `ScoringAccount` (`industry`, `industryKey`, `employees`, `revenueCents`, `country`, `technologies`, `headcountGrowth6m`, `domain`, `excluded: { label } | null`, people `{ title, roleKeys }[]`), `ScoringSignal` (`id`, `type | null`, `kind`, `title`, `detail`, `value`, `occurredAt | null`, `recordedAt`), `ScoringOffer` (fit criteria, `targetTitles`, `targetBuyingRoles`, `excludedDomains`, `excludedCategories`, `rules`), `ScoringProfile`.
- `fit(account, offer, profile): { fit; parts: FitPart[]; disqualifiedReason: string | null; hardMiss: boolean }` per SCO-E1 (port `industryMatches` and `titleMatches` from `c3c2124:src/lib/matching.ts`; US aliases; exclusions first; cap 45).
- `intent(account, signals, rules, profile, now): { intent; hits: RuleHit[] }` per SCO-E1 and Global Constraints (keywords of three letters or fewer match whole words; tech rules also match technologies; growth and workforce rules use current values and `min_value`).
- `matchTotal(fit, intent, profile): { total; cappedAtFit: boolean }`.

- [ ] **Step 1: Write failing tests.** SCO-E1-S1-AC4, AC5; SCO-E1-S2-AC1 to AC5; SCO-E1-S3-AC1 (62), AC2 (45); worked examples A (fit 100, intent 22, total 65), B (fit 45, total 45), C (intent 26, total 50); every still-applicable case from `c3c2124:tests/unit/matching.test.ts`; `now` is an argument everywhere; `AI` matches "AI strategy" and not "paid"; a research value of 70 is read as 0.70; a signal with no date uses its recorded day; weights 0.3 and 0.3 give the same total as 0.5 and 0.5.
- [ ] **Step 2:** Run `npm run test:unit -- scoring`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): fit, intent and match total`.

### Task 4: Tiers, best offer, floors and priority (pure)

**Files:**
- Create: `src/modules/scoring/domain/{tiers,best-offer,priority}.ts`
- Test: `tests/unit/scoring/{tiers,best-offer,priority}.test.ts`

**Interfaces:**
- `tierFor({ fit, intent, total, disqualifiedReason, hasResearchOrTrigger }, profile): Tier`.
- `bestOffer(matches, approvedOrder): Match | null` (highest total, then tier order, then fit, then approved first).
- `applyFloors(computed, { disqualified, researchTier, researchSignalAt, warmIntro, bestFit }, profile, now): { tier; tierReason; text? }`.
- `priority({ matchTotal, finalTier, warmPoints, trust }, profile): { priority; warmPoints; trustModifier }`.

- [ ] **Step 1: Write failing tests.** SCO-E3-S1-AC1 to AC4; SCO-E3-S2-AC1; SCO-E3-S3-AC1 to AC5 (copy `Researcher rated A with a signal from <date>: act now`); SCO-E2-S1-AC2 (76), AC3 (100), AC4; SCO-E2-S2-AC1 (points above the cap are capped); SCO-E2-S3-AC1 (0.6 → 0, 0.8 → +5, 0.4 → −5, 1.0 → +5, 0.0 → −5, and 0.58 → 0 not −0); a fit-38 account lifted by the research floor gets the warm and trust adjustments.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): tiers, best offer, floors and priority`.

### Task 5: Explanation and inputs hash (pure)

**Files:**
- Create: `src/modules/scoring/domain/{explain,inputs-hash}.ts`
- Test: `tests/unit/scoring/{explain,inputs-hash}.test.ts`

**Interfaces:**
- `buildExplanation(input): Explanation` with SCO-E4's shape (camelCase). Combine lines include `Hard miss: fit capped at 45.` and `Fit below 50: total capped at fit (<n>).` when they apply, so lines always add up. Intent lines carry `kind` and `signalIds`. `missing` lists unknown inputs with the most points they could change. Adjust lines `Warm intro from <name>: +<n>` and `Source trust <0.72> (<source name>): +<n>`. `otherOffers` lists the other matches with totals and tiers.
- `wouldRaise(explanation, offer, account): string[]`; `summarySentence(explanation): string`; `inputsHash(inputs): string` (sha256 of canonical JSON without `now`).

- [ ] **Step 1: Write failing tests.** SCO-E4-S1-AC1 for examples A, B and C (the lines add up to the priority within 1 point, including B's caps); SCO-E3-S2-AC2 (other offers listed); `missing` for unknown revenue and region; the summary for example A with a warm intro; the hash ignores `now` and key order and changes with one fact.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): explanations and inputs hash`.

### Task 6: What scoring needs from accounts and intake

**Files:**
- Modify: `src/modules/accounts/services/{read,primary,edit,upsert}.ts`, `src/modules/accounts/contracts/{events,types}.ts`, `src/modules/accounts/index.ts`, `src/modules/intake/contracts/events.ts`, `src/modules/intake/services/sources.ts`, `src/modules/intake/services/warm-intros.ts`, `src/modules/intake/index.ts`, `src/entry/registry.ts`
- Test: `tests/integration/accounts/scoring-reads.test.ts`, `tests/integration/intake/scoring-reads.test.ts`

**Interfaces:**
- Accounts:
  - `getAccountForScoring` adds the account's current columns (`industry`, `industryKey`, `employees`, `revenueCents`, `hqCountry`, `technologies`, `headcountGrowth6m`, `domain`) and the exclusion label; it returns the resolved `accountId`.
  - `listAccountIds(ctx, { practiceIds?, includeNoPractice?, hasSignalSince?, afterId?, limit ≤ 200 }): Promise<{ ids; nextAfterId | null }>` (keyset by id, active accounts only, no visibility filter; background jobs only: it throws when `ctx.access` is set).
  - `getSummaries(ctx, ids ≤ 1,000)` (stage, review status, owner user id, priority, tier, best offer, applying visibility).
  - Events gain optional `arrivalId` on `accounts.fact.recorded`, `accounts.signal.recorded`, `accounts.account.updated` (Ruling 11), set by `upsertFromArrival`.
  - `archiveSignal` publishes `accounts.account.updated` with `changedKeys: ['signals']`.
  - `repickPrimary` reads the best offer's target titles itself (Ruling 2).
- Intake:
  - Defines `intake.source.trust_changed` (SRC index data) and registers it.
  - `chainsForAccount(ctx, accountIds: string[]): Promise<SourceChain[]>` (distinct chains of resolved arrivals for those accounts) and `bestTrustForAccounts(ctx, accountIds): Promise<{ trust; sourceId; sourceName } | null>` (highest `getTrust` over the chains; `sourceId` is the closest source in the winning chain).
  - `accountIdsForSource(ctx, sourceId, { afterId?, limit ≤ 200 })` (keyset by id; includes the source's children).
  - `getWarmIntro(ctx, accountIds: string[])` (the strongest across the given ids; still accepts one id).

- [ ] **Step 1: Write failing tests.** `getAccountForScoring` for a merged id returns the survivor's id and columns; `listAccountIds` pages 450 accounts (200, 200, 50) and filters by practice, no practice and signal age; an arrival's fact and signal events carry `arrivalId`; archiving a signal publishes the update; after a person is added, the primary still follows the best offer's titles (the test sets `account_summary.best_offer_id` directly, since Task 9 writes it); `chainsForAccount` returns one chain per distinct arrival chain; `bestTrustForAccounts` with a stubbed `getTrust` picks the highest; `accountIdsForSource` includes child sources; `getWarmIntro` across a survivor and a merged id.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:int -- accounts intake`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: account and intake reads for scoring`.

### Task 7: Score one account

**Files:**
- Create: `src/modules/scoring/services/{profile,score,read}.ts`
- Modify: `src/modules/scoring/index.ts`
- Test: `tests/integration/scoring/score.test.ts`

**Interfaces:**
- `getProfile(ctx)` (defaults when there is no row).
- `scoreAccount(ctx, accountId, cause, causeEventId?): Promise<{ changed; score }>`:
  1. Resolve the id (merged ids follow the survivor), then lock `scoring:<resolved id>` (Ruling 10), then read `getAccountForScoring`, `listApprovedOffers` for the account's practices (all when empty), `getWarmIntro`, `bestTrustForAccounts`.
  2. Compute every match, pick the best, floors, priority, explanation.
  3. Unchanged inputs hash on the same day: return `changed: false`, write nothing.
  4. Otherwise replace `offer_match` rows, upsert `account_score` with `version + 1`, write `score_change` and publish `scoring.account.scored` when priority, tier or best offer moved or on the first score.
  5. No approved offers: no best offer, tier `not_fit`, priority 0, line `No approved offer to match against.`
  6. An excluded, not overridden account: every match disqualified with the exclusion's label.
- Reads (visibility through accounts `getAccount`; hidden is null): `getScore(ctx, accountId, { offerId? })`, `getMatches(ctx, accountId)`, `getScoreHistory(ctx, accountId, { limit ≤ 50 })`.

- [ ] **Step 1: Write failing tests.** SCO-E1-S1-AC1, AC2, AC3; SCO-E5-S1-AC2 (an unchanged rescore writes and publishes nothing); the first score publishes with `previousTier` null and `version` 1; no approved offers; excluded account; SCO-E2-S2-AC3 and SCO-E2-S3-AC2 lines with names; Review Focus 1 (three concurrent `scoreAccount` calls in separate transactions: one consistent score and the right number of `score_change` rows); a hidden account's score is null for a limited principal.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): score an account`.

### Task 8: Rescoring triggers, jobs and the profile service

**Files:**
- Create: `src/modules/scoring/services/rescore.ts`, `src/modules/scoring/jobs.ts`
- Modify: `src/modules/scoring/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/scoring/rescore.test.ts`, `tests/integration/scoring/profile.test.ts`

**Interfaces:**
- Single-account consumers (ordered by account): `intake.arrival.resolved`; `intake.arrival.rejected` with an `accountId` (Ruling 11); `accounts.account.created`, `.updated`, `accounts.fact.recorded`, `accounts.signal.recorded`, `accounts.person.added`, `.updated` (skipping events with `arrivalId`, Ruling 11); `accounts.account.exclusion_changed`; `accounts.account.merged` (score the survivor with warm intro and chains across both ids; delete the merged account's rows).
- Fan-out consumers:
  - `offers.offer.approved`: accounts in the offer's practice plus accounts with no practice.
  - `offers.offer.archived`, `.changed` with `affectsMatching`: accounts with an `offer_match` row for that offer, plus, when the offer stays approved, its practice and accounts with no practice.
  - `scoring.rules.changed`: every account.
  - `intake.source.trust_changed`: the source's accounts through `accountIdsForSource`.
  - Each enqueues `scoring.rescore.page` with a filter; pages enqueue `rescore.accounts`.
- `rescoreAccountsHandler`: profile and offers loaded once; one savepoint per account (Ruling 10).
- `ageingHandler`: pages `listAccountIds({ hasSignalSince: now − 365 days })`, keeps ids whose `account_score.computed_at` is older than 20 hours, enqueues `rescore.accounts`.
- `updateProfile(ctx, patch)`: validation and ranges (`The fit parts must add up to 100.`, `Fit and intent can't both have weight 0.`, range messages), `version + 1`, publishes `scoring.rules.changed`, audits before and after. `resetProfile(ctx)`. `requestRescore(ctx, { practiceId?, sourceId? })` returns the job id.

- [ ] **Step 1: Write failing tests.**
  - SCO-E5-S1-AC1 at the service level through `runOutbox`; a 5-item arrival scores once, not once per fact.
  - SCO-E5-S2-AC1: approving an offer rescores its practice and accounts with no practice; best-offer changes carry `previousBestOfferId`.
  - SCO-E5-S2-AC2 and Review Focus 2: archiving the best offer of 3 accounts (one with no practice, one with no other offer).
  - SCO-E5-S2-AC3: `trust_changed` (published with the test helper) rescores only that source's accounts.
  - SCO-E1-S1-AC2b: a practice change rescores.
  - SCO-E3-S1-AC4: a threshold change moves tiers after the jobs.
  - Ageing picks only eligible accounts; profile validation copy; merge scores the survivor and drops the merged rows; paging over 450 accounts enqueues 3 jobs.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): rescoring triggers, jobs and profile`.

### Task 9: Accounts summary from scoring events

**Files:**
- Modify: `src/modules/accounts/db/schema.ts` (+ migration: `score_version`, `review_version`, `owner_history_user_ids` with GIN, `review_flags text[]`, `has_open_assignment boolean`), `src/modules/accounts/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/accounts/score-summary.test.ts`

**Interfaces:**
- Consumer on `scoring.account.scored` (ordered by account, imports `@/modules/scoring/contracts/events` only): if `version > score_version`, write `priority`, `fit`, `intent`, `tier`, `best_offer_id`, `practice_id`, `score_version`; then `repickPrimary`.
- The routing columns are added now (one migration) and filled in Task 12.

- [ ] **Step 1: Write failing tests.** A scored event fills the columns and search by tier, priority at least and best offer matches; ACC-E1-S3-AC3 (a best-offer change re-picks the primary; a pinned primary stays); an older version published after a newer one is skipped (Review Focus 4, scoring part); a replay changes nothing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): summary and primary from scoring events`.

### Task 10: Scoring on /v1

**Files:**
- Create: `src/app/v1/accounts/[id]/score/route.ts`, `src/app/v1/accounts/[id]/score/history/route.ts`, `src/app/v1/accounts/[id]/matches/route.ts`, `src/app/v1/scoring/profile/route.ts`, `src/app/v1/scoring/profile/reset/route.ts` (`POST /v1/scoring/profile/reset`; a static path, since `idAndAction` needs a dynamic segment), `src/app/v1/rescore/route.ts`
- Test: `tests/integration/v1/scoring.test.ts`

**Interfaces:**
- `GET /v1/accounts/{id}/score` (`accounts:read`): the explanation plus `would_raise` and `summary`; `?offer_id=` explains a non-best match (priority = match total) and names the best offer (SCO-E4-S2-AC4); hidden or missing 404.
- `GET /v1/accounts/{id}/matches`; `GET /v1/accounts/{id}/score/history?limit` (default 10, max 50).
- `GET /v1/scoring/profile`, `PUT /v1/scoring/profile` (`scoring:manage`, 202), profile reset (`scoring:manage`).
- `POST /v1/rescore` (`scoring:manage`, `{ practice_id?, source_id? }`, 202 with `job_id`; progress is R2, Ruling 18).

- [ ] **Step 1: Write failing tests.** SCO-E4-S2-AC3 shape; the `offer_id` variant; Review Focus 5 (404 for hidden); history causes in words; PUT validation 400s and a 202 that changes tiers after jobs; reset; rescore 202; 403 without `scoring:manage`; the TEN-E3-S1-AC2 limit kinds on score, matches and history.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): /v1 score, matches, history, profile and rescore`.

### Task 11: Routing module schema, contracts, ports, stages and tenant defaults

**Files:**
- Create: `src/modules/routing/{index.ts,contracts/events.ts,contracts/jobs.ts,contracts/ports.ts,contracts/types.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`, `src/modules/routing/domain/{stages,working-days,status-rules}.ts`, `src/modules/routing/services/{stage,snapshot}.ts`, `drizzle/routing.config.ts`, `src/modules/intake/contracts/ports.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, `compose.ts`, `worker.ts`, `src/platform/ids.ts`, RLS catalog test (add `routing`), intake `services/sources.ts` (validate in `registerSource` and `updateSource`), intake test helpers (seed routing defaults)
- Test: `tests/unit/routing/{stages,working-days,status-rules}.test.ts`, `tests/integration/routing/{defaults,stage}.test.ts`

**Interfaces:**
- Tables from the REV index, each with `tenant_id`, plus `account_review.version int` and `account_review.flags` (`newFrom`, `declinedBySeller`), and `routing_setting` (`auto_accept_working_days` int null, default 2). Partial unique `assignment (tenant_id, account_id) where status in ('pending','accepted')`.
- Events: the REV index events, plus `routing.review.changed { accountId, version, snapshot }` (Ruling 1). The snapshot type is exported from `contracts/types.ts`.
- `publishReviewSnapshot(ctx, accountId)` (`services/snapshot.ts`): bumps `account_review.version` once, builds the snapshot from routing's rows (status key, current seller, past sellers from ended assignments, open assignment, stage, flags as `review_flags` strings `declined_by_seller` and `new_from`), publishes `routing.review.changed`. Every routing write calls it exactly once at its end.
- Jobs: `routing.assignments.auto_accept {}`.
- Ports: `OwnershipPreflight` (Ruling 4); routing implements intake's `ReviewStatusValidator { exists(ctx, key) }` (Ruling 5; with none registered, any key is accepted).
- Domain: `nextStage(current, event)` (REV-E4 table and Ruling 16; never moves backwards otherwise; `declined` + withdraw does nothing); `addWorkingDays(from, days, timezone)`; `statusChangeProblems(def, { note, reasonKey, reasonDefs })`.
- `moveStage(ctx, accountId, event, causeId)`: writes `stage_change` and publishes `routing.stage.changed` only on a real move; a repeat of the same `causeId` is ignored.
- Consumer `routing.tenant_defaults`: statuses, both decline reason lists, the setting row and the hourly schedule. `seedRoutingDefaults(ctx)`.

- [ ] **Step 1: Write failing tests.** Every stage transition including the returns, a late `assigned` after `declined` doing nothing, and `declined` + withdraw doing nothing; working days across a weekend and the 1 November 2026 change in `America/New_York`; status problems; defaults once; RLS; `moveStage` twice with the same cause moves once; `publishReviewSnapshot` bumps the version by one per call; intake refuses `initial_review_status_key: 'nope'` with `Pick a review status from your list.` once routing is registered, and accepts it with none.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls`, `platform/migrate` and `intake`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): schema, contracts, ports, stages and tenant defaults`.

### Task 12: Accounts summary from the review snapshot, and queue search

**Files:**
- Modify: `src/modules/accounts/consumers.ts`, `src/modules/accounts/services/{visibility,search}.ts`, `src/modules/accounts/index.ts`, `src/entry/worker.ts`
- Test: `tests/integration/accounts/review-summary.test.ts`, `tests/integration/accounts/search.test.ts`

**Interfaces:**
- Consumer on `routing.review.changed` (ordered by account, imports `@/modules/routing/contracts/{events,types}` only): when `version > review_version`, overwrite `review_status_key`, `owner_user_id`, `owner_history_user_ids`, `has_open_assignment`, `stage`, `review_flags`, `review_version`.
- Visibility: `own_accounts` also matches `owner_history_user_ids` (Ruling 3).
- Search gains (Ruling 8): `reviewStatusKeys`, `arrivedSince`, `accountIds` (at most 1,000), `reviewFlags`, `queueDefault` (Ruling 15: no open assignment and (status not counting as reviewed, given as `unreviewedStatusKeys`, or flag `declined_by_seller`)); and `countAccounts(ctx, query)` with the same filters and data limits.

- [ ] **Step 1: Write failing tests.** A snapshot fills every column; Review Focus 4, summary part: snapshots with versions 3, 5 and 4 delivered in that order leave version 5's owner, and a replay changes nothing; a seller limited to `own_accounts` still sees an account in their owner history; each new search filter; `queueDefault` includes an unreviewed account and a reviewed account flagged `declined_by_seller`, and excludes one with an open assignment; `countAccounts` respects a practices limit.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): summary from the review snapshot, queue search filters and counts`.

### Task 13: Review statuses, insights, queue and assignment

**Files:**
- Create: `src/modules/routing/services/{review,queue,assign}.ts`
- Modify: `src/modules/routing/consumers.ts`, `src/modules/routing/index.ts`
- Test: `tests/integration/routing/{review,queue,assign}.test.ts`

**Interfaces:**
- Consumers: `intake.arrival.resolved` (create the review row with Ruling 5's status and stage `arrived` when none, then `publishReviewSnapshot`; when an assignment is open, set `flags.newFrom` and publish the snapshot, Ruling 7); `accounts.account.merged` (the survivor keeps its review row; the merged account's open assignment moves over when the survivor has none, else becomes `withdrawn` and is published; history rows re-pointed; the merged account's review row is kept read-only with `merged_into` set and no open assignment; a snapshot for both accounts). Review rows are created with insert-or-nothing then the row lock, so the backfill and the arrival consumer can't both create one.
- Every write service a route calls: needs a person, checks the account is visible through accounts `filterVisibleAccountIds` (hidden 404), locks the review row, ends with `publishReviewSnapshot`.
- `changeStatus(ctx, accountId, { to, note?, reasonKey? })`: `statusChangeProblems`; reopening a declined account needs a note and goes to `needs_review`; a declined status first withdraws an open assignment, then moves status and stage (Ruling 14); writes `status_change` and publishes `routing.status.changed`.
- `setInsights(ctx, accountId, text)`.
- `listQueue(ctx, filters)` on accounts `search` (Ruling 8: status, practice, offer, source at any level, batch through intake's batch account ids, tier, flag, arrived date, and `queueDefault` when no status filter is given), sorted priority desc then newest; insights and flag details hydrated for the page. `countQueue(ctx, filters)` on `countAccounts` (REV-E1-S1-AC4).
- `assign(ctx, accountId, { sellerUserId, notes?, leadOfferId?, ownershipDecision? })`: the seller is an active member with `assignments:respond`; a declined account is refused (Ruling 14); "Approve and assign" moves an unreviewed status to the first counts-as-reviewed, not declined status; runs the preflight (`stop` without `keep` is a 409 with its message); replaces an open assignment (`replaced`, publishes `withdrawn` then `created`); clears `flags.declinedBySeller`; stores the lead offer override; publishes `routing.assignment.created` with `templateId: null`; one snapshot at the end.
- `previewAssign(ctx, accountId, sellerUserId)`; `bulk(ctx, accountIds ≤ 50, action)` (one savepoint per account, accounts locked in id order).

- [ ] **Step 1: Write failing tests.**
  - REV-E1-S1-AC1: an agent arrival resolves and the account appears in the queue as Unvetted after `runOutbox` (the snapshot reaches accounts).
  - REV-E1-S1-AC2: each filter, including batch, flag and arrived date; AC4: a practices-limited reviewer sees only P in the queue and the count.
  - REV-E1-S2-AC1 to AC3 copy; reopen needs a note. REV-E1-S3-AC1 insights.
  - REV-E2-S1-AC1 Approve and assign from Unvetted (status and owner both land in the summary); AC2 a stub preflight returning stop; AC3 bulk of 3, and 51 is a 400.
  - Ruling 14: assigning a declined account is a 409; declining with an open assignment withdraws it and the stage ends at `declined`.
  - Review Focus 3: two concurrent assigns give one open assignment.
  - Ruling 7 `newFrom` (in the summary flags); an invited seller can't be assigned; a hidden account is 404 on every write.
  - Merge: the survivor keeps its row and gets the moved assignment's owner in its summary, or the merged assignment is withdrawn.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): review statuses, insights, queue and assignment`.

### Task 14: Accept, decline, withdraw and auto-accept

**Files:**
- Create: `src/modules/routing/services/respond.ts`
- Modify: `src/modules/routing/jobs.ts`, `src/modules/routing/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/routing/respond.test.ts`

**Interfaces:**
- `accept(ctx, assignmentId)`: the actor must be the assignment's seller (Ruling 17; else 404); pending only; `accepted_how: 'seller'`; stage `assigned`.
- `decline(ctx, assignmentId, { reasonKey, note? })`: the actor must be the seller; reason from the assignment list; Other needs a note; status unchanged; stage `reviewed`; `flags.declinedBySeller = { sellerName, reasonLabel }`.
- `withdraw(ctx, assignmentId, { reassignTo? })`: the assigner or an owner, with visibility of the account; stage `reviewed` (Ruling 16); publishes `withdrawn` then `created` when reassigning.
- `autoAccept(ctx, now)` (Ruling 6): locks each review row, re-checks `pending`, accepts with `auto_timeout`, moves the stage; the handler calls it with `new Date()`.
- `markSeen(ctx, accountId)`: the actor must be the open assignment's seller.
- Consumer on `tenancy.member.removed`: that seller's open assignments become `withdrawn`.
- Each write locks the review row and ends with `publishReviewSnapshot`.

- [ ] **Step 1: Write failing tests.** REV-E2-S2-AC3 with fixed `now` (3 working days accepts; Friday afternoon still pending on Monday morning; off when null; at most 500 per run); REV-E2-S3-AC1, AC2; Ruling 15 (an account a seller declined is back in the default queue with the flag); a seller limited to `own_accounts` can accept right after assignment, before any consumer runs (Ruling 17); Review Focus 4 (a late `accept` after a decline is refused; a decline racing auto-accept ends in exactly one outcome); another seller gets 404; withdraw and reassign order; member removal; `markSeen` only by the seller.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): accept, decline, withdraw and auto-accept`.

### Task 15: Account status and assignment lists

**Files:**
- Create: `src/modules/routing/services/read.ts`
- Test: `tests/integration/routing/status.test.ts`

**Interfaces:**
- `getAccountStatus(ctx, idOrArrivalId)`: an `arr_` id resolves through intake's `accountForArrival` (limited to the caller's arrivals); returns `accountId`, `name`, `stage`, `reviewStatus`, `tier`, `ownerName`, `lastActivityAt` (null until R1c), `declinedReason`, `sendBackNote`, `summary` (`Assigned to Ash on Oct 22.`); hidden is null.
- `listAssignments(ctx, { mine?, status?, accountId?, cursor, limit })` (sellers see their own; with `accountId`, visibility of the account is required; each with `acceptedHow`).

- [ ] **Step 1: Write failing tests.** REV-E4-S2-AC1 shape; AC2 by arrival id limited to the caller's source; AC3 hidden is null; AC4 declined reason and send-back note; REV-E2-S2-AC1 a seller lists their pending assignments; REV-E2-S2-AC3 the leader sees how each was accepted.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): account status and assignment lists`.

### Task 16: Routing on /v1

**Files:**
- Create: `src/app/v1/review-queue/route.ts`, `src/app/v1/review-queue/count/route.ts`, `src/app/v1/review-queue/bulk/route.ts`, `src/app/v1/accounts/[id]/review-status/route.ts`, `src/app/v1/accounts/[id]/insights/route.ts`, `src/app/v1/accounts/[id]/status/route.ts`, `src/app/v1/accounts/[id]/assignments/route.ts`, `src/app/v1/assignments/route.ts`, `src/app/v1/assignments/[id]/route.ts`, `src/app/v1/settings/review/route.ts`; extend `src/app/v1/accounts/[id]/route.ts` with `:assign`, `:assign-preview`, `:seen`
- Test: `tests/integration/v1/routing.test.ts`

**Interfaces:**
- The REV index endpoints and scopes, plus: `GET /v1/review-queue/count`; `POST /v1/review-queue/bulk` (`review:act`, and `assign:act` checked in the handler when the action is assign); `POST /v1/accounts/{id}:assign-preview` (`assign:act`); `POST /v1/accounts/{id}:seen` (people only); `GET /v1/assignments?mine&status` (`assignments:respond`); `GET /v1/accounts/{id}/assignments` (`assign:act`); `GET /v1/settings/review` (`settings:manage`: statuses, decline reasons, auto-accept); `PUT /v1/settings/review` updates only `auto_accept_working_days` in R1b.
- `GET /v1/accounts/{id}/status` (`status:read`) accepts an `arr_` id as `{id}`.
- Assign returns 202; accept, decline and withdraw return the assignment; assign, decline, withdraw, status changes and insights are people only.

- [ ] **Step 1: Write failing tests.** REV-E1-S1-AC3 (a seller gets 403 on the queue); queue shape, paging and count; copy as 400s; assign 202 and its event; wrong seller 404; status by account id and by arrival id; Review Focus 5 (another source's account or arrival is 404); the TEN-E3-S1-AC2 limit kinds on the queue, count and status; settings read and the auto-accept update.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): /v1 review queue, status, assignments and settings`.

### Task 17: Source feedback and stage counts

**Files:**
- Create: `src/modules/intake/services/feedback.ts`, intake schema `source_feedback` (+ migration), `src/app/v1/feedback/route.ts`
- Modify: `src/modules/intake/consumers.ts`, `src/modules/intake/services/status.ts`, `src/modules/intake/contracts/events.ts` (`intake.feedback.recorded` kinds gain `sent_back`, data gains `reasonKey`), `src/platform/ids.ts`, `src/app/v1/arrivals/[id]/route.ts`, `src/app/v1/batches/[id]/route.ts`
- Test: `tests/integration/intake/feedback.test.ts`, `tests/integration/v1/feedback.test.ts`

**Interfaces:**
- Consumers (`@/modules/routing/contracts/events` only): `routing.status.changed` to a declined status gives `declined_at_review`, to a `returns_to_source` status gives `sent_back` (with the note), `routing.assignment.declined` gives `declined_by_seller`. A row for every source in the chains of arrivals that resolved to the account; unique on (source, arrival, kind, cause event id); each publishes `intake.feedback.recorded`.
- `GET /v1/arrivals/{id}` gains `stage`, `review_status`, `owner_name` (owner name needs `status:read`) and `feedback[]` (Ruling 9: accounts `getSummaries` and tenancy `members`); `GET /v1/batches/{id}` gains `counts_by_stage`.
- `GET /v1/feedback?since&cursor` (`arrivals:read`): the principal's own source and its children; for a person, their person source.

- [ ] **Step 1: Write failing tests.** SRC-E1-S4-AC1 for decline at review, send back and seller decline (every source in the chain); AC2 own source only and Review Focus 5; SRC-E2-S3-AC1 counts by stage; arrival detail fields; replays add nothing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): source feedback and stage counts`.

### Task 18: Backfill, seed, one-path to assignment and docs

**Files:**
- Modify: `src/entry/seed.ts`, `src/entry/cli.ts` (`scout backfill-r1b <tenant-slug>`), `README.md`, `docs/CHANGELOG.md`, `docs/spec/migration-and-rollout/release-plan.md` (R1b progress, including the SCO-E5-S4-AC1 progress gap moved to R2), `docs/spec/architecture/event-catalog.md` (new events, jobs and fields: `version`, `arrivalId`, `trust_changed` consumers, feedback kinds), `docs/spec/architecture/module-boundaries.md` (`ReviewStatusValidator`, `OwnershipPreflight`), `docs/spec/architecture/data-conventions.md` (id prefixes), `docs/spec/scoring-and-matching/index.md`, `docs/spec/review-and-routing/index.md` (`routing.review.changed` and its snapshot), `docs/spec/review-and-routing/stage-tracking-and-status.md` (Ruling 16), `docs/spec/sources-and-intake/index.md`, `docs/spec/accounts/index.md` (columns and calls added by the rulings)
- Test: `tests/integration/routing/one-path.test.ts`, `tests/integration/entry/cli.test.ts`

**Interfaces:**
- `backfillR1b(ctx)`: for accounts with no review row, create one through routing (status from the first resolved arrival's `initialReviewStatusKey`, else `unvetted`; stage `arrived`; a review snapshot published, so the account reaches the queue) and enqueue `scoring.rescore.page` for all accounts. Idempotent. Seed calls it for each tenant after the scoring and routing defaults and signal rules.
- R1b exit: an agent sends an account; it is scored and explained; it shows in the queue as Unvetted with its priority; a leader approves and assigns; the seller accepts; the agent reads the status as assigned with the owner's name; the stage history shows arrived, reviewed, assigned.

- [ ] **Step 1: Write failing tests.** The exit path end to end through services and `runOutbox`; the backfill gives R1a-style accounts a review row and a score, and running it twice changes nothing; seed twice leaves one profile, one set of statuses and the signal rules.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run typecheck && npm run lint && npm test && npm run e2e && npm run build`. Expected: PASS. Then the laptop smoke run: seed, start the background roles and web, send the Miami-Dade arrival with the dev key, read `GET /v1/accounts/{id}/score` and `/status`, stop exactly the processes started.
- [ ] **Step 5:** Commit `feat: R1b backfill, seed, one-path test and docs`.
