# PLB-E2 Account plans

Release R2 · plans, steps, events, API and lists shipped in R2c-1 · screens in R2c-2 · account page,
CRM tasks and the stop rule in R2c-3

## Why

The seller runs the plan, mostly from the CRM. Scout keeps the plan, the steps and their state, so
progress is visible without asking. The leader chooses the playbook when assigning (or leaves the
tier's default); the plan starts when the seller accepts.

Out of R2c (user, 2026-11-04): outreach sequences, call prep, proposals and outcome logging.

## Rules

- **Drafts only (user, 2026-11-02).** No step sends anything. Email steps carry a rendered subject
  and body for the seller to send.
- **Start on accept (user, 2026-11-04).** A plan is created when an assignment is accepted: by the
  seller, automatically on timeout, or by CRM activity (`routing.assignment.accepted`). The start
  date is the accept time in the tenant's timezone. An assignment that is declined or withdrawn
  before acceptance never creates a plan.
- **Choosing the playbook (user, 2026-11-04).** In order:
  1. The assignment's choice. `template_id` set means that template; `no_playbook = true` means none.
  2. Otherwise the `offer_playbook` row for the account's lead offer and tier. The lead offer is
     `leadOfferOverrideId ?? bestOfferId`, and the tier is the account's tier, both read at accept
     time. With no row, no plan starts.
  3. A template that is archived or has been deleted is never started: no plan.
  When no plan starts, `playbooks.plan.not_started` says why.
- **Building a plan** (pure, `domain/plan.ts`).
  - Each step's due date is the start date plus `day` calendar days, moved to the next working day
    (Mon to Fri) in the tenant's timezone. It is a date. Example: accepted on a Friday, a day-1 step
    is due Monday.
  - `seller` steps go to the accepting seller, `leader` steps to the assigning leader (the `assignedBy`
    on the accepted event), `operator` steps to no one.
  - Each step is linked to the account's people holding any of its `target_buying_roles` with origin
    `stated` or `set_by_person`. Guessed roles don't count. If nobody holds the role, the step shows
    "No {role} on file" and a "Find" action (Enrichment; screen work in R2c-2).
  - Placeholders in `subject`, `body` and `detail` are rendered (see PLB-E1).
  - **Snapshot:** the plan keeps `template_id`, `template_version`, `offer_id`, `tier`, `stop_when`
    and the rendered steps (`origin: template`). Rescoring after accept, or editing the template,
    does not change a running plan; a template edit makes the plan read `newer_version: true`.
    `offer_id` and `tier` are null when the assigner picked a playbook for an account with no lead
    offer or no mappable tier.
- **One open plan per account.** An account has at most one plan that is `active` or `paused`
  (enforced by a partial unique index).
  - Accepting again: an accepted assignment for an account with a `paused` plan resumes it. Its open
    seller steps (`todo` or `in_progress`) move to the new seller, and no new plan is made.
  - An `active` plan blocks a new one (`not_started`, reason `plan_open`).
  - A redelivered `accepted` event makes no second plan (one plan per assignment).
  - If an account was merged, the plan starts or resumes on the survivor. When both accounts have an
    open plan at merge, the survivor's stays and the other is `abandoned` (reason `merged`).
- **Statuses:** `active`, `paused`, `completed`, `stopped` and `abandoned`. A closed plan
  (`completed`, `stopped`, `abandoned`) refuses changes with 409 "This plan has ended."
  - `paused`: by hand, or automatically when the accepted assignment is withdrawn (reason
    `withdrawn`). Seller step owners stay until a new acceptance resumes the plan.
  - `stopped`: the stop rule (stored from the template; enforced in R2c-3, which skips open steps and
    gives the reason). R2c-1 has the transition (`stopPlan`) but nothing calls it.
- **Step changes** (`playbooks:write`, people only; API keys are refused).
  - `PATCH` takes `status` (`todo`, `in_progress`, `done`, `skipped`), `note` (up to 2,000
    characters, "Keep this under 2,000 characters."), `owner_user_id` (an active member of the
    workspace, otherwise "Pick someone from this workspace.") and `due_date` (a real calendar date
    as `YYYY-MM-DD`; an impossible one such as 2026-02-31 is 400).
  - Done sets `done_at` and `done_by` and publishes `playbooks.step.completed`; moving a step off
    done clears them.
  - Pausing does not block step edits; only a closed plan does.
- **Plan actions:** pause, resume, complete and abandon. Abandon requires `reason` ("Say why you're
  abandoning it."). Complete needs every step `done` or `skipped`, otherwise 409 "Finish or skip
  every step first." Pausing a paused plan, or resuming an active one, returns it unchanged.
- **History.** Every change is recorded in `plan_change` (who, when, what: `created`, `paused`,
  `resumed`, `completed`, `abandoned`, `stopped`, `step_status`, `note`, `owner`, `due_date`), written
  to the audit log, and published as `playbooks.plan.changed`. History is newest first, capped at
  200.
- **Visibility.** Plans follow account visibility: outside the caller's data limit the account, the
  plan and every plan action are 404.
- **Not in R2c-1:** customising a plan (adding, editing or removing steps; `customised`) is R2c-3. A
  step done in the CRM marking the step done (`crm.activity.observed`), CRM tasks created from the
  plan and the stop rule are R2c-3.

## Where plans show (R2c-1 API)

- **Next step** (`nextSteps`): for each account's active or paused plan, the earliest open step
  (`todo` or `in_progress`) by due date, then order. Overdue and due today are judged against today
  in the tenant's timezone, and are false for done and skipped steps.
- `GET /api/v1/assignments` and `GET /api/v1/accounts` rows carry `playbook_name` and
  `next_step: {title, due_date, overdue, due_today}`, merged at the HTTP layer and filled only for
  callers with `playbooks:read` (otherwise both null).
  - An accepted assignment or an account shows the plan's name; `next_step` is null when the plan is
    paused or has nothing open. Accounts show only their open plan.
  - A pending assignment shows the playbook that will start (the assigner's pick, else the offer's
    tier mapping), null for "No playbook", for nothing mapped, or for an archived template. Declined,
    withdrawn and replaced rows show neither. Assignment rows also carry `template_id` and
    `no_playbook`.
  - One query per page, whatever its size.
- `GET /api/v1/me/counts` adds `next_steps_due_today` and `next_steps_overdue`: the caller's own
  `todo` and `in_progress` steps in active plans (null without `playbooks:read`).

## API

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/accounts/{id}/plan` | `playbooks:read` | The open plan, else the latest, else 404 |
| `PATCH /api/v1/plans/{id}/steps/{step_id}` | `playbooks:write` | Update a step (status, note, owner, due date); returns the whole plan |
| `POST /api/v1/plans/{id}:pause`, `:resume`, `:complete`, `:abandon` | `playbooks:write` | Plan actions; abandon takes `reason`; return the whole plan |
| `GET /api/v1/accounts/{id}/playbook-suggestion` | `assign:act` | For the assign dialog: `{playbook: {id, name, steps, days} \| null, reason: offer_tier \| none, offer: {id, name} \| null, tier}` |
| `POST /api/v1/accounts/{id}:assign` and bulk assign (`POST /api/v1/review-queue/bulk`, action `assign`) | `assign:act` | Take an optional `playbook_id` (see below) |

Plan shape: `{id, account_id, status, status_reason, playbook {id, name, version}, newer_version,
offer_id, tier, assignment_id, seller_user_id, start_date, stop_when, day, days, steps[], history[]}`.
`day` is the days from `start_date` to today in the tenant timezone (at least 0); `days` is the
largest step day. A step has `id`, `template_step_id`, `order`, `day`, `channel`, `owner_role`,
`owner_user_id`, `owner_name`, `title`, `detail`, `target_person_ids`, `due_date`, `status`,
`done_at`, `done_by`, `note`, `origin`, `crm_task`, `subject`, `body`, `overdue`, `due_today`.

**Assignment choice.** `playbook_id` is optional: absent means the tier default (stored as
`template_id = null, no_playbook = false`); `null` means "No playbook" (`no_playbook = true`); an id
is stored as `template_id` after the check that it is a non-archived template (400 "That playbook
isn't available." on `playbook_id`). Bulk assign takes one choice for the whole run, checked before
anything is assigned. A reassignment after a withdrawal keeps the leader's choice. The suggestion
route returns `reason: none` and a null playbook when there is no lead offer, no tier, nothing
mapped, or the mapped template is archived.

## Events

Published (shapes in `architecture/event-catalog.md`):

| Event | Data |
|---|---|
| `playbooks.plan.created` | `planId`, `accountId`, `offerId` and `tier` (null as above), `templateId`, `templateVersion`, `assignmentId`, `sellerUserId`, `stopWhen`, `steps[{id, order, day, channel, title, ownerUserId, dueDate, crmTask, subject, body}]` |
| `playbooks.plan.changed` | `planId`, `accountId`, `status`, `changed` (any of `status`, `steps`, `owners`), `reason?` |
| `playbooks.step.completed` | `planId`, `stepId`, `accountId`, `channel`, `doneBy`, `doneAt` |
| `playbooks.plan.not_started` | `accountId`, `assignmentId`, `reason`: `no_playbook_chosen`, `no_offer_playbook`, `template_archived` (also a deleted template) or `plan_open`; lets the screens explain an empty plan |

`plan.changed` is published for step edits (`steps`, plus `owners` when the owner moved), the four
plan actions (`status`), a withdrawal pause (`status`, reason `withdrawn`), a resume on accept
(`status`, `owners`), a stop (`status`, plus `steps` when open steps were skipped; reason is the stop
reason) and a merge abandon (`status`, reason `merged`).

Consumed: `routing.assignment.accepted` (start or resume the plan; carries `templateId`,
`noPlaybook` and `assignedBy`), `routing.assignment.withdrawn` (pause the plan of that assignment),
`accounts.account.merged` (repoint). A decline never has a plan, so it is not consumed.

## Stories

### PLB-E2-S1 Start a plan on accept
As a seller, I want the plan built when I accept, so that I start with clear steps.
- PLB-E2-S1-AC1 The assign dialog shows the playbook preselected from the offer and tier; the leader
  can change it or pick "No playbook". (API R2c-1, dialog R2c-2.)
- PLB-E2-S1-AC2 On accept, the plan exists within 2 seconds with every template step, owners and due
  dates set, and `playbooks.plan.created` is published. (R2c-1)
- PLB-E2-S1-AC3 An account never has two open plans; a second accept resumes a paused plan or does
  nothing. (R2c-1)

### PLB-E2-S2 Customise a plan (R2c-3)
As a leader, I want to add, remove and edit steps for one account, so that the plan fits what I know
about it.
- PLB-E2-S2-AC1 Each change records who and when and shows on the plan's history.
- PLB-E2-S2-AC2 Changes appear in the CRM tasks within seconds of saving (via CRM sync).
- PLB-E2-S2-AC3 Removing a step that is done is not allowed; it can be marked skipped instead.

### PLB-E2-S3 Run a plan (R2c-1 API, R2c-2 screens)
As a seller, I want to see and tick off my steps with notes, so that the leader sees progress without
asking.
- PLB-E2-S3-AC1 A step can move todo, in progress, done or skipped, with an optional note.
- PLB-E2-S3-AC2 Overdue steps (due date passed, not done) show as amber in the plan and count in
  `me/counts`.
- PLB-E2-S3-AC3 A plan whose steps are all done or skipped can be completed; a plan can be paused or
  abandoned with a reason.
