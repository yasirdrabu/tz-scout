# Taazaa Scout R1b Scoring and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every account intake creates is scored against the approved offers it could buy, explained line by line, put in a review queue with a status, and reviewed, sent back, declined or assigned to a seller who accepts or declines. Every move is tracked as a stage that people and agents can read.

**Architecture:** Two new modules on R1a: Scoring and matching (`scoring` schema) and Review and routing (`routing` schema). Offers gains signal rules. Scoring is driven by events from accounts, intake and offers, and computes everything with pure domain functions ported from v1. Routing owns review statuses, assignments and stages, and reaches the CRM only through a port that R1c will implement. Accounts and intake keep their read models (account summary, source feedback, account status) current by consuming the new events.

**Tech Stack:** As R1a. No new dependencies.

**Spec:** `docs/spec/scoring-and-matching/` (SCO-E1, E2 without revenue potential, E3, E4, E5 without the weights editor screen), `docs/spec/review-and-routing/` (REV-E1 with default statuses, E2, E3 preflight through a port, E4 stages that don't need the CRM), `docs/spec/offers-and-practices/signal-rules.md` (OFF-E4-S1, S2), `docs/spec/sources-and-intake/source-registry-and-trust.md` (SRC-E1-S4 feedback), `docs/spec/sources-and-intake/arrivals-and-batches.md` (SRC-E2-S3-AC1 stage counts), `docs/spec/sources-and-intake/resolve-pipeline-and-duplicates.md` (SRC-E3-S4-AC1), `docs/spec/accounts/` (ACC-E1-S3-AC3, ACC-E8 columns, own_accounts past owners), `docs/spec/tenancy-and-access/roles-and-data-scopes.md`, `docs/spec/architecture/*`. v1 reference code at commit `c3c2124` (`src/lib/matching.ts`, `src/lib/signalRules.ts`, `tests/unit/matching.test.ts`).

## Scope

In: the two modules, offer signal rules, their events and jobs, every service behind a `/v1` endpoint (agent endpoints from the spec, plus people-only endpoints the front end will call), tenant defaults, read-model updates in accounts and intake, seed data.

Out, by owner plan:
- **R1c:** a real ownership preflight (`OwnershipPreflight` port implemented by CRM), the "no CRM owner set" block, implied acceptance from CRM activity, stages `engaged`, `opportunity`, `won`, `lost`, handoff status on the tracker, notifying the assigner of a failed handoff, `crm_status` exclusions.
- **R1d:** MCP tools (`explain_score`, `get_account_status`, `list_my_submissions`).
- **R2:** revenue potential (SCO-E2-S4), the weights editor screen and its preview (SCO-E5-S3 screen; the API to read and update the profile is in R1b), configurable review statuses and decline reasons (REV-E1-S4), the playbook picker (`templateId` is always null), conflicts flags, enrichment flags, signal rules suggested by wins.
- **Front end:** every screen. In-app notifications (REV-E2-S2-AC1, REV-E2-S4-AC1 "notifies") wait for a notifications module; the events they would come from are published here.

## Design

| Aggregate | Owner | Invariants it guards | Consistency boundary |
|---|---|---|---|
| Account score (account_score, offer_match rows, score_change) | Scoring | One current score per account; matches only for approved offers; best offer is never archived or draft; a rescore with an unchanged input hash on the same day writes nothing and publishes nothing; every change writes one `score_change` | Scoring per account is serialised with an advisory lock on `scoring:<account>`; consumers are `orderedBy` account |
| Scoring profile | Scoring | Fit part maxes add up to 100; weights not both 0; every change bumps `version` | Single-row write |
| Account review (account_review, status_change, assignment, stage_change) | Routing | Exactly one review row per account; at most one open (pending or accepted) assignment; assigning requires a status that counts as reviewed; stages move forward except the listed returns; every move writes one history row | Row lock on `account_review` (`select … for update`) on every write |
| Signal rules | Offers | Points 0 to 100; "why" required; a change publishes `offers.offer.changed` with `affectsMatching: true` | The offer row |
| Source feedback, account status read model | Intake | One feedback row per (source, arrival, kind, cause event); read model reflects the latest routing event | Consumers with `processed_event` guard |

Layers as in R1a: `domain/` pure (all scoring math, tiers, floors, explanation building, stage transitions, working-day maths), `services/` transaction scripts, `contracts/` (events, DTO types, ports), `db/`, `index.ts` facade. Scoring reads other modules only through their public interfaces: accounts `getAccountForScoring`, offers `listApprovedOffersWithRules`, and intake `getWarmIntro`, `getTrust(ctx, chain)` and `sourcesForAccount` (scoring depends on intake in the dependency graph, so it calls intake directly rather than through accounts' port).

Dependency direction: offers ← accounts ← intake ← scoring ← routing (routing also reads scoring and accounts). Lower modules learn about higher ones only by consuming their events through `contracts/events.ts` (the published language) and through ports they define.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **Accounts consumes `scoring.account.scored` and the routing events** to fill `account_summary`'s scoring, review, owner and stage columns, as the ACC index lists. It imports only those modules' `contracts/events.ts`. Search may lag the event by a few seconds; that is accepted.
2. **The primary contact is re-picked in that same accounts consumer** (ACC-E1-S3-AC3): it reads the best offer's target titles through offers' public `getOffer` (accounts may call offers).
3. **`own_accounts` covers current and past owners from R1b**: `account_summary` gains `owner_history_user_ids text[]`, appended when an assignment ends (declined, withdrawn, replaced). Visibility adds it.
4. **The ownership preflight is a port** `OwnershipPreflight` defined in `routing/contracts/ports.ts`. Default (until R1c registers CRM's): `{ result: 'new', message: 'New in the CRM' }`, which allows assignment.
5. **Initial review status comes from the arrival** (`intake.arrival.resolved.initialReviewStatusKey`) when it names an active status in the tenant, else the default by source kind (agents, vendors, partners: `unvetted`; people, imports, CRM, forms: `needs_review`). Intake validates a source's `initial_review_status_key` against routing through a port `ReviewStatusValidator` defined in `intake/contracts/ports.ts` (intake may not import routing); routing implements it.
6. **Auto-acceptance after 2 working days** is a per-tenant schedule (`routing.assignments.auto_accept`, hourly) created by routing's tenant-defaults consumer and by seed. Working days are Monday to Friday in the tenant's timezone; public holidays are ignored in R1b. The day count is a tenant setting in `routing_setting` (1 to 10, or off), default 2.
7. **"New from <source>" on an assigned account** (SRC-E3-S4-AC1) is `account_review.flags.newFrom = { sourceId, at }`, set by routing when a resolved arrival attaches to an account that has an open assignment, and cleared by `POST /v1/accounts/{id}:seen` from the assigned seller.
8. **The low-trust flag** is set when the account's effective trust from scoring is below 0.4, using the `trust` value on `scoring.account.scored` (added to the event data, optional field, compatible change).
9. **Stage counts on batches** (SRC-E2-S3-AC1) and the stage, review status and owner name on `GET /v1/arrivals/{id}` come from an intake read model `intake.account_status` (`tenant_id`, `account_id`, `stage`, `review_status_key`, `owner_user_id`, `owner_name`, `updated_at`) fed by routing's events. The owner's display name is carried on `routing.assignment.created` / `.accepted` as an optional `sellerName` field.
10. **Scoring writes all of an account's matches, its score and its history in one transaction**, after taking `pg_advisory_xact_lock(hashtext(tenant || ':scoring:' || accountId))`. A tenant-wide rescore is jobs of 500 account ids, each account in its own transaction inside the job (one failing account does not undo the others; the job reports and dead-letters only on infrastructure errors).
11. **Revenue potential is left null** in R1b (`revenue_potential_cents`, `revenue_band` columns exist, nullable) so R2 adds no migration.
12. **`PUT /v1/scoring/profile` is in R1b** (owners, `scoring:manage`), with the SCO-E5-S3-AC4 validation and the audit entry; only the screen and its preview wait for R2.

## Global Constraints

- Everything in R1a's Global Constraints holds: every table in `scoring` and `routing` has `tenant_id` and forced RLS; module imports only through `index.ts` or `contracts/*`; prefixed ULIDs; snake_case JSON; problem+json errors; no em dashes in copy; every POST/PUT/PATCH through `v1Route` with bounded bodies and idempotency.
- New schemas `scoring` and `routing`: bootstrap grants and default privileges, `MODULE_ORDER` (`platform, tenancy, integrations, ai, offers, accounts, intake, scoring, routing`) and the migrate test's order, `drizzle/<schema>.config.ts`, Dockerfile `COPY`, RLS catalog test, `src/entry/registry.ts`, and `src/entry/compose.ts` for port registrations.
- New id prefixes: `om_` (offer match), `scc_` (score change), `sr_` (signal rule), `rsd_` (review status def), `sc_` (status change), `asg_` (assignment, already listed in data conventions), `stc_` (stage change), `fb_` (source feedback).
- Scoring defaults (`scoring_profile`): `fit_weight` 0.55, `intent_weight` 0.45, fit part maxes industry 30, size 25, revenue 20, region 10, buyer 15, `half_life_days` 45, `max_signal_age_days` 365, tier thresholds (not a fit: fit < 40; act now: fit ≥ 60, intent ≥ 35, total ≥ 60, at least one research or trigger hit; good fit: fit ≥ 60), `warm_intro_cap` 20, `trust_modifier_max` 5, `trust_neutral` 0.6, `research_floor_days` 180.
- Scoring math exactly as SCO-E1 to E3: hard-miss cap 45; total capped at fit when fit < 50; recency `0.5 ^ (age / half-life)`, 0 past 365 days, 1 for tech, growth and workforce; research intensity `(score − 0.40) / 0.40` clamped 0 to 1; rule factor strongest + 30% second + 15% third, capped 1, research rules strongest only; rule points rounded to one decimal; intent capped 100 and rounded; `trust_modifier = clamp(round((trust − 0.6) × 25), −5, 5)`; priority clamped 0 to 100; not-a-fit accounts get no warm or trust adjustment.
- Domain functions take `now` as an argument; tests never depend on the clock.
- Default review statuses: `unvetted` (Unvetted), `needs_review` (Needs review), `reviewed` (Reviewed, counts as reviewed), `declined` (Declined, counts as reviewed, declined). Default decline reasons for review: Not a fit, Already a customer, Open deal elsewhere, Duplicate, Bad data, Wrong timing, Other (note required). For assignments: Not my territory, Too much on my plate, Already talking to them, Not a fit, Other (note required).
- Copy (exact): `Pick a reason`, `Say what the source should fix`, `Add a note for Other.` Assigning an account that hasn't been reviewed is never refused: Approve and assign moves it to the first counts-as-reviewed status in the same action.
- Stages: `arrived`, `reviewed`, `assigned`, `engaged`, `opportunity`, `won`; exits `lost`, `declined`. R1b moves `arrived`, `reviewed`, `assigned`, `declined` and the returns (assignment declined or withdrawn back to `reviewed`; reopened back to `arrived`).

## Review Focus

1. **The same account is rescored by several events at once** (a batch arrival plus its facts plus a trust change). Expected: one consistent score, one `score_change` per real change, no lost update. Test in Task 6.
2. **An offer is archived while it is the best offer of many accounts.** Expected: no account keeps an archived best offer after the rescore jobs finish, and accounts with no other approved offer get no best offer and tier `not_fit` with a reason, not an error. Test in Task 7.
3. **Two leaders assign the same account at the same moment.** Expected: one open assignment, the other replaced (or refused), both recorded. Test in Task 11.
4. **A seller declines, and a stale event (an old acceptance or an arrival) arrives after.** Expected: the account stays back with the leader at `reviewed`, the stage never jumps forward from a replayed or late event. Test in Task 12.
5. **An agent asks for the status or score of an account outside its data limit, or by an arrival id that isn't its own.** Expected: not found, never forbidden. Tests in Tasks 9 and 14.

---

## File Structure

```
src/modules/offers/                 + db signal_rule table, services/signal-rules.ts, defaults signal rules
src/modules/scoring/
  index.ts contracts/{events,jobs,types}.ts db/schema.ts db/migrations/
  domain/{fit,intent,combine,tiers,best-offer,priority,explain,inputs-hash}.ts
  services/{profile,score,rescore,read}.ts jobs.ts consumers.ts defaults.ts
src/modules/routing/
  index.ts contracts/{events,jobs,ports,types}.ts db/schema.ts db/migrations/
  domain/{stages,working-days,statuses}.ts
  services/{review,status,assign,respond,stage,queue,settings,read}.ts jobs.ts consumers.ts defaults.ts
src/modules/accounts/consumers.ts   + scoring and routing consumers for account_summary and primary
src/modules/intake/                 + services/feedback.ts, account-status read model, consumers, ReviewStatusValidator port
src/app/v1/                         scoring, review-queue, assignments, accounts/{id}/{score,matches,status,...}, feedback, offers/{id}/signal-rules
```

---

### Task 1: Signal rules in Offers

**Files:**
- Create: `src/modules/offers/services/signal-rules.ts`, `src/modules/offers/domain/signal-rules.ts` (validation), defaults for signal rules in `src/modules/offers/defaults.ts`, a drizzle-generated offers migration
- Modify: `src/modules/offers/db/schema.ts`, `src/modules/offers/index.ts`, `src/entry/seed.ts`, `src/app/v1/offers/[id]/route.ts` (or a new `signal-rules` route)
- Test: `tests/unit/offers/signal-rules.test.ts`, `tests/integration/offers/signal-rules.test.ts`, `tests/integration/v1/signal-rules.test.ts`

**Interfaces:**
- Table `signal_rule` (fields in the OFF index: `id` `sr_`, `tenant_id`, `offer_id`, `type`, `label`, `weight` 0 to 100, `match` text[], `min_value`, `why`, `enabled`, `origin`, plus `sort`).
- `DEFAULT_SIGNAL_RULES` (per offer slug) and `GENERIC_SIGNAL_RULES` ported from `c3c2124:src/lib/signalRules.ts`.
- Services:
  - `listSignalRules(ctx, offerId)`.
  - `replaceSignalRules(ctx, offerId, rules)`: replaces the set (`scoring:manage` enforced at the route), validates (`signalRuleProblems`: points 0 to 100, `Add why this signal matters.` when `why` is empty, type is one of the nine types), publishes `offers.offer.changed` with `changed: ['signal_rules']` and `affectsMatching: true`, audits.
  - `resetSignalRules(ctx, offerId)`: restores the seeded set for the offer's slug, or the generic set.
  - `listApprovedOffersWithRules(ctx, { practiceIds?: string[] })`: approved offers (all practices when the list is empty or absent) with their fit criteria and enabled signal rules, ordered by `approved_at` then id.
- Seed: every Taazaa offer gets its default rules (idempotent).
- Routes: `GET /v1/offers/{id}/signal-rules` (`offers:read`), `PUT /v1/offers/{id}/signal-rules` (`scoring:manage`), `POST /v1/offers/{id}/signal-rules:reset` (`scoring:manage`).

- [ ] **Step 1: Write failing tests.**
  - Unit: each validation message; a rule with weight 101 is refused.
  - Integration:
    - OFF-E4-S1-AC0: replacing rules needs `scoring:manage` (route test, 403 without it).
    - OFF-E4-S1-AC2: replacing publishes `offers.offer.changed` with `affectsMatching: true`.
    - OFF-E4-S1-AC3: reset restores the seeded set for `modernization-blueprint`; an offer with no defaults gets the generic set.
    - OFF-E4-S1-AC4: an empty `why` is refused.
    - `listApprovedOffersWithRules` leaves out drafts, archived offers and disabled rules, and orders by approval.
    - Seed twice gives the same rule count.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): signal rules per offer`.

### Task 2: Scoring module schema, contracts and tenant defaults

**Files:**
- Create: `src/modules/scoring/{index.ts,contracts/events.ts,contracts/jobs.ts,contracts/types.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`, `drizzle/scoring.config.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, `src/platform/ids.ts`, `src/entry/worker.ts`, RLS catalog test (add `scoring` and `routing` to the strict schemas)
- Test: `tests/integration/scoring/defaults.test.ts`

**Interfaces:**
- Tables `scoring_profile`, `offer_match`, `account_score`, `score_change` with the SCO index fields, each with `tenant_id`. `account_score` also stores `trust_source_id` (the source whose trust counted) and nullable `revenue_potential_cents`, `revenue_band` (Ruling 11). Unique `offer_match (tenant_id, account_id, offer_id)`; index `score_change (tenant_id, account_id, at desc)`.
- Events: `scoring.account.scored` (index data plus optional `trust`), `scoring.rules.changed`.
- Jobs: `scoring.rescore.accounts { accountIds: string[] (1 to 500), cause }`, `scoring.rescore.tenant { filter?: { practiceId?, sourceId? }, cause, cursor? }` (pages account ids and enqueues `rescore.accounts` messages), `scoring.ageing {}`.
- Consumer `scoring.tenant_defaults` on `tenancy.tenant.created`: inserts the default profile and the nightly ageing schedule (02:00 UTC). `seedScoringDefaults(ctx)` for seed.

- [ ] **Step 1: Write failing tests.** The consumer creates one profile with the Global Constraints defaults and the schedule; a second run changes nothing; RLS isolation.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls` and `platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): schema, contracts and tenant defaults`.

### Task 3: Fit, intent and match total (pure)

**Files:**
- Create: `src/modules/scoring/domain/{fit,intent,combine}.ts`
- Test: `tests/unit/scoring/{fit,intent,combine}.test.ts`

**Interfaces:**
- Inputs are plain types in `contracts/types.ts`: `ScoringAccount` (industry, industryKey, employees, revenueCents, country, technologies, headcountGrowth6m, domain, excluded flags, people `{ title, roleKeys }[]`), `ScoringSignal` (`id, type | null, kind, title, detail, value, occurredAt`), `ScoringOffer` (fit criteria, `targetTitles`, `targetBuyingRoles`, `excludedDomains`, `excludedCategories`, rules), `ScoringProfile`.
- `fit(account, offer, profile): { fit: number; parts: FitPart[]; disqualifiedReason: string | null }` with the SCO-E1 part table, loose industry match (port `industryMatches` and `titleMatches` from `c3c2124:src/lib/matching.ts`), US aliases, exclusions first, hard-miss cap 45, part maxes from the profile. Each part has a plain `text` reason.
- `intent(signals, technologies, headcountGrowth, offer.rules, profile, now): { intent: number; hits: RuleHit[] }` with the SCO-E1 recency, intensity, rule factor and rounding rules; keywords of three letters or fewer match whole words only; tech rules also match the technology list; growth and workforce rules match current values with `min_value`.
- `matchTotal(fit, intent, profile): number`.

- [ ] **Step 1: Write failing tests.**
  - SCO-E1-S1-AC4, AC5; SCO-E1-S2-AC1 to AC5; SCO-E1-S3-AC1 (62), AC2 (45).
  - SCO-E1-S4-AC1: Worked examples A (fit 100, intent 22, total 65), B (fit 45, total 45), C (intent 26, total 50) exactly; port every still-applicable case from `c3c2124:tests/unit/matching.test.ts`.
  - SCO-E1-S4-AC2: every function takes `now`.
  - A keyword `AI` matches "AI strategy" but not "paid"; a keyword `cloud` matches "Cloud migration".
- [ ] **Step 2:** Run `npm run test:unit -- scoring`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): fit, intent and match total`.

### Task 4: Tiers, best offer, floors and priority (pure)

**Files:**
- Create: `src/modules/scoring/domain/{tiers,best-offer,priority}.ts`
- Test: `tests/unit/scoring/{tiers,best-offer,priority}.test.ts`

**Interfaces:**
- `tierFor(match: { fit; intent; total; disqualifiedReason; hasResearchOrTrigger }, profile): Tier`.
- `bestOffer(matches, approvedOrder: string[]): Match | null` (highest total, then tier order, then fit, then approved first).
- `applyFloors(computed: Tier, input: { disqualified: boolean; researchTier: 'A'|'B'|'C'|null; researchSignalAt: Date | null; warmIntro: boolean; bestFit: number }, profile, now): { tier; tierReason: 'computed'|'research_floor'|'warm_intro_floor'; text?: string }`.
- `priority({ matchTotal, tier, warmPoints, trust }, profile): { priority; warmPoints; trustModifier }`.

- [ ] **Step 1: Write failing tests.** SCO-E3-S1-AC1 to AC4; SCO-E3-S2-AC1; SCO-E3-S3-AC1 to AC5 (including the copy `Researcher rated A with a signal from <date>: act now`); SCO-E2-S1-AC2 (76), AC3 (100), AC4; SCO-E2-S3-AC1 (0.6 → 0, 0.8 → +5, 0.4 → −5, 1.0 → +5, 0.0 → −5).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): tiers, best offer, floors and priority`.

### Task 5: Explanation and inputs hash (pure)

**Files:**
- Create: `src/modules/scoring/domain/{explain,inputs-hash}.ts`
- Test: `tests/unit/scoring/{explain,inputs-hash}.test.ts`

**Interfaces:**
- `buildExplanation({ best, otherMatches, priority, floors, warm, trust, profile, now }): Explanation` with the exact shape in SCO-E4 (camelCase), lines grouped fit, intent, combine, adjust; intent lines carry `kind` and `signalIds`; `missing` lists unknown inputs with the most points they could change ("Revenue unknown: adding it could change fit by up to 10 points."); adjust lines `Warm intro from <name>: +<n>` and `Source trust <0.72> (<source name>): +<n>`.
- `wouldRaise(explanation, offer, account): string[]` (missing items as short phrases, up to two unmet rules with the most points, missing target buying roles: `A technical buyer on file`).
- `summarySentence(explanation): string` (SCO-E4-S2-AC2 style; plain words, no em dashes).
- `inputsHash(inputs): string` (sha256 of a canonical JSON of everything except `now`).

- [ ] **Step 1: Write failing tests.** SCO-E4-S1-AC1: for worked examples A to C, fit lines × weight plus intent lines × weight plus adjustments equal the priority within 1 point. The `missing` list for an account with unknown revenue and region. The summary for example A with a warm intro. The hash ignores `now` and key order, and changes when one fact changes.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): explanations and inputs hash`.

### Task 6: Score one account

**Files:**
- Create: `src/modules/scoring/services/{profile,score}.ts`
- Modify: `src/modules/scoring/index.ts`, intake's index if `getWarmIntro` / `getTrust` / `sourcesForAccount` / source names aren't exported
- Test: `tests/integration/scoring/score.test.ts`

**Interfaces:**
- `getProfile(ctx)`.
- `scoreAccount(ctx, accountId, cause: ScoreCause, causeEventId?: string): Promise<{ changed: boolean; score: AccountScoreView | null }>`:
  1. Lock (Ruling 10).
  2. Load `getAccountForScoring` (accounts), approved offers with rules for the account's practices (all when empty), warm intro and introducer name, and the highest effective trust among `sourcesForAccount` chains (intake) with that source's name.
  3. Compute every match with Tasks 3 to 5; pick the best; apply floors and priority; build the explanation.
  4. If `inputsHash` and the computed day equal the stored ones, return `changed: false` and write nothing.
  5. Otherwise replace the account's `offer_match` rows, upsert `account_score`, write one `score_change` when priority, tier or best offer moved (or on first score), and publish `scoring.account.scored` under the same conditions.
  6. An account with no approved offers: `account_score` with no best offer, tier `not_fit`, priority 0, explanation line `No approved offer to match against.`
  7. An excluded and not overridden account: every match disqualified with the exclusion's label.
- `getScore(ctx, accountId)`, `getMatches(ctx, accountId)`, `getScoreHistory(ctx, accountId, { limit })` (applies accounts visibility through `getAccount`; hidden is null).

- [ ] **Step 1: Write failing tests.**
  - SCO-E1-S1-AC1, AC2, AC3 (through the service).
  - SCO-E5-S1-AC2: a second score with nothing changed writes no `score_change` and publishes nothing.
  - First score publishes `scoring.account.scored` with `previousTier` null.
  - The account with no approved offers and the excluded account cases.
  - SCO-E2-S2-AC3 and SCO-E2-S3-AC2 lines appear with names.
  - Review Focus 1: three concurrent `scoreAccount` calls in separate transactions give one consistent score and at most the right number of `score_change` rows.
  - A limited principal gets null from `getScore` for a hidden account.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): score an account`.

### Task 7: Rescoring triggers, jobs and the profile API

**Files:**
- Create: `src/modules/scoring/services/rescore.ts`, `src/modules/scoring/jobs.ts`
- Modify: `src/modules/scoring/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/scoring/rescore.test.ts`, `tests/integration/scoring/profile.test.ts`

**Interfaces:**
- Consumers (ordered by account where the index says so), each calling `scoreAccount` with its cause: `intake.arrival.resolved`; `accounts.account.created`, `.updated` (including `practice_ids` changes, SCO-E1-S1-AC2b); `accounts.account.merged` (score the survivor, delete the merged account's rows); `accounts.fact.recorded`; `accounts.signal.recorded`; `accounts.person.added`, `.updated`; `accounts.account.exclusion_changed` (ACC-E7-S2-AC1).
- Fan-out consumers (not ordered): `offers.offer.approved`, `.archived`, `.changed` with `affectsMatching` (rescore accounts in that offer's practice, or all accounts when the practice is empty); `scoring.rules.changed` (all accounts); `intake.source.trust_changed` (accounts that source sent, SCO-E2-S3-AC3, SCO-E5-S2-AC3). Each enqueues `scoring.rescore.tenant` with a filter; that job pages ids (500 per `rescore.accounts` message).
- `rescoreAccountsHandler`: scores each id in its own transaction (Ruling 10).
- `ageingHandler` (nightly): accounts with a signal younger than 365 days last scored more than 20 hours ago.
- Profile: `updateProfile(ctx, patch)` validates (SCO-E5-S3-AC4: `The fit parts must add up to 100.`, `Fit and intent can't both have weight 0.`), bumps `version`, publishes `scoring.rules.changed` with the changed fields, audits before and after; `resetProfile(ctx)`.
- `requestRescore(ctx, filter?)` for `POST /v1/rescore` returns the job id.

