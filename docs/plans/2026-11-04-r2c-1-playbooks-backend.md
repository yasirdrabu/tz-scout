# R2c-1: playbooks backend (templates, a playbook per offer and tier, plans on accept)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Templates:** leaders build playbook templates (steps by day, with a stop rule).
- **Offers:** each offer picks a playbook for each of Act now, Good fit and Watch.
- **Plans:** when a seller accepts an assignment, the account gets a plan from that playbook, with owners, due dates and drafted emails. A leader can override the choice when assigning.
- **Running:** plans can be read and their steps updated.
- **Lists:** the next step and its due date reach My accounts and All accounts.

This plan is the backend only. R2c-2 builds the screens, and R2c-3 builds the account-page plan view, HubSpot task sync and the stop rule.

**Architecture:**
- **Playbooks:** new tables `playbook_template`, `template_step`, `offer_playbook`, `account_plan` and `plan_step`, in migration 0002 with RLS. The domain code is pure: due dates, owners, placeholder rendering and next step.
- **Routing:** the assignment stores the leader's playbook choice. Routing never imports playbooks, so the HTTP layer checks the choice against playbooks.
- **Starting a plan:** a playbooks consumer on `routing.assignment.accepted` resolves the template and builds the plan.
- **Lists and counts:** the HTTP routes merge `nextSteps` from playbooks into the assignment and account list rows and into `me/counts`.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest.

**Spec:**
- `docs/spec/playbooks/{index.md, playbook-templates.md, account-plans.md}`
- `docs/spec/web-ui/api-gaps.md` Decision 25
- `docs/spec/web-ui/screens.md` §6, §7, §8, §19 and §20

Decision 25 and the user's answers win over the older playbooks spec text. Task 6 rewrites that text.

Code map: `docs/plans/2026-11-04-r2c-playbooks.map.md`. Read it before any task.

## Rulings (user answers 2026-11-02 and 2026-11-04 marked; the rest are Claude's calls; Task 6 writes them into the specs)

1. **(User) Drafts only.** No step sends anything. An email step holds a drafted subject and body that the seller sends. There is no auto-send mode or field.
2. **(User) Start on accept.** A plan is created when an assignment is accepted, whether by the seller, automatically on timeout, or by CRM activity. The start date is the accept time in the tenant's timezone. An assignment that is declined or withdrawn before acceptance never creates a plan.
3. **(User) Choosing the playbook.** The order is:
   - The assignment's choice comes first. `template_id` set means that template. `no_playbook = true` means none.
   - Otherwise, the `offer_playbook` row for the account's lead offer and tier. The lead offer is `leadOfferOverrideId ?? bestOfferId` and the tier is `account_summary.tier`, both read at accept time.
   - With no row, no plan starts. Nurture and Not a fit never have a row. Only `act_now`, `good_fit` and `watch` may be mapped.
   - An archived template is never started. With an archived template the result is no plan, and the event below says so.
4. **(User) Stop rule.**
   - **Stored, not acted on here:** each template has `stop_when`: `reply_or_meeting` (default), `meeting` or `never`. Plans snapshot it. R2c-3 acts on it.
   - **Statuses:** `active`, `paused`, `completed`, `stopped` and `abandoned`.
   - **Pause:** pausing is by hand, or happens automatically when an accepted assignment is withdrawn.
5. **(User) Out of R2c:** outreach sequences, call prep, proposals and outcome logging.
6. **Templates.**
   - **Fields:** `name` (required, "Give the playbook a name."), `description`, `when_to_use`, `status` (`draft`, `active`, `archived`), `stop_when`, `version` (starts at 1), `updated_by` and `updated_at`.
   - **Who:** create and edit need `playbooks:manage`.
   - **Versioning:** saving an `active` template with any step change bumps `version` and writes the new step set under that version. Old versions stay readable with `?version=`. Changes to a `draft` template edit its steps in place.
   - **Activating:** a template needs at least one step before it can be `active`, otherwise 400 "Add at least one step."
   - **Duplicate:** copies the template as a draft named "{name} (copy)".
   - **Archive:** the template stops being chosen, and running plans are untouched.
   - **Delete:** allowed only when no plan ever used the template and no `offer_playbook` row points at it. Otherwise 409 "This playbook has run on accounts. Retire it instead."
