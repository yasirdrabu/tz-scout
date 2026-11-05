# R2c-3b HubSpot plan tasks, stop rule and "playbook no reply" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan steps with `crm_task` become HubSpot tasks that follow the plan, a reply or meeting stops the plan by its stop rule, a task done in HubSpot marks its step done, and a plan whose last step closes with no reply moves the account by the `playbook_no_reply` stage trigger.

**Architecture:** CRM reads the current plan through a new optional `planTasks` method on the existing `HandoffPackageProvider` port (playbooks implements it, `src/entry/compose.ts` already registers the provider). Plan events only queue a per-account `crm.plan.sync` job that reconciles the whole plan with `crm.task_link`, so the job is idempotent and order-proof. Playbooks consumes `crm.activity.observed` for the stop rule and CRM-completed tasks, and publishes a new `playbooks.plan.no_reply` event that routing turns into the stage move.

**Tech Stack:** TypeScript, Drizzle + Postgres (RLS), outbox + NATS consumers and jobs, vitest integration tests with the mock HubSpot adapter.

**Spec:** `docs/spec/playbooks/account-plans.md`, `docs/spec/playbooks/playbook-templates.md` (stop rule), `docs/spec/crm-sync/handoff-push.md` (CRM-E3-S4), `docs/spec/crm-sync/follow-through-and-deals.md` (CRM-E5-S2-AC2), `docs/spec/review-and-routing/configurable-stages.md` (`playbook_no_reply`). Code map: `docs/plans/2026-11-04-r2c-3-plans-crm.map.md` sections 2-5 and 7.

## Product decisions (user, 2026-11-04)

