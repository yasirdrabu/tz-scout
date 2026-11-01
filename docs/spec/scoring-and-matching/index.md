# SCO: Scoring and matching

Module code SCO · Schema `scoring` · Releases R1 to R3

## Purpose

Turn what Scout knows about an account into numbers a person can act on and explain: how well it fits
each approved offer, how strong its reason to buy now is, how much it could be worth, and where it
should sit in the queue. Pick the best offer. Explain every point.

Scores rank and explain. They never push anything to a CRM, never assign, never change a review
status. People decide (D6).

## What it owns

| Table | Key fields | Notes |
|---|---|---|
| `scoring_profile` | `tenant_id`, `fit_weight` (0.55), `intent_weight` (0.45), `fit_parts` (json: maxes per part), `half_life_days` (45), `max_signal_age_days` (365), `tier_thresholds` (json), `warm_intro_cap` (20), `trust_modifier_max` (5), `trust_neutral` (0.6), `research_floor_days` (180), `version`, `updated_by`, `updated_at` | One row per tenant. Every change bumps `version` and publishes `scoring.rules.changed`. |
| `offer_match` | `id`, `tenant_id`, `account_id`, `offer_id`, `fit`, `intent`, `match_total`, `tier`, `fit_parts` (json), `rule_hits` (json), `disqualified_reason`, `profile_version`, `computed_at` | One row per account per approved offer. Replaced on each scoring. |
| `account_score` | `account_id` (pk with tenant), `version`, `best_offer_id`, `practice_id`, `fit`, `intent`, `match_total`, `warm_points`, `warm_introducer_id`, `trust`, `trust_modifier`, `priority`, `tier`, `tier_reason` (`computed` or `research_floor` or `warm_intro_floor`), `revenue_potential_cents`, `revenue_band` (`low`, `medium`, `high`), `explanation` (json, see explain-score.md), `inputs_hash`, `profile_version`, `computed_at` | Current score for the account. The one every other module reads. |
| `score_change` | `id`, `tenant_id`, `account_id`, `from_priority`, `to_priority`, `from_tier`, `to_tier`, `from_offer_id`, `to_offer_id`, `cause` (`new_signal`, `new_fact`, `rules_changed`, `offer_changed`, `trust_changed`, `warm_intro`, `manual_rescore`, `ageing`), `cause_event_id`, `at` | History, so "why did this move" has an answer. Kept 2 years. A row is written only when priority, tier or best offer moved. `ageing` is the nightly time-only rescore. |

Signal rules are owned by Offers and practices (they are per offer). Warm-intro points and source trust
are owned by Sources and intake. Scoring reads them through those modules' public interfaces.

## Depends on

| Module | Calls (synchronous) |
|---|---|
| Accounts | `getAccountForScoring(accountId)`: facts (industry, employees, revenue, country, technologies, headcount growth), people with titles and buying roles, signals, research tier and date, exclusion |
| Offers and practices | `listApprovedOffers(practiceId?)` with fit criteria and signal rules; `medianWonDealCents(practiceId)` |
| Sources and intake | `getWarmIntro(accountId)` (introducer and points), `getTrust(chain)` |

## Epics

| Epic | File | Release |
|---|---|---|
| SCO-E1 Fit and intent scoring | [fit-and-intent-scoring.md](fit-and-intent-scoring.md) | R1 |
| SCO-E2 Priority, warm intros, trust and revenue potential | [priority-warm-intros-and-trust.md](priority-warm-intros-and-trust.md) | R1 (revenue potential R2) |
| SCO-E3 Tiers and best offer | [tiers-and-best-offer.md](tiers-and-best-offer.md) | R1 |
| SCO-E4 Explain a score | [explain-score.md](explain-score.md) | R1 |
| SCO-E5 Rescoring and tenant weights | [rescoring-and-weights.md](rescoring-and-weights.md) | R1 (weights editor R2) |

## Events published

| Event | Data |
|---|---|
| `scoring.account.scored` | `accountId`, `priority`, `fit`, `intent`, `tier`, `previousTier` (null on first), `bestOfferId`, `previousBestOfferId`, `practiceId`, `revenueBand`, `cause`, `profileVersion`, `version` (`account_score.version`) |
| `scoring.rules.changed` | `profileVersion`, `changed` (list of field names), `changedBy` |

`scoring.account.scored` is published only when priority, tier or best offer changed, or on the first
score, so a rescore that changes nothing is quiet.

## Events consumed

| Event | Does | Ordered by account |
|---|---|---|
| `intake.arrival.resolved` | score the account | yes |
| `intake.arrival.rejected` | with an `accountId` (rejected as excluded): score the account | yes |
| `accounts.account.created` / `.updated` / `.merged` | rescore (merged: score survivor, delete loser's rows). Events that carry an `arrivalId` are skipped, because `intake.arrival.resolved` scores the account | yes |
| `accounts.fact.recorded`, `accounts.signal.recorded`, `accounts.person.added`, `accounts.person.updated`, `accounts.account.exclusion_changed` | rescore that account (skipped when the event carries an `arrivalId`) | yes |
| `accounts.conflict.resolved` | rescore that account | yes |
| `offers.offer.approved` / `.archived` / `.changed` | enqueue rescore for accounts in that offer's practice | no |
| `scoring.rules.changed` | enqueue rescore for every account in the tenant | no |
| `intake.source.trust_changed` | enqueue rescore for accounts with an arrival from that source | no |

Rescoring of many accounts runs as `scoring.rescore.page` jobs, which queue `scoring.rescore.accounts` messages of at most 200 account ids each (a smaller page than 500 shortens how long account locks are held). Each account is scored in its own savepoint; the profile and approved offers are loaded once per message. A nightly `scoring.ageing` job (02:00 UTC, one schedule per tenant) rescores accounts with a young signal whose score is over 20 hours old.

## API endpoints

JSON field names are snake_case (data-conventions.md).

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/accounts/{id}/score` | `accounts:read` | The `explain_score` object (`account_id`, `offer`, `priority`, `fit`, `intent`, `tier`, `factors[]`, `warm_intro_points`, `would_raise[]`) plus `offer_id`, `summary` and the full explanation. 404 until the account is first scored |
| `GET /api/v1/accounts/{id}/matches` | `accounts:read` | Every offer match for the account |
| `GET /api/v1/accounts/{id}/score/history` | `accounts:read` | Score changes with causes |
| `GET /api/v1/scoring/profile`, `PUT /api/v1/scoring/profile` | `scoring:manage` | Read or update weights and thresholds, with validation, ranges and an audit entry; PUT returns 202, rescoring runs in the background. The weights screen and preview are R2 |
| `POST /api/v1/scoring/profile/reset` | `scoring:manage` | Back to the defaults; 202, it starts a rescore |
| `POST /api/v1/rescore` | `scoring:manage` | Rescore the tenant or a filter (practice, source); 202 with job id. Progress is visible from R2 (SCO-E5-S4-AC1) |

## MCP tools

| Tool | Does |
|---|---|
| `explain_score` | Input `account_id`, optional `offer_id` (default best offer). Output shape fixed in `mcp/agent-tools.md`: `offer`, `priority`, `fit`, `intent`, `tier`, `factors[]` (`name`, `points`, `max`, `reason`), `warm_intro_points`, `would_raise[]`. Mapping in explain-score.md. |

## Open questions

- Should a seller be able to mark a score "wrong" with a reason, as training data for weights? Not in
  this version; captured via retros in Playbooks.
- Per-practice scoring profiles (different fit weights per practice) are not in scope; one profile
  per tenant. Revisit when Tobi's practices differ from Taazaa's.