7. **Steps.**
   - **Fields:** `order`, `day` (integer 0-365; day 0 is the start day), `channel`, `owner_role` (`seller`, `leader` or `operator`), `title` (required), `detail` (markdown guidance), `target_buying_roles` (keys), `crm_task` (bool, default true), and for `email` only `subject` and `body`.
   - **Channels:** `email`, `linkedin`, `call`, `meeting` and `task`, the mockup's set. They replace the spec's nine types.
   - **Ordering:** days need not be unique. Steps are ordered by `order`.
8. **Placeholders.** These may appear in an email's `subject` and `body` and in `detail`, and are rendered when the plan is built:
   - `{account.name}`, `{offer.name}`, `{offer.promise}` and `{seller.first_name}`;
   - `{person.first_name}`, the first person linked to the step. With no one linked it renders "there" in an email and "the contact" elsewhere.

   An unknown placeholder is left as written. Templates store the raw text.
9. **Building a plan** (pure, `src/modules/playbooks/domain/plan.ts`).
   - **Due dates:** each step's due date is the start date plus `day` calendar days, moved to the next working day (Mon-Fri) in the tenant's timezone. It is stored as a date.
   - **Owners:** `seller` steps go to the accepting seller, `leader` steps to the assigning leader, and `operator` steps to no one.
   - **Linked people:** each step is linked to the account's people holding any of its `target_buying_roles` with origin `stated` or `set_by_person`. Guesses don't count.
   - **Snapshot:** the plan keeps its `template_id`, `template_version`, `offer_id`, `tier`, `stop_when` and the rendered steps (`origin: 'template'`).
10. **One open plan per account.** An account has at most one plan that is `active` or `paused`.
    - **Accepting again:** an accepted assignment for an account with a `paused` plan resumes that plan. Its open seller steps move to the new seller, and no new plan is made.
    - **Already active:** an `active` plan blocks a new one, and the consumer does nothing.
11. **Plan and step changes** (`playbooks:write`).
    - **Step update:** `PATCH /api/v1/plans/{id}/steps/{step_id}` takes `status` (`todo`, `in_progress`, `done` or `skipped`), `note` (up to 2,000 characters), `owner_user_id` (a member) and `due_date`. Done sets `done_at` and `done_by`, and publishes `playbooks.step.completed`.
    - **Plan actions:** `POST /api/v1/plans/{id}:pause`, `:resume`, `:complete` and `:abandon`. Abandon requires `reason`. Complete needs every step `done` or `skipped`, otherwise 409 "Finish or skip every step first."
    - **Closed plans:** a closed plan (`completed`, `stopped` or `abandoned`) refuses changes with 409 "This plan has ended."
    - **History:** every change is recorded in `plan_change` (who, when, what) and publishes `playbooks.plan.changed`.
    - **Not here:** adding, editing or removing plan steps (customising) is R2c-3.
12. **Events** (`defineEvent`, added to the event catalog):
    - `playbooks.plan.created` carries `planId`, `accountId`, `offerId`, `tier`, `templateId`, `templateVersion`, `assignmentId`, `sellerUserId`, `stopWhen` and `steps[{id, order, day, channel, title, ownerUserId, dueDate, crmTask, subject, body}]`.
    - `playbooks.plan.changed` carries `planId`, `accountId`, `status`, `changed: ('status' | 'steps' | 'owners')[]` and `reason?`.
    - `playbooks.step.completed` carries `planId`, `stepId`, `accountId`, `channel`, `doneBy` and `doneAt`.
    - `playbooks.plan.not_started` carries `accountId`, `assignmentId` and `reason` (`no_playbook_chosen`, `no_offer_playbook`, `template_archived` or `plan_open`), so R2c-2 and R2c-3 can explain an empty plan.
13. **Assignment choice.**
    - **Assign API:** `POST /api/v1/accounts/{id}:assign` and the bulk assign accept an optional `playbook_id`: a template id, or `null` for "No playbook".
    - **Stored on the assignment:** absent means the tier default (Ruling 3), stored as `template_id = null, no_playbook = false`. `null` means `no_playbook = true`. An id is stored as `template_id`.
    - **Check:** the HTTP layer checks the id is a non-archived template (400 "That playbook isn't available."). Routing gains a `no_playbook` column and passes both on `routing.assignment.created` and `.accepted` (the accepted event gains `templateId` and `noPlaybook`).
    - **Suggestion:** `GET /api/v1/accounts/{id}/playbook-suggestion` (`assign:act`) returns `{playbook: {id, name, steps, days} | null, reason: 'offer_tier' | 'none', offer: {id, name} | null, tier}` for the assign dialog.
