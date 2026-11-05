# PLB: Playbooks

Module code PLB · Schema `playbooks` · Releases R1 to R3

## Purpose

Turn a scored account into a plan people can run, and learn from how it went. This module owns:

- **Playbook templates** (day-based steps) that each offer maps to a tier (`offer_playbook`): the steps
  an ABM motion is made of. Drafts only: no step sends anything (user, 2026-11-02).
- **Account plans**: a template applied to one account when its assignment is accepted, run by the
  seller (customising by the leader is R2c-3).
- **The account brief**: the written one-pager (overview, why now, decision makers, approach, value
  angle, risks), drafted by Claude per practice and edited by people.
- **The account page** (layout A, chosen 2026-10-25): it composes data from Accounts, Scoring, Review
  and routing and CRM sync around the brief and the plan.
- **Outreach, call prep and review, proposals** (carried from v1; out of R2c).
- **Outcomes, the "what worked" score, retros and learnings** that feed back into templates.

## What it owns

| Table | Key fields |
|---|---|
| `playbook_template` | `id` (`plb_`), `tenant_id`, `name`, `description`, `when_to_use` (text), `status` (`draft`, `active`, `archived`), `stop_when` (`reply_or_meeting`, `meeting`, `never`), `version` (int, starts at 1), `created_by`, `updated_by`, `updated_at`. R2c-1. Not tied to a practice or offer (Decision 25) |
| `template_step` | `id` (`pls_`), `template_id`, `template_version`, `order`, `day` (int 0 to 365, 0 = start day), `channel` (`email`, `linkedin`, `call`, `meeting`, `task`), `owner_role` (`seller`, `leader`, `operator`), `title`, `detail` (markdown), `target_buying_roles` (text[]), `crm_task` (bool, default true), `subject`, `body` (email only). Unique on (template, version, order). R2c-1 |
| `offer_playbook` | `offer_id`, `tier` (`act_now`, `good_fit`, `watch`), `template_id`, `updated_by`, `updated_at`; key (tenant, offer, tier). R2c-1 |
| `account_plan` | `id` (`pln_`), `tenant_id`, `account_id`, `offer_id` and `tier` (both null when the assigner picked a playbook for an account with no lead offer or mappable tier), `template_id`, `template_version`, `assignment_id` (unique), `seller_user_id`, `status` (`active`, `paused`, `completed`, `stopped`, `abandoned`), `status_reason`, `accepted_at`, `stop_when` (snapshot), `start_date`, `created_at`, `updated_at`. One `active` or `paused` plan per account (partial unique index). R2c-1. `customised` (boolean, default false; R2c-3a), `engaged_at` (first reply or meeting since accept, nullable; R2c-3b), `no_reply_at` (when `plan.no_reply` fired, nullable; R2c-3b) |
| `plan_step` | `id` (`stp_`), `plan_id`, `template_step_id` (null if added by hand, R2c-3), `order`, `day`, `channel`, `owner_role`, `owner_user_id`, `title`, `detail`, `target_person_ids` (text[]), `target_buying_roles` (text[], copied from the template step; R2c-3a), `due_date`, `status` (`todo`, `in_progress`, `done`, `skipped`), `done_at`, `done_by`, `note`, `origin` (`template`, `added`, `edited`), `crm_task`, `subject`, `body`; `crm_task_ref` (set by CRM sync via event) arrives with R2c-3. R2c-1 |
| `plan_change` | `id` (`pch_`), `plan_id`, `step_id`, `kind`, `detail` (json), `by`, `at`: the plan's history. R2c-1 |
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
| PLB-E1 Playbook templates | [playbook-templates.md](playbook-templates.md) | R2 (data and API R2c-1, screens R2c-2) |
| PLB-E2 Account plans | [account-plans.md](account-plans.md) | R2 (plans, API and events R2c-1; screens R2c-2; account page plan view and customising R2c-3a; CRM tasks and stop rule R2c-3b) |
| PLB-E3 Account brief | [account-brief.md](account-brief.md) | R1 (core sections, handoff package), R2 (practice templates, custom fields) |
| PLB-E4 Account page | [account-page.md](account-page.md) | R1 (review view), R2 (full layout A) |
| PLB-E5 Outreach, calls and proposals | [outreach-calls-and-proposals.md](outreach-calls-and-proposals.md) | R2 |
| PLB-E6 Outcomes and what worked | [outcomes-and-what-worked.md](outcomes-and-what-worked.md) | R3 |
| PLB-E7 Retros and learnings | [retros-and-learnings.md](retros-and-learnings.md) | R3 |

## Events published

