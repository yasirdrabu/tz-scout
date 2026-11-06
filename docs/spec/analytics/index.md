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
| `analytics.journey` | `tenant_id`, `account_id` (pk), `first_source_id` (the first arrival's agent, else person, else vendor source, as `arrival.closest_source_id`), `first_batch_id`, `arrived_at`, `practice_id`, `offer_id` (scoring's best offer), `score_version`, `exit_stage`, `exit_at`, `updated_at` | One row per account (R3b-1). The earliest arrival wins. A score or stage move that comes first makes the row with no arrival yet (`first_source_id` and `arrived_at` null); reads skip it until the arrival fills it. Practice and offer take only a score with a higher `version`. `exit_at` is the time of the latest move seen to an exit or a flow stage; `exit_stage` is set only when that move was to an exit. Stages are per workspace (REV-E5), so stage times live in `journey_stage`, not in fixed `<stage>_at` columns. |
| `analytics.journey_stage` | `tenant_id`, `account_id`, `stage_key`, `entered_at`; pk (tenant, account, stage key) | The earliest entry into each stage. A late or retried event never moves it. |
| `analytics.journey_deal` | `tenant_id`, `account_id`, `system`, `deal_external_id`, `status` (open, won, lost), `amount_cents`, `closed_at`, `observed_at`; pk (tenant, system, deal) | Each deal's latest state; a row only takes an event with a later `observed_at`. |
| `analytics.source_touch` | `tenant_id`, `account_id`, `source_id`, `source_level` (person, agent, vendor), `batch_id`, `arrival_id`, `first_seen_at` | Every source that ever sent the account, for the "any source" view. |
| `analytics.decline` | `tenant_id`, `account_id`, `kind` (review, assignment), `reason_key`, `note`, `by_user_id`, `source_id`, `at` | Decline reasons by source and seller |
| `analytics.step_credit` | `tenant_id`, `outcome_id`, `outcome_kind`, `step_id`, `step_type`, `playbook_template_id`, `practice_id`, `offer_id`, `occurred_at` | One row per credited step per outcome, for "what worked" |
| `analytics.cost_line` | `id` (`cst_`), `tenant_id`, `occurred_on` (tenant-timezone date), `category` (partner_fees, data_vendors, agents_hosting, lists_events, ai_usage), `provider` (usage lines), `amount_cents`, `origin` (usage, manual), `origin_event_id` (unique), `account_id`, `source_id`, `note`, `created_by`, `created_at`, `voided_at`, `void_reason`, `voided_by`, `replaces_id` | Ledger (R3a). Never changed in place: an edit voids the line ("Edited") and adds one with `replaces_id`. `source_id` (R3b-1) wins over the account's first source when spend is put per source. Batch, practice and offer targets, quantities and hours are later. |
| `analytics.cost_setting` | `tenant_id` (pk), `target_cost_per_won_cents` (null), `updated_by`, `updated_at` | The workspace's target cost per won account (R3b-1), no default. |
| `analytics.hour_rate` | `tenant_id`, `role_key`, `rate_cents_per_hour`, `effective_from` | For turning logged hours into cost. |
| `analytics.week` | `tenant_id`, `start_date` (Monday), `built_at`, `counts` (raw counts json) | Scorecard weeks; raw counts only. |
| `analytics.scorecard_target` | `tenant_id`, `metric_key`, `target`, `min_sample` | Targets and minimum samples per row. |
| `analytics.diagnosis` | `tenant_id`, `week_start`, `bottleneck`, `cause`, `summary`, `ai_run_id`, `edited_by`, `edited_at` | One per week. |
| `analytics.fix` | `id`, `diagnosis_id`, `text`, `owner_role`, `done`, `done_at`, `done_by` | Carries over until done. |
| `analytics.consumer_cursor` | `consumer`, `last_event_id`, `rebuilt_at` | Replay bookkeeping. |

## Depends on

