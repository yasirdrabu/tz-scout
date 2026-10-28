# REV: Review and routing

Module code REV · Schema `routing` · Releases R1 to R3

## Purpose

The human gate between scoring and the CRM. Accounts land in a review queue with a status; a person
with the review permission looks, adds what they know, and either declines, sends back, or assigns to
a seller. The seller accepts or declines with a reason. This module also keeps each account's stage
(arrived to won) so anyone, including an agent, can ask "where is this account now".

People decide (D6). Nothing reaches a CRM without an assignment made by a person.

## What it owns

| Table | Key fields |
|---|---|
| `review_status_def` | `id`, `tenant_id`, `key`, `label`, `order`, `counts_as_reviewed` (bool), `is_declined` (bool), `is_initial` (bool), `returns_to_source` (bool), `tone` (`neutral`, `near`, `good`, `bad`), `archived_at` |
| `initial_status_rule` | `tenant_id`, `source_kind` (`agent`, `vendor`, `person`, `import`, `crm`, `form`), `source_id` (nullable, overrides kind), `status_key` |
| `decline_reason_def` | `id`, `tenant_id`, `key`, `label`, `applies_to` (`review`, `assignment`, `both`), `archived_at` |
| `account_review` | `account_id` (pk with tenant), `status_key`, `status_changed_at`, `status_changed_by`, `lead_offer_override_id`, `insights` (markdown, leader notes), `insights_by`, `insights_at`, `current_assignment_id`, `stage`, `stage_changed_at`, `flags` (json: `newFrom {sourceId, at}`, `declinedBySeller {assignmentId, sellerUserId, sellerName, reasonKey, reasonLabel, at}`; `conflicts`, `enrichment_requested`, `low_trust` come later), `version` (bumped by every write), `merged_into` (set when merged away; the row is then read-only) |
| `status_change` | `id`, `tenant_id`, `account_id`, `from_key`, `to_key`, `note`, `reason_key`, `by`, `at` |
| `assignment` | `id` (`asg_`), `tenant_id`, `account_id`, `seller_user_id`, `assigned_by`, `assigned_at`, `notes` (markdown), `template_id` (opaque id passed to Playbooks), `status` (`pending`, `accepted`, `declined`, `withdrawn`, `replaced`), `responded_at`, `accepted_how` (`seller`, `crm_activity`, `auto_timeout`), `decline_reason_key`, `decline_note`, `previous_assignment_id` |
| `stage_change` | `id`, `tenant_id`, `account_id`, `from_stage`, `to_stage`, `cause_event_id`, `at` |
| `routing_setting` | `tenant_id`, `auto_accept_working_days` (1 to 10, or null for off; default 2) |

Stages (D15): `arrived`, `reviewed`, `assigned`, `engaged`, `opportunity`, `won`; exits `lost`,
`declined`. The stage tracker on the account page also shows "In CRM" between assigned and engaged,
derived from the handoff status (not a funnel stage).

## Depends on

| Module | Calls |
|---|---|
| Tenancy and access | permission and data-scope checks; list of sellers (members with the seller capability) |
| Accounts | account summary for the queue |
| Scoring and matching | current score, tier, best offer for queue sorting and filters |
| CRM sync | `preflightOwnership(accountId, sellerUserId)` before assignment; handoff status for the stage tracker |