14. **Offer playbooks.**
    - **Read:** `GET /api/v1/offers/{id}/playbooks` (`offers:read`) returns, for each of `act_now`, `good_fit` and `watch`, `{tier, playbook: {id, name, status, steps, days} | null, first_email: {subject, body} | null}`. `first_email` is the raw template text of the first email step, and is the offer page's initial message.
    - **Set:** `PUT /api/v1/offers/{id}/playbooks/{tier}` (`offers:manage`) with `{playbook_id | null}` sets or clears the mapping. It refuses an unknown tier (400) or an archived template (400 "That playbook isn't available.").
    - **Where it lives:** `offer_playbook` belongs to playbooks. The offers routes call playbooks at the HTTP layer.
15. **Next step.** `nextSteps(ctx, accountIds)` returns, for each account's open plan, the earliest step by due date, then order, among `todo` and `in_progress`.
    - **Shape:** `{plan_id, playbook_name, title, due_date, overdue, due_today}`, where overdue and due today are judged against today in the tenant's timezone.
    - **Lists:** `GET /api/v1/assignments` and `GET /api/v1/accounts` fill `next_step` and `playbook_name`, both null without a plan, merged at the HTTP layer.
    - **Counts:** `GET /api/v1/me/counts` adds `next_steps_due_today` and `next_steps_overdue` for steps the caller owns.
16. **Reads.**
    - **Plan:** `GET /api/v1/accounts/{id}/plan` (`playbooks:read`) returns the open plan, else the latest plan, else 404.
    - **Plan shape:** `{id, status, playbook {id, name, version}, newer_version: boolean, start_date, stop_when, day: n, days: n, steps[...], history[...]}`.
    - **Templates:** `GET /api/v1/playbooks` lists templates with `steps`, `days`, `channels` (counts by channel), `runs_on` (offer and tier pairs) and `running` (count of active plans). `GET /api/v1/playbooks/{id}` returns one with its steps.
    - **Visibility:** plans follow account visibility (404 outside the data limit).
17. **Seeds.**
    - **Templates:** one active template per seeded Taazaa practice, built in `playbooks/defaults.ts` and seeded when a tenant is created. "Public sector RFP" belongs to AI Operating Platforms and has 4 steps:
      - day 0: register as a county vendor and set alerts (task, seller);
      - day 3: capability brief to the business owner (email, seller, business_owner);
      - day 14: request an industry day through contracts (task, seller, commercial_buyer);
      - day 21: conference presence and operator teaming (meeting, leader).
    - **Other practices:** each gets a 4-step "Standard outbound":
      - day 0 intro email, with the opening email written in plain language;
      - day 3 LinkedIn connect;
      - day 7 follow-up email;
      - day 14 call.
    - **Offer mapping:** each seeded offer's `act_now` and `good_fit` are mapped to its practice's template; `watch` stays empty.
    - **Existing workspaces:** they get no back-fill.

## Global Constraints

- Never run `npm run db:migrate`, `db:push`, or anything against the dev database (`localhost:5432/scout`, its workspace databases or the template). Never touch anything under `C:\dev\tz-scout` or the dev NATS server. Tests use their own databases.
- Module boundaries: routing, offers and CRM never import playbooks. Cross-module calls go through `index.ts`, and ids are not foreign keys. All new tables have `tenant_id`, RLS and new ids `plb_`, `pls_`, `pln_`, `stp_` (check `platform/ids.ts` for existing prefixes).
- Copy (exact): "Give the playbook a name.", "Add at least one step.", "This playbook has run on accounts. Retire it instead.", "That playbook isn't available.", "Finish or skip every step first.", "This plan has ended.", "Say why you're abandoning it."
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Accepted twice** (a redelivered `assignment.accepted`). Exactly one plan exists. Test in Task 4.
2. **Rescored after accept, so the tier changed.** The running plan keeps its template and version (snapshot). Test in Task 4.
3. **Accept on a Friday with a day-1 step.** Due Monday, in the tenant's timezone, not UTC. Test in Task 1.
4. **Template edited while plans run.** Running plans keep their version and read `newer_version: true`. Test in Tasks 2 and 4.
5. **A seller outside the account's data limit**, or an agent key. 404 on the plan, and 403 on `playbooks:manage` routes. Test in Task 4.

---

### Task 1: Schema and pure domain

**Files:**
- Create:
  - `src/modules/playbooks/db/migrations/0002_*.sql` (+meta, generated with drizzle-kit, then the RLS SQL appended as 0000 does)
  - `src/modules/playbooks/domain/{plan.ts, placeholders.ts, next-step.ts}`
  - `tests/unit/playbooks/{plan,placeholders,next-step}.test.ts`