Events only for its read models and numbers (Sources and intake, Accounts, Review and routing, CRM
sync, Playbooks, Enrichment, AI tasks, Integrations, Campaigns). Its consumers, domain functions and
services never call another module, except two reads: the stage consumer takes stage kinds from routing's
`listStages`, and `scout backfill-journeys` reads intake, routing, accounts and crm once (R3b-1 Ruling 14). The only synchronous reads are display labels (source names and
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
| `routing.stage.changed` | **the only source of stage timestamps after arrival**: records `to`'s entry in `journey_stage` at the event's `occurredAt` (earliest kept). A move to an exit stage later than the journey's `exit_at` sets `exit_stage` and `exit_at`; a later move to a flow stage clears `exit_stage`. Stage kinds come from routing's `listStages`. Review and routing owns stage tracking (REV-E4), including implied acceptance (the seller acts on the account in the CRM, or 2 working days pass with no decline). Analytics never re-derives stages from other events. |
| `intake.arrival.resolved` | creates the journey, or keeps whichever arrival is earlier by `occurredAt`: `first_source_id`, `first_batch_id` (the event's `batchId`) and `arrived_at` (the event's `occurredAt`); `source_touch` row (later) |
| `intake.batch.created` / `.completed` | batch labels and counts |
| `routing.assignment.accepted` | `seller_user_id`, `offer_id` on the journey |
| `routing.assignment.declined` | a row in `analytics.decline` (reason key, note, seller, source) for decline-reason reports |
| `routing.status.changed` | review decline reasons (status changed to a declined status) into `analytics.decline` |
| `crm.deal.changed` | upserts `journey_deal` (status, amount, closed at) when its `observedAt` is later than the stored one |
| `playbooks.outcome.recorded` | `analytics.step_credit` rows from `creditedStepIds`, for the "what worked" roll-up |
| `accounts.account.merged` | the survivor keeps the earlier arrival (and its first source and batch), the earliest entry into each stage and the merged account's deals; the merged account's journey is deleted |
| `scoring.account.scored` | `practice_id`, `offer_id` (`bestOfferId`) and `score_version`, when its `version` is higher than the stored one |
| `integrations.usage.recorded` | **the only** source of automatic cost lines (vendor credits, AI tokens, paid API usage): one `usage` line per event, deduped on the event id; `costCents` from the event, the category from the provider (`CATEGORY_OF_PROVIDER`), `occurred_on` the tenant-timezone date of `occurredAt`, the account from the event's `accountId` |
| `enrichment.request.completed` | no line of its own; will supply the account (and request id `enr_…`) for usage records with the same `correlationId` (R3b; not consumed in R3a) |
| `ai.run.completed` | no line of its own; will supply the account for AI usage records with the same `correlationId` (R3b; not consumed in R3a) |
| `campaigns.ad_spend.recorded` | auto cost line (ad spend, reported by the channel, not a costed call) |
| `playbooks.learning.recorded` | learnings count for the flywheel |
| `intake.source.trust_changed` | trust trend |

## Events published

| Event | Data |
|---|---|
| `analytics.cost.recorded` | `costLineId`, `origin`, `category`, `amountCents`, `currency`, `targetType`, `targetId`, `incurredOn`. Not published yet. |
| `analytics.diagnosis.created` | `weekStart`, `diagnosisId`, `bottleneck` |

## API endpoints

Fixed in `public-api/index.md` (JSON is `snake_case`):

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/analytics/funnel?by=source\|practice\|offer&from&to` | `analytics:read` | Funnel counts and conversion per stage. Optional extra query: `view` (cohort, activity), `attribution` (first, any), `source_level` (person, agent, vendor), `format=csv` |
| `GET /api/v1/costs?from&to&source_id` | `analytics:read` | Cost lines, with totals by category and target; `format=csv` |
| `POST /api/v1/costs` | `costs:write` | Add a manual cost line |

Built in R3a (the cost ledger), in place of `GET /costs` and `POST /costs` above:

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/costs/lines?category&from&to&include_voided&cursor` | `costs:read` | Cost lines, 50 a page, newest first (`occurred_on`, then when added); voided lines only with `include_voided=true` |
| `POST /api/v1/costs/lines` | `costs:write`, people only | Add a manual line `{ occurred_on, category, amount_cents, note, source_id }`; the amount must be above zero ("Enter an amount above zero."), the note up to 500 characters; an unknown or removed source gets 400 "Choose a source that exists." (R3b-1). Lines return `source_id` and `source_name` |
| `PATCH /api/v1/costs/lines/{id}` | `costs:write`, people only | Manual lines only (others get 409 "Only costs added by hand can be edited."): voids the line "Edited" and returns the new line with `replaces_id`; an edit that changes nothing returns the line as it is |
| `POST /api/v1/costs/lines/{id}:void` | `costs:write` | Void any line with `{ reason }` (required) |
| `GET /api/v1/costs/by-source` | `costs:read` | R3b-1: spend per top-level source over the last 90 days, rolled up, with share, per sent, per assigned, per won and return, then Shared costs and `total_spend_cents` (cost-ledger.md "Source target") |
| `PUT /api/v1/costs/target` | `budgets:write`, people only | R3b-1: `{ target_cost_per_won_cents }`, 1 or more, or null to clear ("Enter a target above zero, or clear it.") |

Proposed additions (to be added to `public-api/index.md` before R3; not yet in the fixed list):

| Method and path | Scope | Does |
|---|---|---|
| `POST /api/v1/costs/{id}:void` | `costs:write` | Void a line with a reason |
| `GET /api/v1/analytics/sources/{id}/performance` | `analytics:read`, or `status:read` limited to own source | One source's funnel, decline reasons and trust over time (backs `get_source_performance`) |
| `GET /api/v1/analytics/flywheel` | `analytics:read` | Quarterly trend numbers |
| `GET /api/v1/analytics/scorecard` | `analytics:read` | Weeks, targets, colours, rolling average |

## MCP tools

| Tool | Does |
|---|---|
| `get_source_performance` | For the calling agent's source (or any source the principal may see): arrivals, how far they got, cost per stage, trust trend. Lets an agent learn which of its submissions convert. |

## Open questions

- Attribution default is "first source" (the source of the account's first resolved arrival). Should
  warm intros override that and credit the introducer? Spec's call for R3: no, but intros show as their
  own source level in the "any source" view.
