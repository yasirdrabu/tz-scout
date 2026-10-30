# ACC: Accounts

Module code ACC · Schema `accounts` · Releases R1 to R2

## Purpose

The account is the unit of work (D2). This module holds what Scout knows about each company and its
people: firmographics, people and their buying roles, every fact with the source that said it, dated
signals, conflicts between sources, merges, custom fields per practice and exclusions. It is
practice-agnostic: which offer an account fits is SCO's job, what to do with it is PLB's and REV's.

ACC never takes data straight from outside. New data comes through intake (SRC calls
`upsertFromArrival`) or from a person editing in the web app. That keeps provenance complete.

**ACC calls no module above it** (spec's call, D29). It defines two interfaces in `accounts/contracts`
that higher modules implement, wired by the composition root:
- `SourceInfoProvider` (implemented by SRC): `getTrust(ctx, chain)` (one effective trust for a source chain) for picking current fact values,
  `sourcesForAccount(ctx, accountId)`.
- `SourceAccessProvider` (implemented by SRC): `childSources(ctx, sourceIds)` and `personSourceFor(ctx, userId)`, used to apply the `own_source` data limit without importing SRC.
- `MergeGuard` (implemented by CRM): `check(ctx, survivorId, mergedId)` refuses merges of accounts
  linked to different CRM companies (ACC-E5).

The `add_person` and `add_signal` API and MCP handlers call SRC's `submitArrival` directly (SRC then
calls ACC); ACC's endpoints below are routed to SRC by the API layer, not by ACC.

## What it owns

