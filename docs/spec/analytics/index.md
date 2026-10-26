# Analytics

Module code ANL · Schema `analytics` · Releases R3 (funnel, costs, flywheel), R4 (scorecard port)

## Purpose

Give the CRO, the owner and each AE end-to-end clarity: which sources produce accounts that become
won deals, what each stage cost, what is getting better, and where the funnel is stuck this week.

Analytics never computes business state of its own. It builds read models from other modules' events
(see the funnel triggers in `architecture/event-catalog.md`), keeps a cost ledger, and derives rates
and costs with pure functions in `src/modules/analytics/domain/`. The UI and the API never
re-implement that math (v1 rule, carried).

## Owns (data)

| Table | Key fields | Notes |
|---|---|---|
| `analytics.account_journey` | `tenant_id`, `account_id`, `attributed_source_id` (first arrival's person-level source, or the most specific level present), `agent_source_id`, `vendor_source_id`, `first_batch_id`, `practice_id`, `offer_id` (best offer at assignment, else latest), `seller_user_id`, `arrived_at`, `reviewed_at`, `assigned_at`, `engaged_at`, `opportunity_at`, `won_at`, `lost_at`, `declined_at`, `current_stage`, `won_amount_cents`, `currency`, `updated_at` | One row per account. Stage timestamps are first-entered times. |
| `analytics.source_touch` | `tenant_id`, `account_id`, `source_id`, `source_level` (person, agent, vendor), `batch_id`, `arrival_id`, `first_seen_at` | Every source that ever sent the account, for the "any source" view. |
| `analytics.decline` | `tenant_id`, `account_id`, `kind` (review, assignment), `reason_key`, `note`, `by_user_id`, `source_id`, `at` | Decline reasons by source and seller |
| `analytics.step_credit` | `tenant_id`, `outcome_id`, `outcome_kind`, `step_id`, `step_type`, `playbook_template_id`, `practice_id`, `offer_id`, `occurred_at` | One row per credited step per outcome, for "what worked" |
| `analytics.cost_line` | `id` (`cst_`), `tenant_id`, `origin` (auto, manual), `category` (vendor_credits, ai, ad_spend, integration_usage, hours, event, referral_fee, other), `amount_cents`, `currency`, `incurred_on`, `period_start`, `period_end`, `target_type` (account, batch, source, practice, offer, none), `target_id`, `origin_event_id`, `quantity`, `unit` (credits, tokens, hours), `note`, `created_by`, `voided_at`, `voided_by`, `void_reason` | Ledger. Never edited; corrections void and re-add. |
| `analytics.hour_rate` | `tenant_id`, `role_key`, `rate_cents_per_hour`, `effective_from` | For turning logged hours into cost. |
| `analytics.week` | `tenant_id`, `start_date` (Monday), `built_at`, `counts` (raw counts json) | Scorecard weeks; raw counts only. |
| `analytics.scorecard_target` | `tenant_id`, `metric_key`, `target`, `min_sample` | Targets and minimum samples per row. |
| `analytics.diagnosis` | `tenant_id`, `week_start`, `bottleneck`, `cause`, `summary`, `ai_run_id`, `edited_by`, `edited_at` | One per week. |
| `analytics.fix` | `id`, `diagnosis_id`, `text`, `owner_role`, `done`, `done_at`, `done_by` | Carries over until done. |
| `analytics.consumer_cursor` | `consumer`, `last_event_id`, `rebuilt_at` | Replay bookkeeping. |

## Depends on

Events only for its read models and numbers (Sources and intake, Accounts, Review and routing, CRM
sync, Playbooks, Enrichment, AI tasks, Integrations, Campaigns). Its consumers, domain functions and
services never call another module. The only synchronous reads are display labels (source names and
levels from SRC, practice and offer names from OFF, user names from TEN), fetched by its pages at
render time; nothing in those modules depends on Analytics, so no cycle forms.

## Epics

| Epic | File | Release |
|---|---|---|
| ANL-E1 Account funnel by source | [account-funnel-by-source.md](account-funnel-by-source.md) | R3 |
| ANL-E2 Cost ledger | [cost-ledger.md](cost-ledger.md) | R3 |
| ANL-E3 Source performance and cost per stage | [source-performance.md](source-performance.md) | R3 |
| ANL-E4 Flywheel trends | [flywheel-trends.md](flywheel-trends.md) | R3 |
| ANL-E5 Weekly scorecard and diagnosis | [weekly-scorecard-and-diagnosis.md](weekly-scorecard-and-diagnosis.md) | R4 (R3 for the account rows) |
| ANL-E6 Who sees what, and exports | [access-and-exports.md](access-and-exports.md) | R3 |
| ANL-E7 Read models and replay | [read-models-and-replay.md](read-models-and-replay.md) | R3 |

## Events consumed

| Event | Updates |
|---|---|
| `routing.stage.changed` | **the only source of stage timestamps**: sets the stage's `<stage>_at` (first entry) and `current_stage`. Review and routing owns stage tracking (REV-E4), including implied acceptance (the seller acts on the account in the CRM, or 2 working days pass with no decline). Analytics never re-derives stages from other events. |
| `intake.arrival.resolved` | `source_touch` row; attribution fields on the journey (first source, batch) |
| `intake.batch.created` / `.completed` | batch labels and counts |
| `routing.assignment.accepted` | `seller_user_id`, `offer_id` on the journey |
| `routing.assignment.declined` | a row in `analytics.decline` (reason key, note, seller, source) for decline-reason reports |
| `routing.status.changed` | review decline reasons (status changed to a declined status) into `analytics.decline` |
| `crm.deal.changed` (won) | `won_amount_cents`, `currency` |
| `playbooks.outcome.recorded` | `analytics.step_credit` rows from `creditedStepIds`, for the "what worked" roll-up |
| `accounts.account.merged` | merge journeys (earliest timestamps win; touches combined) |
| `scoring.account.scored` | `practice_id`, `offer_id` until assignment |
| `integrations.usage.recorded` | **the** auto cost line for every costed outside call (vendor credits, AI tokens, paid API usage), one line per event; `costCents` from the event, target from `sourceId` or the account found by `correlationId` |
| `enrichment.request.completed` | no line of its own; supplies the account (and request id `enr_…`) for usage records with the same `correlationId` |
| `ai.run.completed` | no line of its own; supplies the account for AI usage records with the same `correlationId` |
| `campaigns.ad_spend.recorded` | auto cost line (ad spend, reported by the channel, not a costed call) |
| `playbooks.learning.recorded` | learnings count for the flywheel |
| `intake.source.trust_changed` | trust trend |

## Events published

| Event | Data |
|---|---|
| `analytics.cost.recorded` | `costLineId`, `origin`, `category`, `amountCents`, `currency`, `targetType`, `targetId`, `incurredOn` |
| `analytics.diagnosis.created` | `weekStart`, `diagnosisId`, `bottleneck` |

## API endpoints

Fixed in `public-api/index.md` (JSON is `snake_case`):

| Method and path | Scope | Does |
|---|---|---|
| `GET /v1/analytics/funnel?by=source\|practice\|offer&from&to` | `analytics:read` | Funnel counts and conversion per stage. Optional extra query: `view` (cohort, activity), `attribution` (first, any), `source_level` (person, agent, vendor), `format=csv` |
| `GET /v1/costs?from&to&source_id` | `analytics:read` | Cost lines, with totals by category and target; `format=csv` |
| `POST /v1/costs` | `costs:write` | Add a manual cost line |

Proposed additions (to be added to `public-api/index.md` before R3; not yet in the fixed list):

| Method and path | Scope | Does |
|---|---|---|
| `POST /v1/costs/{id}:void` | `costs:write` | Void a line with a reason |
| `GET /v1/analytics/sources/{id}/performance` | `analytics:read`, or `status:read` limited to own source | One source's funnel, decline reasons and trust over time (backs `get_source_performance`) |
| `GET /v1/analytics/flywheel` | `analytics:read` | Quarterly trend numbers |
| `GET /v1/analytics/scorecard` | `analytics:read` | Weeks, targets, colours, rolling average |

## MCP tools

| Tool | Does |
|---|---|
| `get_source_performance` | For the calling agent's source (or any source the principal may see): arrivals, how far they got, cost per stage, trust trend. Lets an agent learn which of its submissions convert. |

## Open questions

- Attribution default is "first source" (the source of the account's first resolved arrival). Should
  warm intros override that and credit the introducer? Spec's call for R3: no, but intros show as their
  own source level in the "any source" view.