| Event | Data |
|---|---|
| `playbooks.plan.created` | `planId`, `accountId`, `offerId`, `tier` (both null when no lead offer or mappable tier), `templateId`, `templateVersion`, `assignmentId`, `sellerUserId`, `stopWhen`, `steps` (id, order, day, channel, title, ownerUserId, dueDate, crmTask, subject, body) |
| `playbooks.plan.changed` | `planId`, `accountId`, `status`, `changed` (any of `status`, `steps`, `owners`, `account`), `reason?`, `previousAccountId?` and `steps[{id, order, day, channel, title, detail, subject, body, status, ownerUserId, dueDate, crmTask}]` (`{id, removed: true}` for a removed step); see account-plans.md |
| `playbooks.step.completed` | `planId`, `stepId`, `accountId`, `channel`, `doneBy`, `doneAt` |
| `playbooks.plan.no_reply` | `planId`, `accountId`, `assignmentId`, `at`: the last step closed and nobody replied or booked since accept; once per plan, the plan's status does not change |
| `playbooks.plan.not_started` | `accountId`, `assignmentId`, `reason` (`no_playbook_chosen`, `no_offer_playbook`, `superseded`, `template_unavailable`) |
| `playbooks.outcome.recorded` | `outcomeId`, `accountId`, `kind`, `occurredAt`, `source`, `amountCents`, `creditedStepIds` |
| `playbooks.learning.recorded` | `retroId`, `accountId`, `result`, `templateId`, `proposalIds` |
| `playbooks.brief.updated` | `accountId`, `sectionKeys`, `origin` |

## Events consumed

| Event | Does | Ordered by account |
|---|---|---|
| `scoring.account.scored` | draft the brief the first time an account reaches act now or good fit (if AI is connected; rules otherwise); mark `why_now` stale when best offer changes | yes |
| `routing.assignment.accepted` | start the plan (the assignment's choice, else the offer's tier playbook), or resume a paused one; R2c-1 | yes |
| `routing.assignment.withdrawn` | pause the plan of that assignment; R2c-1 | yes |
| `crm.activity.observed` | mark matching plan steps done (CRM task completed); stop the plan by its stop rule; record reply and meeting outcomes (R2c-3 and later) | yes |
| `crm.deal.changed` | record opportunity, won, lost outcomes; prompt a retro on won or lost | yes |
| `campaigns.meeting.held` | record a `meeting` outcome (R4) | yes |
| `accounts.account.merged` | repoint plans (R2c-1), briefs and outcomes to the survivor | yes |
| `jobs.history.republish` | re-publish stored plan, step and outcome events with `replay: true` (see events-and-async.md) | no |

## Implements for other modules

- CRM's `HandoffPackageProvider` (PLB-E3-S4, R1): everything the CRM note and tasks need.

## API endpoints

JSON field names are snake_case.

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/accounts/{id}/brief` | `playbooks:read` | Brief sections with citations, custom fields, committee and gaps, plan summary |
| `PUT /api/v1/accounts/{id}/brief/sections/{key}` | `playbooks:write` | Replace a section's body, optional `if_version` (people and agents with the scope) |
| `POST /api/v1/accounts/{id}:draft-brief` | `playbooks:write` | Redraft the brief now, optional `include_edited` (page section keys); 202 |
| `GET /api/v1/accounts/{id}/plan` | `playbooks:read` | The open plan, else the latest, with steps and history (R2c-1) |
| `PATCH /api/v1/plans/{id}/steps/{step_id}` | `playbooks:write` | Update a step (status, note, owner, due date; content fields since R2c-3a) |
| `POST /api/v1/plans/{id}/steps`, `DELETE /api/v1/plans/{id}/steps/{step_id}` | `playbooks:write` | Add or remove a step on one plan (R2c-3a) |
| `POST /api/v1/plans/{id}:pause`, `:resume`, `:complete`, `:abandon` | `playbooks:write` | Plan actions (R2c-1) |
| `GET /api/v1/accounts/{id}/playbook-suggestion` | `assign:act` | The playbook the assign dialog preselects (R2c-1) |
| `POST /api/v1/accounts/{id}/outcomes` | `playbooks:write` | Record a reply, meeting, opportunity, won or lost |
| `GET /api/v1/playbooks`, `GET /api/v1/playbooks/{id}` | `playbooks:read` | Templates (R2c-1) |
| `POST /api/v1/playbooks`, `PATCH /api/v1/playbooks/{id}`, `POST /api/v1/playbooks/{id}:duplicate`, `:archive`, `DELETE /api/v1/playbooks/{id}` | `playbooks:manage` | Create, edit, duplicate, retire and delete templates (R2c-1); accept or reject proposals (R3) |
| `GET /api/v1/offers/{id}/playbooks` | `offers:read` | The offer's playbook per tier and its first email (R2c-1) |
| `PUT /api/v1/offers/{id}/playbooks/{tier}` | `offers:manage` or `playbooks:manage` | Set or clear one tier (R2c-1) |

## MCP tools

| Tool | Does |
|---|---|
| `get_account_brief` | Input `account_id`, optional `sections`. Output shape fixed in `mcp/agent-tools.md`: `sections[]` (`key`, `title`, `text`, `citations`, `written_by`: `claude`, `rules` or `person`), `committee[]`, `gaps[]` (buying-role keys), `plan` (`playbook`, `steps[]`). Scope `playbooks:read`; people's contact details only with `people:read`. |

## Open questions

- Should AEs be able to edit the template from an account (not just the account plan)? No in this
  version; they propose via retro.
