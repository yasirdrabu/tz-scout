# PLB: Playbooks

Module code PLB · Schema `playbooks` · Releases R1 to R3

## Purpose

Turn a scored account into a plan people can run, and learn from how it went. This module owns:

- **Playbook templates** per practice and per offer: the plays and steps an ABM motion is made of.
- **Account plans**: a template applied to one account, customised by the leader, run by the AE.
- **The account brief**: the written one-pager (overview, why now, decision makers, approach, value
  angle, risks), drafted by Claude per practice and edited by people.
- **The account page** (layout A, chosen 2026-10-25): it composes data from Accounts, Scoring, Review
  and routing and CRM sync around the brief and the plan.
- **Outreach, call prep and review, proposals** (carried from v1).
- **Outcomes, the "what worked" score, retros and learnings** that feed back into templates.

## What it owns

| Table | Key fields |
|---|---|
| `playbook_template` | `id` (`plb_`), `tenant_id`, `scope` (`practice`, `offer`), `practice_id`, `offer_id` (when scope offer), `name`, `description`, `motion` (`one_to_one`, `one_to_few`, `one_to_many`), `when_to_use` (text), `version` (int), `status` (`draft`, `active`, `archived`), `updated_by`, `updated_at` |
| `template_step` | `id`, `template_id`, `template_version`, `order`, `week_offset` (int, 0 = week 1), `duration_days`, `type` (`email`, `call`, `linkedin`, `event`, `procurement`, `research`, `content`, `meeting`, `other`), `title`, `guidance` (text), `owner_role` (`seller`, `leader`, `operator`), `target_buying_roles` (text[]), `crm_task` (bool, default true) |
| `account_plan` | `id` (`pln_`), `tenant_id`, `account_id`, `offer_id`, `template_id`, `template_version`, `status` (`draft`, `active`, `paused`, `completed`, `abandoned`), `start_date`, `assignment_id`, `customised` (bool), `created_by`, `created_at` |
| `plan_step` | `id` (`stp_`), `plan_id`, `template_step_id` (null if added by hand), `order`, `type`, `title`, `guidance`, `owner_user_id`, `target_person_ids` (text[]), `due_date`, `status` (`todo`, `in_progress`, `done`, `skipped`), `done_at`, `done_by`, `note`, `origin` (`template`, `added`, `edited`), `crm_task_ref` (set by CRM sync via event) |
| `brief` | `account_id`, `tenant_id`, `offer_id`, `template_key`, `created_at`, `updated_at` |
| `brief_section` | `account_id`, `key` (`overview`, `what_they_do`, `potential_size`, `why_now`, `decision_makers`, `approach`, `value_angle`, `risks`, plus practice-defined keys), `body` (markdown), `citations` (text[] of `fct_` and `sig_` ids), `origin` (`ai`, `human`, `rules`), `ai_run_id`, `edited_by`, `edited_at`, `version` |
| `brief_template` | `key`, `tenant_id`, `practice_id`, `sections` (json: key, label, instructions for Claude, order, required) |
| `brief_field_def` | `id`, `tenant_id`, `practice_id`, `key`, `label`, `type` (`text`, `number`, `money`, `select`, `date`), `options` (text[]), `show_in_strip` (bool), `order` |
| `brief_field_value` | `account_id`, `field_def_id`, `value` (json), `source_id` (if it came in an arrival), `edited_by`, `edited_at` |
| `outreach_sequence` | `account_id`, `person_id`, `steps` (json: step, day, purpose, subject, body), `ai_run_id`, `edited_by` |
| `call_prep`, `call_review`, `proposal` | carried from v1 (`src/ai/callPrep.ts`, `callReview.ts`, `proposal.ts`) with `account_id` |
| `outcome` | `id`, `tenant_id`, `account_id`, `kind` (`reply`, `meeting`, `opportunity`, `won`, `lost`, `no_response`), `occurred_at`, `source` (`crm`, `manual`, `agent`), `ref` (CRM activity or deal id), `amount_cents`, `note`, `recorded_by`, `credited_step_ids` (text[]) |
| `account_result` | `account_id`, `what_worked_score` (0 to 100), `highest_outcome`, `computed_at` |
| `retro` | `id`, `account_id`, `result` (`won`, `lost`, `stalled`), `what_worked`, `what_didnt`, `learnings` (text[]), `written_by`, `written_at`, `ai_run_id` (if drafted) |
| `template_edit_proposal` | `id`, `template_id`, `retro_id`, `change` (json: add, remove or edit step), `reason`, `status` (`proposed`, `accepted`, `rejected`), `decided_by`, `decided_at` |

## Depends on