- Modify: `src/modules/playbooks/db/schema.ts` (tables `playbook_template`, `template_step`, `offer_playbook`, `account_plan`, `plan_step`, `plan_change`), `src/platform/ids.ts`, the RLS catalog test if it lists tables.
- Test: `tests/integration/playbooks/schema.test.ts` pattern (run in the full integration project).

**Interfaces (produces):**
- `buildPlan({template, steps, startDate, timezone, sellerUserId, leaderUserId, people, account, offer, seller}): PlanDraft`, following Rulings 8 and 9.
- `render(text, vars, context: 'email' | 'detail')`.
- `pickNextStep(steps, today)` and `dueFlags(dueDate, today)`.

- [ ] **Step 1: Failing unit tests.**
  - A Friday 2026-11-06 start with a day-1 step is due 2026-11-09. Day 0 on a Saturday is due the following Monday.
  - Owners follow the roles.
  - A step for `business_owner` is linked only to stated or set people, so a guessed person is not linked.
  - `{person.first_name}` with no one linked renders "there" in an email and "the contact" in detail. An unknown `{foo}` is kept as written.
  - The next step is the earliest due open step. `overdue` and `due_today` are judged against `today`.
- [ ] **Step 2: Failing schema test.** RLS is on for every new table, and one tenant can't read another's rows.
- [ ] **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/unit/playbooks tests/integration/playbooks/schema.test.ts tests/integration/platform/migrate.test.ts`. **Step 5: Commit** `feat(playbooks): plan tables and domain`.

### Task 2: Templates, offer playbooks and seeds

**Files:**
- Create:
  - `src/modules/playbooks/services/{templates.ts, offer-playbooks.ts}`
  - `src/http/routes/v1/playbooks/route.ts`, `src/http/routes/v1/playbooks/[id]/route.ts` (with `:duplicate` and `:archive` via `byAction`)
  - `src/http/routes/v1/offers/[id]/playbooks/route.ts` and `[tier]/route.ts`
  - Register all of them in `src/http/routes.ts`.
- Modify: `src/modules/playbooks/{index.ts, defaults.ts}`, the tenant-created seeding path.
- Test: `tests/integration/playbooks/templates.test.ts`, `tests/integration/v1/playbooks-templates.test.ts`

**Interfaces (produces):**
- `createTemplate`, `updateTemplate`, `getTemplate(ctx, id, version?)`, `listTemplates`, `duplicateTemplate`, `archiveTemplate`, `deleteTemplate`.
- `offerPlaybooks(ctx, offerId)`, `setOfferPlaybook(ctx, offerId, tier, templateId | null)`, `playbookFor(ctx, offerId, tier)`.

- [ ] **Step 1: Failing tests.** Cover Rulings 6, 7, 14 and 17:
  - Version bump on an active template, and `?version=1` still readable.
  - Activating with no steps gives 400 with the copy.
  - Delete after use gives 409.
  - Duplicate is a draft named "(copy)".
  - `PUT` with an archived template gives 400.
  - `first_email` is the first email step.
  - A new tenant gets the seed templates and mappings. "Public sector RFP" has the four steps listed in Ruling 17.
  - A seller gets 403 on create; a leader succeeds.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/playbooks tests/integration/v1/playbooks-templates.test.ts`. **Step 4: Commit** `feat(playbooks): templates and offer playbooks`.

### Task 3: The assignment's playbook choice

**Files:**
- Modify:
  - `src/modules/routing/{db/schema.ts (+ migration: no_playbook boolean not null default false), services/assign.ts, contracts/events.ts, services/respond.ts}` (`assignment.accepted` gains `templateId` and `noPlaybook`)
  - `src/http/routes/v1/accounts/[id]/route.ts` (`:assign`), the bulk-assign route, the review-queue bulk route if it assigns
- Create: `src/http/routes/v1/accounts/[id]/playbook-suggestion/route.ts`
- Test: `tests/integration/routing/assign.test.ts`, `tests/integration/v1/routing.test.ts` (or a new `playbook-choice.test.ts`)