| Table | Key fields | Notes |
|---|---|---|
| `account` | `id` (`acc_`), `tenant_id`, `name`, `match_name`, `domain`, `website_url`, `linkedin_url`, `industry`, `industry_key`, `employees`, `employees_min`, `employees_max`, `revenue_cents`, `revenue_min_cents`, `revenue_max_cents`, `hq_city`, `hq_state`, `hq_state_key`, `hq_country`, `description`, `technologies[]`, `keywords[]`, `parent_domain`, `headcount_growth_6m`, `founded_year`, `is_shell`, `research_tier` (`A`, `B`, `C`), `research_tier_signal_at`, `practice_ids[]`, `excluded_reason_key`, `excluded_override`, `crm_status`, `crm_status_at`, `archived_at`, `created_at` | Current values: a projection of the current facts, for fast lists and search. `research_tier` is the ABM researcher's tier (current `researcher_tier` fact) and `research_tier_signal_at` the date of the dated signal that came with it; SCO uses both as a tier floor. `practice_ids` (may be empty) is owned by ACC and set from an arrival's `practice_hint`, file-import practice recognition, or a person; it is additive (a new hint adds, never removes) and only a person removes one (spec's call, D25) |
| `account_alias` | `account_id`, `kind` (`domain`, `name`, `merged_id`, `external_id`), `value`, `system` | Domains and names it is also known by; ids of merged accounts; outside ids `(hubspot, 123)` |
| `person` | `id` (`per_`), `tenant_id`, `account_id`, `first_name`, `last_name`, `title`, `seniority`, `email`, `email_status`, `phone`, `mobile_phone`, `linkedin_url`, `is_primary`, `primary_pinned_at`, `primary_pinned_by`, `decision_note`, `archived_at` | Current values, also a projection of facts |
| `person_role` | `person_id`, `role_key`, `origin` (`stated`, `guessed_from_title`, `set_by_person`), `set_by`, `set_at` | Many roles per person |
| `person_alias` | `person_id`, `kind` (`email`, `merged_id`, `external_id`), `value`, `system` | |
| `fact` | `id` (`fct_`), `tenant_id`, `account_id`, `person_id?`, `key`, `value` (JSON), `value_type`, `kind` (`firmographic`, `contact`, `research`, `custom`, `form_answer`), source chain ids, `arrival_id`, `url`, `note`, `observed_at`, `recorded_at`, `status` (`current`, `candidate`, `superseded`, `archived`), `pinned_by`, `pinned_at` | Every value ever said about an account or person |
| `conflict` | `id` (`cfl_`), `tenant_id`, `account_id`, `person_id?`, `key`, `fact_ids[]`, `status` (`open`, `resolved`), `kept_fact_id`, `resolved_by`, `resolved_at`, `note` | |
| `signal` | `id` (`sig_`), `tenant_id`, `account_id`, `type`, `kind`, `title`, `detail`, `url`, `value`, `confidence` (0 to 1, from the source), `occurred_at`, source chain ids, `arrival_id`, `external_id`, `recorded_at`, `archived_at` | Dated reasons to buy |
| `custom_field` | `tenant_id`, `key`, `label`, `type`, `options`, `practice_ids[]`, `show_in_brief`, `sort` | Definitions (ACC-E6) |
| `buying_role` | `tenant_id`, `key`, `label`, `sort`, `archived` | Configurable list, seeded with defaults |
| `exclusion_rule` | `tenant_id`, `key`, `label`, `kind`, `params`, `enabled` | ACC-E7 |
| `exclusion_list` | `tenant_id`, `kind` (`vendor_keyword`, `parent_domain`, `parent_name`, `do_not_contact_domain`), `value` | The lists the exclusion rules read; editing one queues `accounts.exclusions.recheck` |
| `account_summary` | `account_id`, `priority`, `fit`, `intent`, `tier`, `best_offer_id`, `practice_id`, `review_status_key`, `owner_user_id`, `stage`, `source_ids[]`, `last_signal_at`, `updated_at` | Read model for search, built from SCO, REV, SRC and CRM events. Also `score_version` and `review_version` (a scoring or routing snapshot applies only when its version is newer), `owner_history_user_ids[]` (current and past owners, for `own_accounts`), `review_flags[]` and `has_open_assignment` |

New id prefix: `cfl_` (conflict).

## Depends on

- **TEN** for context and data limits. **OFF** (synchronous, read) for an offer's target buying roles
  and titles when computing committee coverage.
- **Events consumed:** `intake.arrival.resolved` (source links in `account_summary`),
  `scoring.account.scored` and `routing.review.changed` (the summary's score and review columns, each applied only when its `version` is newer than the stored one),
  `crm.company.checked`, `crm.handoff.completed`, `crm.deal.changed` (for `crm_status`: each carries `companyLifecycle` and `observedAt`, and the status is set only when `observedAt` is newer than `account.crm_status_at`; exclusions are then re-evaluated as an edit does), `intake.source.trust_changed`
  (re-pick current values that depend on trust).

## Epics

| Epic | File | Release |
|---|---|---|
| ACC-E1 Accounts and people | [accounts-and-people.md](accounts-and-people.md) | R1 |
| ACC-E2 Buying committee | [buying-committee.md](buying-committee.md) | R2 |
| ACC-E3 Facts, provenance and conflicts | [facts-provenance-and-conflicts.md](facts-provenance-and-conflicts.md) | R1 (facts), R2 (conflicts) |
| ACC-E4 Signals | [signals.md](signals.md) | R1 |
| ACC-E5 Merges and aliases | [merges-and-aliases.md](merges-and-aliases.md) | R1 |
| ACC-E6 Custom fields per practice | [custom-fields.md](custom-fields.md) | R2 |
| ACC-E7 Exclusions | [exclusions.md](exclusions.md) | R1 |
| ACC-E8 Account search | [account-search.md](account-search.md) | R1 |

## Public interface (for other modules)

| Call | Used by | Returns |
|---|---|---|
| `findMatches(candidate)` | SRC | up to 5 accounts with confidence and the reason |
| `upsertFromArrival(arrival, accountId?)` | SRC | `{ accountId, created, personIds, factIds, signalIds, conflictIds }` |
| `checkExclusion(accountId)` | SRC, SCO | exclusion key and reason, or none |
| `getAccount(accountId)` / `getAccounts(ids)` | SCO, PLB, REV, CRM | current values, people with roles, aliases |
| `getSignals(accountId, since)` | SCO | signals |
| `setPractices(accountId, practiceIds, actor)` | SRC (from `practice_hint`), web | Adds or (person only) removes practices; publishes `accounts.account.updated` with `changedKeys: ["practice_ids"]` |
| `getAccountForScoring(accountId)` | SCO | One read with everything scoring needs: `practice_ids`, current facts (with source chain ids), people with buying-role keys and seniority, non-archived signals with fine type, kind, date, value and source chain ids, `research_tier` with `research_tier_signal_at`, and the exclusion flag (`excluded_reason_key`, `excluded_override`) |
| `getCommittee(accountId, offerId)` | PLB, MCP | coverage and gaps (ACC-E2) |
| `search(query)` | MCP, web, REV | paged account summaries within data limits. R1b filters: `reviewStatusKeys`, `arrivedSince` (the account's first arrival), `accountIds` (at most 1,000), `reviewFlags` (any of), `queueDefault` (the review queue's default view) |
| `countAccounts(query)` | REV | The count for the same filters |
| `getSummaries(ctx, ids)` | SRC, REV | Summary rows (stage, review status, owner, priority, tier, best offer) for at most 1,000 ids the principal can see |
| `listAccountIds(ctx, opts)` | SCO, REV | Background only: a page of active account ids, for rescoring and the backfill |

## Events published

| Event | `data` |
|---|---|
| `accounts.account.created` | `accountId`, `name`, `domain`, `isShell`, `arrivalId?` |
| `accounts.account.updated` | `accountId`, `changedKeys[]`, `arrivalId?` |
| `accounts.account.archived` | `accountId`, `reason` |
| `accounts.account.merged` | `survivorId`, `mergedId`, `mergedBy` |
| `accounts.account.exclusion_changed` | `accountId`, `excludedReasonKey?`, `override`, `arrivalId?` |
| `accounts.person.added` | `accountId`, `personId`, `roleKeys[]`, `arrivalId?` |
| `accounts.person.updated` | `accountId`, `personId`, `changedKeys[]`, `roleKeys[]`, `arrivalId?` |
| `accounts.fact.recorded` | `accountId`, `personId?`, `factId`, `key`, `kind`, `sourceChain`, `becameCurrent`, `arrivalId?` |
| `accounts.signal.recorded` | `accountId`, `signalId`, `type` (fine type or null), `kind` (`research`, `trigger`, `pain`), `occurredAt`, `value?`, `confidence?`, `sourceChain`, `arrivalId?` |
| `accounts.conflict.detected` | `conflictId`, `accountId`, `personId?`, `key`, `factIds[]`, `sourceIds[]` |
| `accounts.conflict.resolved` | `conflictId`, `accountId`, `key`, `keptFactId`, `archivedFactIds[]`, `winningSourceIds[]`, `losingSourceIds[]`, `resolvedBy`, `note?` |

`arrivalId` is set when an arrival caused the event, so scoring can score that arrival once. The primary contact re-pick reads the best offer's target titles from Offers, so every caller gets the same answer.

## API endpoints

As fixed in [public-api/index.md](../public-api/index.md):

| Method and path | Scope | Notes |
|---|---|---|
| `GET /v1/accounts?q=&domain=&tier=&practice_id=&offer_id=&stage=&source_id=&cursor=` | `accounts:read` | Search (ACC-E8), within data limit |
| `GET /v1/accounts/{id}` | `accounts:read` | Current values, signals, aliases, exclusion, scores summary, stage |
| `PATCH /v1/accounts/{id}` | `accounts:write` | Field edits become pinned facts with the caller as source |
| `GET /v1/accounts/{id}/people` | `accounts:read` | Contact fields (email, phone) need `people:read` |
| `POST /v1/accounts/{id}/people` | `people:write` | Inline targeted arrival through SRC; returns `person_id` |
| `PATCH /v1/people/{id}` | `people:write` | Roles, title, contact fields, decision note |
| `POST /v1/accounts/{id}/signals` | `signals:write` | Inline targeted arrival through SRC; returns `signal_id` |
| `GET /v1/accounts/{id}/facts?field=` | `accounts:read` | All values with provenance |
| `GET /v1/accounts/{id}/conflicts` | `accounts:read` | |
| `POST /v1/conflicts/{id}:resolve` | `review:act` (people only) | `kept_fact_id`, `note` |

Committee coverage reaches agents through `get_account_brief` (PLB) and is not a separate endpoint.
Merging is web-app only.

## MCP tools

`find_accounts`, `add_person`, `add_signal`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md).
The last two submit inline targeted arrivals through SRC, so the agent's data gets provenance and
counts toward its trust, and the ids come back at once. Behaviour in
[account-search.md](account-search.md), [accounts-and-people.md](accounts-and-people.md) and
[signals.md](signals.md).

## AI tasks

`conflict_explanation` (ACC-E3): a one-line, plain explanation of why two values may differ (different
dates, one includes modules the other doesn't), citing the fact ids it relies on. With
the Claude connection mode = mock, no explanation is shown.

## Open questions

1. Should people be shared across accounts when someone changes jobs (a person record that moves), or
   always a new person at the new account with a link? This version: a new person, with
   `person_alias` linking the old email.
2. Industry taxonomy: keep free text plus today's NAICS mapping, or adopt a fixed list per tenant?
   This version keeps free text for display and a normalised `industry_key` for matching (SCO owns
   the matching table).