- [ ] **Step 1: Write failing tests.**
  - SCO-E5-S1-AC1 at the service level: `accounts.signal.recorded` through `runOutbox` updates the score.
  - SCO-E5-S2-AC1: approving a new offer in a practice rescores its accounts; accounts whose best offer changes publish with `previousBestOfferId`.
  - SCO-E5-S2-AC2 and Review Focus 2: archiving the best offer of 3 accounts (one with no other offer) leaves none with an archived best offer, and the lone one at `not_fit` with the no-offer line.
  - SCO-E5-S2-AC3: a trust change rescores only that source's accounts.
  - SCO-E3-S1-AC4: a threshold change through `updateProfile` moves tiers after the jobs run.
  - Ageing picks only eligible accounts.
  - Profile validation copy; a merge scores the survivor and removes the merged account's rows.
  - A `rescore.accounts` job with 600 ids is refused by the job schema (max 500); the tenant job pages correctly over 1,100 accounts.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): rescoring triggers, jobs and profile`.

### Task 8: Accounts read models from scoring and routing events

**Files:**
- Modify: `src/modules/accounts/consumers.ts`, `src/modules/accounts/db/schema.ts` (+ migration: `owner_history_user_ids`), `src/modules/accounts/services/{summary,visibility,search,primary}.ts`, `src/entry/worker.ts`
- Test: `tests/integration/accounts/read-models.test.ts`

**Interfaces:**
- Consumers, ordered by account, importing only `@/modules/scoring/contracts/events` and `@/modules/routing/contracts/events` (Ruling 1):
  - `scoring.account.scored`: write `priority`, `fit`, `intent`, `tier`, `best_offer_id`, `practice_id` to `account_summary`; re-pick the primary contact with the best offer's target titles through offers `getOffer` (Ruling 2), unless pinned.
  - `routing.status.changed`: `review_status_key`.
  - `routing.assignment.created` / `.accepted`: `owner_user_id` = the seller.
  - `routing.assignment.declined` / `.withdrawn`: append the seller to `owner_history_user_ids`, clear `owner_user_id` when they were the current owner.
  - `routing.stage.changed`: `stage`.
- Visibility: `own_accounts` also matches `owner_history_user_ids` (Ruling 3).
- Routing's events are defined in Task 10; this task's tests publish them with test helpers if Task 10 isn't merged yet, so define the routing event contracts file first in this task if needed (state which in the report) and let Task 10 own the rest.

- [ ] **Step 1: Write failing tests.**
  - A scored event fills the summary columns, and search by `tier`, `priority_at_least`, `best_offer_id` now matches.
  - ACC-E1-S3-AC3: a best-offer change re-picks the primary to the target-title person; a pinned primary stays.
  - A declined assignment moves the seller to the history; a seller limited to `own_accounts` still sees the account they were assigned before.
  - Status and stage events fill their columns.
  - Replaying the same event changes nothing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): summary and primary from scoring and routing events`.