Review and routing does not call Playbooks: the assign dialog's playbook picker is rendered by the
account page (Playbooks owns the page) and passed in as `templateId`. In R1 there is no playbook
picker: the assign dialog sends `templateId: null` and no plan is created; the picker arrives in R2
with plans (spec's call, D27).

## Epics

| Epic | File | Release |
|---|---|---|
| REV-E1 Review statuses and queue | [review-statuses-and-queue.md](review-statuses-and-queue.md) | R1 (configurable statuses R2) |
| REV-E2 Assignment, acceptance and decline | [assignment-and-decline.md](assignment-and-decline.md) | R1 |
| REV-E3 Ownership and handoff trigger | [ownership-and-handoff-trigger.md](ownership-and-handoff-trigger.md) | R1 |
| REV-E4 Stage tracking and account status | [stage-tracking-and-status.md](stage-tracking-and-status.md) | R1 |

## Events published

| Event | Data |
|---|---|
| `routing.status.changed` | `accountId`, `from`, `to`, `countsAsReviewed`, `isDeclined`, `returnsToSource`, `note`, `reasonKey`, `by` |
| `routing.assignment.created` | `assignmentId`, `accountId`, `sellerUserId`, `assignedBy`, `templateId`, `offerId` (lead offer), `notes`, `ownershipDecision` (`assign`, `keep`), `previousAssignmentId` |
| `routing.assignment.accepted` | `assignmentId`, `accountId`, `sellerUserId`, `acceptedHow` |
| `routing.assignment.declined` | `assignmentId`, `accountId`, `sellerUserId`, `reasonKey`, `note` |
| `routing.assignment.withdrawn` | `assignmentId`, `accountId`, `by`, `replacedBy` (assignment id or null) |
| `routing.stage.changed` | `accountId`, `from`, `to`, `causeEventId` |
| `routing.review.changed` | `accountId`, `version`, `snapshot` (`reviewStatusKey`, `ownerUserId`, `ownerHistoryUserIds`, `hasOpenAssignment`, `stage`, `reviewFlags`). Published once at the end of every write to an account's review (creation, status, assignment, flags, stage, merge); Accounts keeps its summary from it. `ownerHistoryUserIds` are the sellers of assignments that were accepted (by the seller, CRM activity or timeout) and later ended |

A stage move's `cause_event_id` is suffixed by the action (`<id>:accepted`, `:declined`, `:withdrawn`, `:replaced`).

## Events consumed

| Event | Does | Ordered by account |
|---|---|---|
| `tenancy.tenant.created` | seed review statuses, decline reasons, the auto-accept setting and the hourly `routing.assignments.auto_accept` schedule | no |
| `intake.arrival.resolved` | create `account_review` with the initial status (if new; the source's status when it names an active one, else `unvetted`) and stage `arrived`; on an account with an open assignment set `newFrom`, which ends with the assignment | yes |
| `scoring.account.scored` | refresh queue sort fields; flag `low_trust` | yes |
| `accounts.conflict.detected` / `.resolved` | set or clear the conflicts flag | yes |
| `enrichment.request.flagged` / `.completed` | set or clear the enrichment flag | yes |
| `crm.handoff.completed` / `.failed` | update handoff status for the tracker; on failure notify the assigner | yes |
| `crm.activity.observed` | implicit acceptance (REV-E2); stage engaged on reply or meeting | yes |
| `playbooks.outcome.recorded` | stage engaged on reply or meeting | yes |
| `crm.deal.changed` | stage opportunity, won, lost | yes |
| `accounts.account.merged` | move review, assignments and history to the survivor | yes |
| `tenancy.member.removed` | open assignments of that seller go back to the assigner as `withdrawn` | no |
| `jobs.history.republish` | re-publish stored status, assignment and stage events with `replay: true` (events-and-async.md) | no |

## API endpoints

| Method and path | Scope | Does |
|---|---|---|
JSON field names are snake_case.

| Method and path | Scope | Does |
|---|---|---|
| `GET /v1/review-queue?status&practice_id&offer_id&source_id&tier&flag&cursor` | `review:act` | The queue, data-scoped |
| `PATCH /v1/accounts/{id}/review-status` | `review:act` | Change review status with note or reason (send back, decline, reopen) |
| `PUT /v1/accounts/{id}/insights` | `review:act` | Leader insights |
| `POST /v1/accounts/{id}:assign` | `assign:act` | Create an assignment; 202 |
| `POST /v1/assignments/{id}:accept` | `assignments:respond` | Seller accepts own assignment (checked by ownership of the assignment, not account visibility; another seller gets 404) |
| `POST /v1/assignments/{id}:decline` | `assignments:respond` | Seller declines own assignment, pending or already accepted; reason key required. The stage returns to `reviewed` |
| `POST /v1/assignments/{id}:withdraw` | `assign:act` | Withdraw or reassign. Only the person who assigned it or an owner-role member may; anyone who can assign can still end it by assigning the account to someone else |
| `POST /v1/accounts/{id}:seen` | `assignments:respond` | The assigned seller clears "New from" |
| `GET /v1/accounts/{id}/status` | `status:read` | Stage, review status, owner name, last activity date (the agent follow-up call); also `declined_note` and `send_back_note`. An `arr_` id may stand in for the account id |
| `GET /v1/review-queue/count`, `POST /v1/review-queue/bulk` | `review:act` | Count for the same filters; bulk status or assign for at most 50 accounts |
| `GET /v1/settings/review`, `PUT /v1/settings/review` | `settings:manage` | Statuses, initial status rules, decline reasons |

## MCP tools

| Tool | Does |
|---|---|
| `get_account_status` | Input `account_id` or `arrival_id` (one required). Output shape fixed in `mcp/agent-tools.md`: `account_id`, `name`, `stage`, `review_status`, `tier`, `owner_name`, `last_activity_at`, `declined_reason`, `summary` (for example "Assigned to Ashkan on Oct 22. First email sent Oct 24."). Scope `status:read`; data-limited, so an agent limited to its own source sees only accounts it sent. |

## Rules fixed in R1b

- The default queue view is accounts with no open assignment and either a status that does not count as reviewed or the `declined_by_seller` flag; the flag clears when the account is assigned again.
- Assigning a declined account is refused (409 "Reopen it before assigning."). "Approve and assign" uses the first status by order that counts as reviewed and is not declined. Changing to a declined status first withdraws an open assignment. Changing to the current status does nothing.
- Auto-acceptance counts working days as Monday to Friday in the tenant's timezone, holidays ignored; from a weekend it counts from the next working day's midnight.
- The ownership preflight is a port (`OwnershipPreflight`); with no CRM it answers `new` ("New in the CRM"). Its results are `new`, `assign`, `stop` and `blocked`.
- "Arrived since" in the queue means the account's first arrival; a later arrival surfaces through "New from".
- The low-trust flag is R3.

## Open questions

- Should reviewers be limited per practice (a practice lead reviews only their practice)? Supported
  through data scopes (Tenancy); no separate rule here.