- [ ] **Step 1: Failing tests.**
  - With `playbook_id` absent, the event carries `templateId: null, noPlaybook: false`.
  - With `null`, `noPlaybook: true`.
  - With an id, the id is carried. An archived or unknown id gives 400 "That playbook isn't available."
  - Accepted events, from all three accept paths, carry the choice.
  - The suggestion returns the tier mapping, or `null` with `reason: 'none'` for a Nurture account.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/routing tests/integration/v1/routing.test.ts`. **Step 4: Commit** `feat(routing): playbook choice on assignment`.

### Task 4: Plans start on accept and run

**Files:**
- Create: `src/modules/playbooks/services/{plans.ts, start.ts}`, `src/http/routes/v1/accounts/[id]/plan/route.ts`, `src/http/routes/v1/plans/[id]/route.ts` (actions), `src/http/routes/v1/plans/[id]/steps/[stepId]/route.ts`
- Modify: `src/modules/playbooks/{consumers.ts, contracts/events.ts, index.ts}`, `src/entry/worker.ts` if consumers are listed there, `docs/spec/architecture/event-catalog.md`
- Test: `tests/integration/playbooks/plans.test.ts`, `tests/integration/v1/plans.test.ts`

**Interfaces (produces):** `startPlan(ctx, acceptedEvent)`, `getPlan(ctx, accountId)`, `updateStep`, `pausePlan`, `resumePlan`, `completePlan`, `abandonPlan`, `stopPlan(ctx, planId, reason)` (used by R2c-3).

- [ ] **Step 1: Failing tests.**
  - Accepting an Act now account whose lead offer maps to a template creates the plan, with rendered drafts, owners and due dates, and publishes `plan.created` with the steps.
  - Review Focus 1, 2, 4 and 5.
  - A `no_playbook` choice, a Nurture tier, or an archived template each publish `plan.not_started` with the right reason.
  - Withdrawing an accepted assignment pauses the plan. A new acceptance resumes it with the new seller on the open seller steps (Ruling 10).
  - A merged account's plans move to the survivor.
  - Step done publishes `step.completed` and records history. Complete before all steps are finished gives 409. Abandon with no reason gives 400 "Say why you're abandoning it."
  - A closed plan gives 409.
- [ ] **Step 2: Implement.** The consumer is ordered by account and idempotent on `assignmentId`.
- [ ] **Step 3: Run** `npx vitest run tests/integration/playbooks tests/integration/v1/plans.test.ts tests/integration/routing`.
- [ ] **Step 4: Commit** `feat(playbooks): plans start on accept`.

### Task 5: Next step, due dates and counts in the lists

**Files:**
- Modify: `src/modules/playbooks/services/plans.ts` (`nextSteps`), `src/http/routes/v1/assignments/route.ts`, `src/http/routes/v1/accounts/route.ts`, `src/http/routes/v1/me/counts/route.ts`, and the routing row types where `nextStep` and `playbookName` are placeholders (keep them null in routing, filled by the route).
- Test: `tests/integration/v1/next-steps.test.ts`

- [ ] **Step 1: Failing tests.**
  - My assignments and the accounts list show `next_step {title, due_date, overdue, due_today}` and `playbook_name` for an account with a plan, and null without one.
  - An overdue step reads `overdue: true`.
  - `me/counts` counts only the caller's steps that are due today or overdue.
  - A list of 50 accounts makes one `nextSteps` call, not 50.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/v1/next-steps.test.ts tests/integration/v1/routing.test.ts`. **Step 4: Commit** `feat(playbooks): next step and due in lists`.

### Task 6: Specs and full suites

**Files:**
- Modify:
  - `docs/spec/playbooks/{index.md, playbook-templates.md, account-plans.md}`: Rulings 1-17. Days replace weeks, the five channels, `offer_playbook`, stop rule, drafts only, start on accept, choice order, statuses incl. `stopped`, events incl. `plan.not_started`, the API table.
  - `docs/spec/web-ui/screens.md` §19, §20, §6 and §7: no auto-send; the initial message is the tier playbook's first email, read-only with Copy; the assign dialog has the playbook preselected with an override or "No playbook".
  - `docs/spec/web-ui/api-gaps.md` (playbook rows READY; Decision 25 note).
  - `docs/spec/review-and-routing/*` (`no_playbook`, accepted event fields).
  - `docs/spec/architecture/event-catalog.md`.
- [ ] **Step 1: Full suites.** Run each of these:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test:unit`
  - `npm run test:int`
  - `cd web-ui && npm test` (types only change if a shared type moved)
  - `npm run e2e` (no new e2e; R2c-2 adds the screens)

  Known failures on main: the `per-workspace` afterAll, `split` and `jobs` under load (they pass alone), the relay NATS-down test, and `playbooks/schema.test.ts` RLS. Prove any other failure is pre-existing in a temporary worktree at main.
- [ ] **Step 2: Commit** `docs(spec): R2c-1 playbooks`.