### Task 9: Scoring on /v1

**Files:**
- Create: `src/app/v1/accounts/[id]/score/route.ts`, `src/app/v1/accounts/[id]/score/history/route.ts`, `src/app/v1/accounts/[id]/matches/route.ts`, `src/app/v1/scoring/profile/route.ts`, `src/app/v1/rescore/route.ts`
- Test: `tests/integration/v1/scoring.test.ts`

**Interfaces:**
- `GET /v1/accounts/{id}/score` (`accounts:read`): the explanation (snake_case), plus `would_raise` and `summary`; `?offer_id=` explains a non-best match with `priority` = match total and says which offer is best (SCO-E4-S2-AC4). Hidden or missing: 404 (SCO-E4-S2-AC1).
- `GET /v1/accounts/{id}/matches`, `GET /v1/accounts/{id}/score/history?limit` (default 10, SCO-E4-S3-AC1).
- `GET /v1/scoring/profile`, `PUT /v1/scoring/profile` (`scoring:manage`, 202).
- `POST /v1/rescore` (`scoring:manage`, body `{ practice_id?, source_id? }`, 202 with `job_id`).

- [ ] **Step 1: Write failing tests.** SCO-E4-S2-AC3 shape; the `offer_id` variant; 404 for hidden (Review Focus 5); history with causes in words; PUT validation 400s and a 202 that changes tiers after jobs; rescore 202; 403 without `scoring:manage`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scoring): /v1 score, matches, history, profile and rescore`.

### Task 10: Routing module schema, contracts, ports and tenant defaults

**Files:**
- Create: `src/modules/routing/{index.ts,contracts/events.ts,contracts/jobs.ts,contracts/ports.ts,contracts/types.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`, `src/modules/routing/domain/{stages,working-days,statuses}.ts`, `drizzle/routing.config.ts`, `src/modules/intake/contracts/ports.ts` (`ReviewStatusValidator`)
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, `compose.ts`, `worker.ts`, intake `services/sources.ts` (validate `initialReviewStatusKey` through the port)
- Test: `tests/unit/routing/{stages,working-days}.test.ts`, `tests/integration/routing/defaults.test.ts`

**Interfaces:**
- Tables from the REV index (`review_status_def`, `initial_status_rule`, `decline_reason_def`, `account_review`, `status_change`, `assignment`, `stage_change`), each with `tenant_id`, plus `routing_setting` (`tenant_id`, `auto_accept_working_days` int null = off, default 2). Partial unique `assignment (tenant_id, account_id) where status in ('pending','accepted')`.
- Events from the REV index, with optional `sellerName` on assignment created and accepted (Ruling 9).
- Jobs: `routing.assignments.auto_accept {}`.
- Ports: `OwnershipPreflight { check(ctx, accountId, sellerUserId): Promise<{ result: 'new'|'assign'|'stop'; message: string; previousOwner?: string }> }` with the default in Ruling 4. Routing implements intake's `ReviewStatusValidator { exists(ctx, key): Promise<boolean> }`.
- Domain:
  - `nextStage(current, event): Stage | null` with REV-E4's table and returns; never moves backwards otherwise.
  - `addWorkingDays(from, days, timezone): Date`.
  - `statusRules`: at least one counts as reviewed and one declined (used when R2 edits them).
- Consumer `routing.tenant_defaults` on `tenancy.tenant.created`: default statuses, initial status rules by source kind, both decline reason lists, the setting row and the hourly auto-accept schedule. `seedRoutingDefaults(ctx)`.

- [ ] **Step 1: Write failing tests.**
  - Unit: every stage transition in REV-E4 including the returns, and a late `assigned` after `declined` doing nothing; working days across a weekend and a daylight-saving change in `America/New_York`.
  - Integration: defaults created once; RLS isolation; intake refuses `initial_review_status_key: 'nope'` on a source with `Pick a review status from your list.`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls` and `platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): schema, contracts, ports and tenant defaults`.

### Task 11: Review statuses, queue, insights and assignment

**Files:**
- Create: `src/modules/routing/services/{review,status,queue,assign}.ts`
- Modify: `src/modules/routing/consumers.ts`, `src/modules/routing/index.ts`
- Test: `tests/integration/routing/{review,queue,assign}.test.ts`

**Interfaces:**
- Consumer on `intake.arrival.resolved` (ordered by account): creates `account_review` with the initial status (Ruling 5) and stage `arrived` when the account has none; when it already has an open assignment, sets `flags.newFrom` (Ruling 7). Consumer on `scoring.account.scored`: refresh queue sort fields (copy priority, tier, fit, intent, best offer, practice onto `account_review`) and the low-trust flag (Ruling 8). Consumer on `accounts.account.merged`: move review, assignments and history to the survivor.
- `changeStatus(ctx, accountId, { to, note?, reasonKey? })`: row lock; decline needs a reason (`Pick a reason`), Other needs a note (`Add a note for Other.`), a `returns_to_source` status needs a note (`Say what the source should fix`); reopen from declined back to `needs_review`; writes `status_change`, publishes `routing.status.changed`, moves the stage (Task 13's service) when the status counts as reviewed or is declined.
- `setInsights(ctx, accountId, text)`.
- `listQueue(ctx, filters)`: REV-E1 default view and filters (status, practice, offer, source at any level through intake's `sourcesForAccount`, batch, tier, flag, arrived date), sorted by priority desc then newest arrival, `{ data, nextCursor }`, data limits applied through accounts visibility.
- `assign(ctx, accountId, { sellerUserId, notes?, leadOfferId?, ownershipDecision?: 'assign'|'keep' })`: needs a person; the seller must be a member with `assignments:respond`; row lock; status not counting as reviewed is moved to the first counts-as-reviewed status in the same transaction ("Approve and assign"); runs `ownershipPreflight().check`; a `stop` without `ownershipDecision: 'keep'` is a 409 with the message; replaces an open assignment (`replaced`, publishes `withdrawn` then `created`, REV-E2-S4-AC1); stores the lead offer override; publishes `routing.assignment.created` with `templateId: null`.
- `previewAssign(ctx, accountId, sellerUserId)`: the preflight result for the dialog.
- `bulk(ctx, accountIds (max 50), action)`: set status, decline with reason, or assign; returns a result per account.

- [ ] **Step 1: Write failing tests.**
  - REV-E1-S1-AC1: an agent arrival resolves and appears as Unvetted (through `runOutbox`).
  - REV-E1-S1-AC2: each filter narrows; AC4: a practices-limited reviewer sees only their accounts and counts.
  - REV-E1-S2-AC1 to AC3 copy; reopen.
  - REV-E1-S3-AC1 insights saved with author and time.
  - REV-E2-S1-AC1: Approve and assign from Unvetted moves to Reviewed and creates the assignment; AC2 with a stub preflight returning stop; AC3 bulk of 3 reports each result; 51 accounts is a 400.
  - Review Focus 3: two concurrent assigns give one open assignment.
  - Ruling 7: an arrival on an assigned account sets `newFrom`.
  - A seller without `assignments:respond` can't be assigned.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): review statuses, queue, insights and assignment`.

### Task 12: Accept, decline, withdraw and auto-accept

**Files:**
- Create: `src/modules/routing/services/respond.ts`
- Modify: `src/modules/routing/jobs.ts`, `src/modules/routing/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/routing/respond.test.ts`

**Interfaces:**
- `accept(ctx, assignmentId)`: only the assigned seller; pending only; `accepted_how: 'seller'`; publishes `routing.assignment.accepted`; stage `assigned`.
- `decline(ctx, assignmentId, { reasonKey, note? })`: only the assigned seller; reason from the assignment list; Other needs a note; status unchanged; stage back to `reviewed`; flag `declinedBy { sellerName, reasonLabel }`; publishes `routing.assignment.declined`.
- `withdraw(ctx, assignmentId, { reassignTo? })`: the assigner or an owner; publishes `withdrawn` (and the new `created` when reassigning).
- `autoAcceptHandler`: accepts pending assignments older than the setting's working days with `auto_timeout`; off when the setting is null.
- `markSeen(ctx, accountId)`: the assigned seller clears `flags.newFrom`.
- Consumer on `tenancy.member.removed`: open assignments of that seller become `withdrawn` back to the assigner.

- [ ] **Step 1: Write failing tests.**
  - REV-E2-S2-AC3: an assignment 3 working days old is auto-accepted; one created Friday afternoon is still pending on Monday morning with a 2-day setting.
  - REV-E2-S3-AC1, AC2: decline needs a reason, Other a note; the account is back with the flag, stage `reviewed`, the event published.
  - Review Focus 4: after a decline, a late `accept` on that assignment is refused, and a replayed `assignment.accepted` event doesn't move the stage.
  - Another seller can't accept or decline someone else's assignment (404).
  - Withdraw and reassign publish in order; member removal withdraws.
  - `markSeen` only by the assigned seller.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): accept, decline, withdraw and auto-accept`.

### Task 13: Stages and account status

**Files:**
- Create: `src/modules/routing/services/{stage,read}.ts`
- Test: `tests/integration/routing/stage.test.ts`

**Interfaces:**
- `moveStage(ctx, accountId, event: StageEvent, causeEventId)`: uses `nextStage`; writes `stage_change` and publishes `routing.stage.changed` only on a real move; idempotent per `causeEventId` (REV-E4-S1-AC2).
- `getAccountStatus(ctx, accountIdOrArrivalId)`: REV-E4-S2 shape (`account_id`, `name`, `stage`, `review_status`, `tier`, `owner_name`, `last_activity_at` null until R1c, `declined_reason`, `send_back_note`, `summary` sentence); an arrival id resolves through intake's `accountForArrival` limited to the caller's arrivals; hidden is null.

- [ ] **Step 1: Write failing tests.** REV-E4-S1-AC1 for the R1b stages; AC2 replay; REV-E4-S2-AC2 arrival id lookup limited to the caller's source; AC3 hidden is null; AC4 declined reason and send-back note included; the summary sentence for an assigned account (`Assigned to Ash on Oct 22.`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): stages and account status`.

### Task 14: Routing on /v1

**Files:**
- Create: `src/app/v1/review-queue/route.ts`, `src/app/v1/accounts/[id]/review-status/route.ts`, `src/app/v1/accounts/[id]/insights/route.ts`, `src/app/v1/accounts/[id]/status/route.ts`, `src/app/v1/assignments/[id]/route.ts`, `src/app/v1/review-queue/bulk/route.ts`, `src/app/v1/settings/review/route.ts`; extend `src/app/v1/accounts/[id]/route.ts` with `:assign`, `:assign-preview` and `:seen` actions
- Test: `tests/integration/v1/routing.test.ts`

**Interfaces:**
- The REV index endpoints and scopes, with these additions: `POST /v1/accounts/{id}:assign-preview` (`assign:act`) returns the preflight; `POST /v1/review-queue/bulk` (`review:act`, `assign:act` when the action is assign); `POST /v1/accounts/{id}:seen` (people only); `GET /v1/settings/review` (`settings:manage`) returns statuses, initial rules, decline reasons and the auto-accept setting; `PUT /v1/settings/review` updates only `auto_accept_working_days` in R1b (1 to 10 or null).
- `GET /v1/accounts/{id}/status` (`status:read`) also accepts `?arrival_id=`.
- Assign returns 202 (spec). Accept, decline and withdraw return the assignment. Assign, decline and withdraw are people only.

- [ ] **Step 1: Write failing tests.** REV-E1-S1-AC3 (a seller gets 403 on the queue); the queue shape and paging; status change copy as 400s; assign 202 and the event; accept/decline by the wrong seller 404; status by account id and by arrival id; Review Focus 5 (an agent asking for another source's account or arrival gets 404); settings read and the auto-accept update.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): /v1 review queue, status, assignments and settings`.

### Task 15: Source feedback and the intake account-status read model

**Files:**
- Create: `src/modules/intake/services/feedback.ts`, intake schema additions `source_feedback` and `account_status` (+ migration)
- Modify: `src/modules/intake/consumers.ts`, `src/modules/intake/services/status.ts`, `src/app/v1/arrivals/[id]/route.ts`, `src/app/v1/batches/[id]/route.ts`, new `src/app/v1/feedback/route.ts`
- Test: `tests/integration/intake/feedback.test.ts`, `tests/integration/v1/feedback.test.ts`

**Interfaces:**
- Consumers importing only `@/modules/routing/contracts/events`:
  - `routing.status.changed` to a declined status: feedback `declined_at_review` with the reason and note for every source in the chains of arrivals that resolved to the account; to a `returns_to_source` status: feedback `sent_back` with the note.
  - `routing.assignment.declined`: feedback `declined_by_seller`.
  - Each publishes `intake.feedback.recorded`; idempotent per (source, arrival, kind, cause event).
  - `routing.status.changed`, `.assignment.created`, `.accepted`, `.declined`, `.withdrawn`, `.stage.changed`: update `account_status` (Ruling 9).
- `GET /v1/arrivals/{id}` gains `stage`, `review_status`, `owner_name` (as the principal's scopes allow: owner name needs `status:read`) and `feedback[]`; `GET /v1/batches/{id}` gains `counts_by_stage`.
- `GET /v1/feedback?since&cursor` (`arrivals:read`): feedback for the principal's own source (and children) only (SRC-E1-S4-AC2).

- [ ] **Step 1: Write failing tests.** SRC-E1-S4-AC1 for decline at review, send back and seller decline (every source in the chain gets a row); AC2 only own source; SRC-E2-S3-AC1 counts by stage; arrival detail shows stage, status and owner name; replays write nothing new.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): source feedback and account status from routing events`.

### Task 16: Seed, one-path to assignment, docs

**Files:**
- Modify: `src/entry/seed.ts` (scoring and routing defaults, signal rules for existing tenants), `README.md`, `docs/CHANGELOG.md`, `docs/spec/migration-and-rollout/release-plan.md` (R1b progress), `docs/spec/architecture/event-catalog.md` (new events and jobs, `trust` and `sellerName` fields), `docs/spec/scoring-and-matching/index.md` and `review-and-routing/index.md` (columns and ports added by the rulings), `docs/spec/accounts/index.md` (`owner_history_user_ids`)
- Test: `tests/integration/routing/one-path.test.ts`, seed assertions in `tests/integration/entry/cli.test.ts`

**Interfaces:**
- R1b exit: an agent sends an account; it is scored and explained; it shows in the queue as Unvetted with its priority; a leader approves and assigns; the seller accepts; the agent reads the status as assigned with the owner's name, and the leader's stage history shows arrived, reviewed, assigned.

- [ ] **Step 1: Write failing tests.** The R1b exit path above end to end through services and `runOutbox`; seed twice leaves one profile, one set of statuses and the signal rules.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run typecheck && npm run lint && npm test && npm run e2e && npm run build`. Expected: PASS. Then the laptop smoke run: seed, start the background roles and the web app, send the Miami-Dade arrival with the dev key, read `GET /v1/accounts/{id}/score` and `GET /v1/accounts/{id}/status`, stop exactly the processes started.
- [ ] **Step 5:** Commit `feat: R1b seed, one-path test and docs`.
