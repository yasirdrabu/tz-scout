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
| `account_review` | `account_id` (pk with tenant), `status_key`, `status_changed_at`, `status_changed_by`, `lead_offer_override_id`, `insights` (markdown, leader notes), `insights_by`, `insights_at`, `current_assignment_id`, `stage`, `stage_changed_at`, `flags` (json: `conflicts`, `enrichment_requested`, `low_trust`) |
| `status_change` | `id`, `tenant_id`, `account_id`, `from_key`, `to_key`, `note`, `reason_key`, `by`, `at` |
| `assignment` | `id` (`asg_`), `tenant_id`, `account_id`, `seller_user_id`, `assigned_by`, `assigned_at`, `notes` (markdown), `template_id` (opaque id passed to Playbooks), `status` (`pending`, `accepted`, `declined`, `withdrawn`, `replaced`), `responded_at`, `accepted_how` (`seller`, `crm_activity`, `auto_timeout`), `decline_reason_key`, `decline_note`, `previous_assignment_id` |
| `stage_change` | `id`, `tenant_id`, `account_id`, `from_stage`, `to_stage`, `cause_event_id`, `at` |

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

## Events consumed

| Event | Does | Ordered by account |
|---|---|---|
| `intake.arrival.resolved` | create `account_review` with the initial status (if new) and stage `arrived` | yes |
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
| `POST /v1/assignments/{id}:accept` | `assignments:respond` | Seller accepts own assignment |
| `POST /v1/assignments/{id}:decline` | `assignments:respond` | Seller declines own assignment; reason key required |
| `POST /v1/assignments/{id}:withdraw` | `assign:act` | Withdraw or reassign |
| `GET /v1/accounts/{id}/status` | `status:read` | Stage, review status, owner name, last activity date (the agent follow-up call) |
| `GET /v1/settings/review`, `PUT /v1/settings/review` | `settings:manage` | Statuses, initial status rules, decline reasons |

## MCP tools

| Tool | Does |
|---|---|
| `get_account_status` | Input `account_id` or `arrival_id` (one required). Output shape fixed in `mcp/agent-tools.md`: `account_id`, `name`, `stage`, `review_status`, `tier`, `owner_name`, `last_activity_at`, `declined_reason`, `summary` (for example "Assigned to Ashkan on Oct 22. First email sent Oct 24."). Scope `status:read`; data-limited, so an agent limited to its own source sees only accounts it sent. |

## Open questions

- Should reviewers be limited per practice (a practice lead reviews only their practice)? Supported
  through data scopes (Tenancy); no separate rule here.