| Module | Calls |
|---|---|
| Accounts | account, people with buying roles, signals, facts with conflicts |
| Offers and practices | offer, practice defaults, matching case studies |
| Scoring and matching | current score and explanation |
| Review and routing | review status, assignment, stage (read for the page) |
| CRM sync | CRM links and recent activity (read for the page) |
| AI tasks | `account_brief` (why now, angle, opener, who first; R1), `brief_sections` (R2), `committee_gaps`, `outreach_sequence`, `call_prep`, `call_review`, `proposal`, `retro_summary`. Every AI claim cites the fact and signal ids it used. |

## Epics

| Epic | File | Release |
|---|---|---|
| PLB-E1 Playbook templates | [playbook-templates.md](playbook-templates.md) | R2 |
| PLB-E2 Account plans | [account-plans.md](account-plans.md) | R2 |
| PLB-E3 Account brief | [account-brief.md](account-brief.md) | R1 (core sections, handoff package), R2 (practice templates, custom fields) |
| PLB-E4 Account page | [account-page.md](account-page.md) | R1 (review view), R2 (full layout A) |
| PLB-E5 Outreach, calls and proposals | [outreach-calls-and-proposals.md](outreach-calls-and-proposals.md) | R2 |
| PLB-E6 Outcomes and what worked | [outcomes-and-what-worked.md](outcomes-and-what-worked.md) | R3 |
| PLB-E7 Retros and learnings | [retros-and-learnings.md](retros-and-learnings.md) | R3 |

## Events published

| Event | Data |
|---|---|
| `playbooks.plan.created` | `planId`, `accountId`, `offerId`, `templateId`, `templateVersion`, `assignmentId`, `steps` (id, title, type, ownerUserId, dueDate, crmTask) |
| `playbooks.plan.changed` | `planId`, `accountId`, `added`, `removed`, `edited` (step ids), `status` |
| `playbooks.step.completed` | `planId`, `stepId`, `accountId`, `type`, `doneBy`, `doneAt` |
| `playbooks.outcome.recorded` | `outcomeId`, `accountId`, `kind`, `occurredAt`, `source`, `amountCents`, `creditedStepIds` |
| `playbooks.learning.recorded` | `retroId`, `accountId`, `result`, `templateId`, `proposalIds` |
| `playbooks.brief.updated` | `accountId`, `sectionKeys`, `origin` |

## Events consumed

| Event | Does | Ordered by account |
|---|---|---|
| `scoring.account.scored` | draft the brief the first time an account reaches act now or good fit (if AI is connected; rules otherwise); mark `why_now` stale when best offer changes | yes |
| `routing.assignment.created` | create the account plan from the template chosen at assignment | yes |
| `routing.assignment.declined` | set plan to `paused`, clear step owners | yes |
| `crm.activity.observed` | mark matching plan steps done (CRM task completed); record reply and meeting outcomes | yes |
| `crm.deal.changed` | record opportunity, won, lost outcomes; prompt a retro on won or lost | yes |
| `campaigns.meeting.held` | record a `meeting` outcome (R4) | yes |
| `accounts.account.merged` | repoint plans, briefs and outcomes to the survivor | yes |
| `jobs.history.republish` | re-publish stored plan, step and outcome events with `replay: true` (see events-and-async.md) | no |

## Implements for other modules

- CRM's `HandoffPackageProvider` (PLB-E3-S4, R1): everything the CRM note and tasks need.

## API endpoints

JSON field names are snake_case.

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/accounts/{id}/brief` | `playbooks:read` | Brief sections with citations, custom fields, committee and gaps, plan summary |
| `PATCH /api/v1/accounts/{id}/brief/sections/{key}` | `playbooks:write` | Edit a section (people and agents with the scope) |
| `GET /api/v1/accounts/{id}/plan` | `playbooks:read` | The account plan and steps |
| `PATCH /api/v1/plans/{id}/steps/{step_id}` | `playbooks:write` | Update a step (status, owner, due, note) |
| `POST /api/v1/accounts/{id}/outcomes` | `playbooks:write` | Record a reply, meeting, opportunity, won or lost |
| `GET /api/v1/playbooks`, `GET /api/v1/playbooks/{id}` | `playbooks:read` | Templates |
| `POST /api/v1/playbooks`, `PATCH /api/v1/playbooks/{id}` | `playbooks:manage` | Create and edit templates; accept or reject proposals |

## MCP tools

| Tool | Does |
|---|---|
| `get_account_brief` | Input `account_id`, optional `sections`. Output shape fixed in `mcp/agent-tools.md`: `sections[]` (`key`, `title`, `text`, `citations`, `written_by`: `claude`, `rules` or `person`), `committee[]`, `gaps[]` (buying-role keys), `plan` (`playbook`, `steps[]`). Scope `playbooks:read`; people's contact details only with `people:read`. |

## Open questions

- Should AEs be able to edit the template from an account (not just the account plan)? No in this
  version; they propose via retro.