1. On accept, the open fixed HubSpot tasks (first touch, follow-ups) are closed with the note "Replaced by the {playbook} playbook." Done ones are left alone. Without a plan the fixed tasks stay as they are today.
2. Every plan step with `crm_task` becomes a task, whatever its owner role (overrides CRM-E3-S4-AC3's "owned by the seller").
3. Pause leaves the plan's tasks open. Skip, done, stop, complete, abandon and removing a step close them.
4. `playbook_no_reply` fires when the last open step closes and there was no reply or meeting since accept. Never when they replied.
5. Drafts only: an email step's task carries the draft; the AE sends it.

## Rulings (controller, 2026-11-04)

1. **Port.** `HandoffPackageProvider` gains optional `planTasks?(ctx, accountId): Promise<PlanTasks | null>`; no new registration. The latest plan of the account (open, else most recent), or null.
2. **Store.** Plan tasks live in `crm.task_link` only (never `crm.link`), with new columns `account_id`, `plan_id`, `fingerprint`, and status `open | closed | done` (`closed` = Scout closed it, `done` = seen completed in the CRM). Index on `(tenant_id, system, external_task_id)`. The handoff undo keeps touching only the fixed tasks.
3. **Wanted open** = plan `active` or `paused`, step `crm_task`, step `todo` or `in_progress`. Every other linked step with an `open` link is closed.
4. **Task text.** Subject `{title} ({account name})`. Body lines, blank-line separated: for an email step with a draft, `Draft email (send it yourself)` then `Subject: {subject}` then the body; then the step detail if any; last `From the {playbook} playbook in Scout: {scoutUrl}` (the same URL the handoff note uses, `handoff.ts:236`).
5. **Due.** 17:00 in the tenant timezone on the step's `due_date`.
6. **Owner.** The step owner's CRM owner, else the plan seller's, else null.
7. **Person.** The first of the step's people with a CRM person link, else the account's primary person link, else none.
8. **Close notes** (exact copy): step done "Marked done in Scout."; step skipped "Skipped in Scout."; step removed or `crm_task` turned off "Taken out of the {playbook} playbook."; plan stopped "The {playbook} playbook stopped: {reason}."; plan completed "The {playbook} playbook was completed."; plan abandoned "The {playbook} playbook was abandoned."; fixed task replaced "Replaced by the {playbook} playbook."
9. **Reopened step.** A step back to `todo`/`in_progress` whose link is `closed` or `done` gets a new task (upsert without `externalId`), per CRM-E3-S4-AC4.
10. **Fixed tasks.** "The account has a plan for this handoff" = `planTasks` returns a plan that is `active`/`paused`, or whose `assignmentId` equals the handoff's. Then `runPush` creates no fixed tasks, and the plan sync closes the handoff's open fixed tasks (links `<assignmentId>:first_touch|follow_up:*`) with note 8.
11. **Change detection.** `fingerprint` = sha1 of subject, body, owner, person, due. An `open` link with the same fingerprint makes no CRM call.
12. **When.** `crm.plan.sync {accountId}` is queued by CRM consumers of `playbooks.plan.created` and `playbooks.plan.changed` (every change, including status-only ones with `steps: []`), and at the end of a completed `runPush`. With no completed handoff for the account it does nothing (the push queues it later). It takes `lockAccount` and follows `syncJob`'s handling of usage limits and retryable errors.
13. **Stop rule.** On `crm.activity.observed` kind `reply` or `meeting` with `occurredAt >= plan.accepted_at`, for the account's `active` or `paused` plan: set `engaged_at` (first time only, whatever `stop_when`), then stop when `stop_when` matches (`reply_or_meeting`: both; `meeting`: meeting; `never`: none). Reasons (exact): "They replied" and "They booked a meeting". The card already reads "Stopped: {reason}".
14. **Done in HubSpot.** `task_done` with a `stepId`, for a step that is `todo`/`in_progress` on an `active`/`paused` plan: step `done`, `done_at` = event `occurredAt`, `done_by` null, history `step_status` with detail `{ from, to: 'done', source: 'crm' }`, and the usual `plan.changed` + `step.completed` (`doneBy: null`). Anything else is ignored. CRM does not publish `task_done` for a link it closed itself (status `closed`).
15. **No reply.** After a step status change (person or CRM) or a step removal, if the plan is `active`, has at least one step, all steps are `done`/`skipped`, `engaged_at` is null and `no_reply_at` is null: set `no_reply_at = now` and publish `playbooks.plan.no_reply` v1 `{ planId, accountId, assignmentId, at }`. Once per plan; the plan's status does not change (Complete stays manual). Stop, abandon and complete never fire it.
16. **Stage move.** Routing consumes `playbooks.plan.no_reply` with `moveStage(ctx, accountId, [{ trigger: 'playbook_no_reply' }], e.id)` and a snapshot when it moved. `moveFor` refuses a `playbook_no_reply` move when the current stage is at or past the first flow stage with a `BEYOND_ACCEPTANCE` trigger, so an Engaged account never goes back to nurture. Routing imports `@/modules/playbooks/contracts/events` (contracts only, allowed by lint).
17. **Not in R2c-3b:** a merge moving plan tasks to the survivor's company; reopening a task in HubSpot; account-page UI for tasks (the card already shows status and reason).

## Global Constraints

- Tests run on the throwaway embedded Postgres (port 54329) and a private NATS, per `.superpowers/sdd/2026-11-04-r2c-3a-account-plan/test-env.md` in the main repo `C:\dev\tz-scout` (copy it into this plan's workspace). `DATABASE_URL`/`DATABASE_ADMIN_URL` use the `scout_app`/`scout_admin` roles; the superuser goes only in `DATABASE_SUPERUSER_URL`.
- Never run `npm run db:migrate` against `localhost:5432`, never touch `C:\dev\tz-scout` or the dev services on 5432/4222. Work only in `C:\dev\tz-scout-crmsync`.
- Migrations are generated with `npx drizzle-kit generate` (per module config), never hand-written or hand-edited.
- Module code imports another module only via its `index.ts` or `contracts/**`. CRM and routing never import playbooks services.
- Every new table column keeps RLS as is (columns only, no new tables).
- Event payloads are zod schemas via `defineEvent`; new event v1 goes in `docs/spec/architecture/event-catalog.md` and `docs/spec/playbooks/index.md`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Scout closes a task, the next poll sees it completed.** No `task_done` is published and the skipped step never turns done (Task 4 test "a task Scout closed is not reported done").
2. **Plan accepted before the handoff push finished.** No fixed tasks are created and the plan's tasks appear once the push completes (Task 4 test "plan first, push later").
3. **A reply logged before accept** (history in HubSpot) does not stop the plan or count as engaged (Task 1 test "activity before accept is ignored").
4. **An Engaged account whose last step closes** never moves to Back to nurture, even when `engaged_at` is missing (Task 2 unit test on `moveFor`).
5. **Every plan step tick queues a sync**; unchanged tasks make no CRM call (Task 3 test "a second sync with no change writes nothing").

---

### Task 1: Playbooks — stop rule, done in HubSpot, no-reply event

**Files:**
- Modify: `src/modules/playbooks/db/schema.ts` (`account_plan.engaged_at`, `account_plan.no_reply_at`, both nullable timestamps)
- Create: generated migration `src/modules/playbooks/db/migrations/0007_*.sql`
- Modify: `src/modules/playbooks/contracts/events.ts` (`planNoReply`)
- Create: `src/modules/playbooks/services/crm-activity.ts`
- Modify: `src/modules/playbooks/services/plans.ts` (call `checkNoReply` after status changes in `updateStep` and after `removeStep`)
- Modify: `src/modules/playbooks/consumers.ts` (`planOnCrmActivity`, ordered by account)
- Modify: `docs/spec/playbooks/account-plans.md`, `docs/spec/playbooks/index.md`, `docs/spec/architecture/event-catalog.md`
- Test: `tests/integration/playbooks/stop-rule.test.ts`

**Interfaces:**
- Consumes: `activityObserved` from `@/modules/crm/contracts/events`; `stopPlan(ctx, planId, reason)`, `recordChange`, `publishChanged` from `plans.ts`.
- Produces: `planNoReply = defineEvent('playbooks.plan.no_reply', 1, z.object({ planId: z.string(), accountId: z.string(), assignmentId: z.string(), at: z.string() }))`; `onCrmActivity(e, ctx): Promise<void>` and `checkNoReply(ctx, planId): Promise<void>` in `services/crm-activity.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/playbooks/stop-rule.test.ts`, building accepted plans with the helpers in `tests/integration/playbooks/plans.test.ts:42-75` and delivering `activityObserved` with `publishTestEvent` + `runPlaybooks`:
  - `a reply stops a reply_or_meeting plan`: status `stopped`, `status_reason` "They replied", open steps `skipped`, history kind `stopped`.
  - `a meeting stops a meeting plan; a reply does not`: reply leaves it `active` with `engaged_at` set; meeting stops it with "They booked a meeting".
  - `a never plan is not stopped but records engaged_at`.
  - `a paused plan is stopped too`.
  - `activity before accept is ignored`: `occurredAt` one minute before `accepted_at` → still `active`, `engaged_at` null.
  - `task_done marks its step done`: step `done`, `done_by` null, `done_at` = occurredAt, one `playbooks.step.completed` with `doneBy: null`.
  - `task_done for a skipped step or a closed plan changes nothing`, and `task_done with stepId null changes nothing`.
  - `the last step closing with no reply publishes plan.no_reply once`: tick every step done/skipped as a person → one `playbooks.plan.no_reply` with planId, accountId, assignmentId; reopen and close again → still one; plan status still `active`.
  - `no no_reply after a reply` (engaged_at set, stop_when `never`), and `none on stop or abandon`.
  - `removing the last open step fires no_reply`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/playbooks/stop-rule.test.ts` — expected FAIL (no consumer, no event).
- [ ] **Step 3: Implement** the schema columns, generate the migration, add `planNoReply`, write `services/crm-activity.ts` per Rulings 13-15, register `planOnCrmActivity` in `consumers.ts` and the module's consumer list, and call `checkNoReply` inside the same transaction where `updateStep` changes status and where `removeStep` runs. The CRM-done step change goes through a system path (no visibility check, actor null), reusing `snapshot`/`recordChange`/`publishChanged`.
- [ ] **Step 4: Run** the new test file plus `tests/integration/playbooks` and `tests/integration/v1/plans.test.ts` — expected PASS.
- [ ] **Step 5: Docs.** account-plans.md: replace the "Not in R2c-3a (R2c-3b)" bullet with the stop rule, done-in-HubSpot and no-reply rules (Rulings 13-15); playbook-templates.md "R2c-3 acts on it" stays true. index.md: `account_plan` row gains `engaged_at`, `no_reply_at`; events table gains `playbooks.plan.no_reply`. event-catalog.md: add the event with its payload and consumer (routing).
- [ ] **Step 6: Commit** `feat(playbooks): stop rule, done in HubSpot, no-reply event`.

### Task 2: Routing — `playbook_no_reply` stage move

**Files:**
- Modify: `src/modules/routing/domain/pipeline.ts` (`moveFor` guard)
- Modify: `src/modules/routing/services/crm-events.ts` or a new `services/playbook-events.ts` (`onPlanNoReply`)
- Modify: `src/modules/routing/consumers.ts` (`routingPlanNoReply`, ordered by account)
- Modify: `docs/spec/review-and-routing/configurable-stages.md` (the guard, one line)
- Test: `tests/unit/routing/pipeline.test.ts` (or the existing `moveFor` unit file), `tests/integration/routing/stage-triggers.test.ts`

**Interfaces:**
- Consumes: `planNoReply` from `@/modules/playbooks/contracts/events` (Task 1).
- Produces: `onPlanNoReply(e, ctx): Promise<void>`.

- [ ] **Step 1: Failing unit tests** for `moveFor` with `DEFAULT_STAGES`: from `accepted` (the `ae_accepts` stage) `[{ trigger: 'playbook_no_reply' }]` → `'back_to_nurture'`; from `engaged` → `null`; from `meeting` → `null`; a custom list with no `BEYOND_ACCEPTANCE` stage moves from any flow stage but Won.
- [ ] **Step 2: Failing integration tests** in `stage-triggers.test.ts`: `publishTestEvent(planNoReply, …)` for an accepted account → stage `back_to_nurture`, one `stage_change` with that cause; delivered twice → still one; for an Engaged account → unchanged; a workspace that renamed the exit stage moves to its key (stage keys never hardcoded in the service).
- [ ] **Step 3: Run** both — expected FAIL.
- [ ] **Step 4: Implement** the guard in `moveFor` (Ruling 16) and the consumer: `lockRow`, skip merged, `moveStage(ctx, accountId, [{ trigger: 'playbook_no_reply' }], e.id)`, `publishReviewSnapshot` when moved.
- [ ] **Step 5: Run** the two files plus `tests/unit/routing` and `tests/integration/routing` — expected PASS.
- [ ] **Step 6: Commit** `feat(routing): move on playbook ends with no reply`.

### Task 3: CRM — plan task sync

**Files:**
- Modify: `src/modules/crm/contracts/ports.ts` (`planTasks?`), `src/modules/crm/contracts/types.ts` (`PlanTasks`)
- Modify: `src/modules/playbooks/services/package.ts` (implement `planTasks`), `src/modules/playbooks/services/plans.ts` if a read helper is needed
- Modify: `src/modules/crm/db/schema.ts` (`task_link` columns + index, Ruling 2); generated migration `src/modules/crm/db/migrations/0013_*.sql`
- Modify: `src/modules/crm/domain/tasks.ts` (`dueAtOn`, `planTaskSpec`)
- Create: `src/modules/crm/services/plan-tasks.ts` (`syncPlanTasks`)
- Modify: `src/modules/crm/contracts/jobs.ts` (`planSyncJob`), `src/modules/crm/jobs.ts` (handler, in `crmJobHandlers`), `src/modules/crm/consumers.ts` (`crmPlanCreated`, `crmPlanChanged` → enqueue), `src/modules/crm/index.ts`
- Test: `tests/unit/crm/plan-tasks.test.ts`, `tests/integration/crm/plan-tasks.test.ts`

**Interfaces:**
- Consumes: `planCreated`, `planChanged` from `@/modules/playbooks/contracts/events`; adapter `upsertTask`, `closeTask`; `crmOwnerId`; `lockAccount`, `latestRow`/the latest completed handoff; `tenantTimezone`.
- Produces:
  ```ts
  export type PlanTasks = {
    planId: string; assignmentId: string; playbookName: string; status: 'active' | 'paused' | 'completed' | 'stopped' | 'abandoned';
    statusReason: string | null; sellerUserId: string | null;
    steps: { id: string; channel: 'email' | 'linkedin' | 'call' | 'meeting' | 'task'; title: string; detail: string | null;
      subject: string | null; body: string | null; status: 'todo' | 'in_progress' | 'done' | 'skipped';
      ownerUserId: string | null; dueDate: string; crmTask: boolean; personIds: string[] }[];
  };
  export function dueAtOn(date: string, timezone: string): string; // 17:00 tenant time, ISO
  export function planTaskSpec(i: { step: PlanTasks['steps'][number]; accountName: string; playbookName: string; scoutUrl: string }): { subject: string; body: string };
  export async function syncPlanTasks(ctx: ModuleContext, accountId: string, now: Date): Promise<void>;
  export const planSyncJob = defineJob('crm.plan.sync', z.object({ accountId: z.string() }), { timeoutMs: 120_000 });
  ```
  `planTasks` follows merges the way `getPlan` does and needs no visibility (system read).

- [ ] **Step 1: Failing unit tests** (`tests/unit/crm/plan-tasks.test.ts`): `dueAtOn('2026-11-18', 'America/New_York')` → `'2026-11-18T22:00:00.000Z'`, and in `'Asia/Kolkata'` → `'2026-11-18T11:30:00.000Z'`; `planTaskSpec` for an email step with a draft gives subject `Intro email (Acme)` and body `Draft email (send it yourself)\n\nSubject: Hello\n\nHi Ana\n\nFrom the Standard outbound playbook in Scout: https://x/t/taazaa/accounts/acc_1`; for a call step with detail, body is `{detail}\n\nFrom the …`.
- [ ] **Step 2: Failing integration tests** (`tests/integration/crm/plan-tasks.test.ts`, mock HubSpot, an account handed off and accepted with a playbook, using `handedOff()` from `tests/integration/crm/activity.test.ts:36-60` and the playbooks helpers, with `import '@/entry/compose'` and `runOutbox`):
  - `accept creates a task per crm_task step`: `mock_task` rows with the subject, body, due (Ruling 5), owner `mock-<sellerId>`; `task_link` rows `open` with account and plan ids; steps without `crm_task` have none.
  - `accept closes the open fixed tasks`: the first-touch and follow-up `mock_task`s are `completed` with "Replaced by the {playbook} playbook." in the body; a fixed task completed before accept keeps its body.
  - `step done, skipped, removed each close the task with its note` (Ruling 8).
  - `editing a step updates its task in place` (same external id, new subject/due/owner).
  - `a second sync with no change writes nothing`: count adapter calls (mock call log or `setMockFailure` spy pattern the CRM tests use) — zero `upsertTask`/`closeTask`.
  - `pause leaves tasks open; resume after reassignment moves them to the new seller`.
  - `stop, complete and abandon close every open task` with the plan note.
  - `a reopened step gets a new task` (different external id, link `open`).
  - `an operator step with no owner goes to the plan seller`.
  - `no completed handoff: the sync does nothing`.
- [ ] **Step 3: Run** both — expected FAIL.
- [ ] **Step 4: Implement** the port method (playbooks side builds `PlanTasks` from the latest plan; `personIds` from the step's people as R2c-3a computes them at read), the columns and generated migration, `dueAtOn` (reuse the private `dueOn` math), `planTaskSpec`, `syncPlanTasks` per Rulings 3-12 (one write per CRM call, link row updated right after each call, like `recordLink` in `runPush`), the job + handler, and the two consumers that enqueue `planSyncJob`.
- [ ] **Step 5: Run** the two files plus `tests/unit/crm`, `tests/integration/crm` and `tests/integration/playbooks` — expected PASS.
- [ ] **Step 6: Commit** `feat(crm): HubSpot tasks follow the account plan`.

### Task 4: CRM — handoff and follow-through with plan tasks

**Files:**
- Modify: `src/modules/crm/services/handoff.ts` (`runPush`: skip fixed tasks per Ruling 10; enqueue `planSyncJob` after a completed push)
- Modify: `src/modules/crm/services/follow-through.ts` (poll plan task ids too; on a turned-done plan task set the link `done`; no `task_done` for a `closed` link)
- Modify: `docs/spec/crm-sync/handoff-push.md` (CRM-E3-S4-AC3: every `crm_task` step, any owner; fixed tasks replaced on accept; pause leaves tasks open), `docs/spec/crm-sync/index.md` (`task_link` columns; consumers row: plan events queue `crm.plan.sync`; `step.completed` row folded into it), `docs/spec/crm-sync/follow-through-and-deals.md` (CRM-E5-S2-AC2: not for tasks Scout closed)
- Test: `tests/integration/crm/plan-tasks.test.ts` (extend), `tests/integration/crm/handoff.test.ts` or the push test file that covers fixed tasks

**Interfaces:**
- Consumes: `planTasks` (Task 3), `planSyncJob`, `task_link` columns.
- Produces: nothing new.

- [ ] **Step 1: Failing tests:**
  - `plan first, push later`: accept (plan active) before the push job runs → after `runOutbox` no fixed `mock_task`s exist and the plan tasks do.
  - `re-push after the plan ended creates no fixed tasks` (plan `completed`, same assignment, `isRepush`).
  - `a push with no plan still creates the fixed tasks` (today's behaviour, regression).
  - `a task done in HubSpot marks the step done`: `mockCompleteTask` on a plan task, `pollActivity`/`syncAccount`, `runOutbox` → step `done`, link `done`, and the task's `closeTask` is not called afterwards.
  - `a task Scout closed is not reported done`: skip a step (task closed), then sync → no `crm.activity.observed` with kind `task_done` for it, step stays `skipped`.
  - `full chain`: assign → push → accept → tasks → `mockAddActivity` kind `reply` after accept → sync → plan `stopped` "They replied", every plan task `completed` with "The {playbook} playbook stopped: They replied.", stage moved by the reply (Engaged).
  - `full chain no reply`: tick every step done → `playbooks.plan.no_reply` → stage `back_to_nurture`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the push skip and the queue at the end of the push, and the follow-through changes: the poll's `taskIds` add `task_link.external_task_id` rows for the account and system; `turnedDone` for a link with status `closed` is recorded in the stored task list but not observed; for an `open` link set it `done` before publishing.
- [ ] **Step 4: Run** `tests/integration/crm`, `tests/integration/playbooks`, `tests/integration/routing`, `tests/unit` — expected PASS; then `npm run lint` and `npm run typecheck` clean.
- [ ] **Step 5: Docs** as listed in Files.
- [ ] **Step 6: Commit** `feat(crm): plan tasks replace the fixed tasks and report done`.

## Verification (controller)

- Full suites: unit, integration, web, e2e on the throwaway stack.
- scout-verify (`verify-up-<name>.sh` copy pointing at `C:\dev\tz-scout-crmsync`): assign an account with a playbook, accept as the seller, check the mock HubSpot tasks (Integrations or the mock tables), tick a step and see its task close, add a reply with the mock fixture, see the plan stopped "They replied" on the account page.
