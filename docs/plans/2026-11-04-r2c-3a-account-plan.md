# R2c-3a: the plan on the account page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The account page shows the plan.
- **Before assignment:** a preview of the playbook that will start.
- **After acceptance:** the running plan, where the team can:
  - tick steps off, add notes, and change owners and due dates;
  - copy email drafts;
  - find people for a missing buying role;
  - pause, resume, complete or abandon the plan;
  - edit the plan by adding, editing and removing steps, with a history.

HubSpot task sync, the stop rule and the no-reply stage move are R2c-3b.

**Architecture:**
- **Playbooks backend:** steps keep their target buying roles, and the plan JSON gains per-step people and missing roles, computed when the plan is read. Customise endpoints write history and publish a richer `plan.changed` (R2c-3b's sync will consume it).
- **Web UI:** a plan card in the assigned view, a preview card in the review view, and an Edit plan drawer, built on the existing account-page conventions.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres, vitest; React 19, TanStack Query, msw, Playwright.

**Spec:**
- `docs/spec/playbooks/{account-plans.md, account-page.md}`
- `docs/spec/web-ui/screens.md` §4, §4a item 7, §4b item 2

Code map: `docs/plans/2026-11-04-r2c-3-plans-crm.map.md`. Section 1 has the copy and layout; section 2 has the plan API as built.

## Rulings (user answers 2026-11-04 marked; the rest are Claude's calls under "fine for a first pass")

1. **(User) Everyone who works the account edits the plan** (`playbooks:write`: owners, leaders, sellers, operators). Reading needs `playbooks:read`.
2. **Units are days**, not the mockup's weeks.
   - **Header:** "{name} · Day {d} of {n}". `d` is `plan.day + 1`, capped at `n`. `n` is `plan.days + 1`, the last step's day counted from 1.
   - **Progress:** "{x} of {y} done". `x` is steps that are done or skipped; `y` is all steps.
   - **The bar** shows x/y.
3. **Row status pills** (map section 1 colours):
   - "Done" for done;
   - "Skipped" for skipped, neutral;
   - "In progress" for in progress;
   - "Due {date}" (amber, amber row) for a todo step that is overdue or due today;
   - "Not started" for any other todo step.

   The checkbox toggles done and todo with a PATCH. An unchecked done step goes back to todo.
4. **Step detail** opens in place when the step title is clicked.
   - **Content:** the rendered detail, the email subject and body with `Copy` (toast "Draft copied."), people (plain names), the note, owner, due date and status.
   - **Editing:** note, owner (members select), due date and status (todo, in progress, done, skipped) save with the existing PATCH, and show the toast "Step updated.".
   - **Missing role:** a step whose target role has no stated or confirmed person shows "No {role label} on file" and `Find`. Find opens the Enrich dialog with that role (`initialRoles`, built in R2b-3), and only with `enrichment:request`.
5. **Plan actions**, in a card menu with `playbooks:write`:
   - Pause, or Resume when paused;
   - Complete. When steps are still open, it shows the API's 409 text.
   - Abandon opens a dialog asking "Why are you abandoning it?" The reason is required, and the API's "Say why you're abandoning it." is shown if missing.
   - Toasts: "Plan paused.", "Plan resumed.", "Plan completed.", "Plan abandoned.".
   - A closed plan shows its status line: "Completed {date}", "Stopped: {reason}" or "Abandoned: {reason}". It has no menu, and its rows are read-only.
6. **Newer version:** when `newer_version` is true, a note reads "A newer version of {playbook} exists. This plan keeps the steps it started with." There's no compare in this pass.
7. **History:** a collapsed "History ({n})" list. Each entry is "{who} {what} · {when}", using kind words: created, paused, resumed, completed, abandoned, stopped, changed a step's status, wrote a note, changed the owner, changed the due date, added a step, edited a step, removed a step.
8. **Customise (backend):**
   - `POST /api/v1/plans/{id}/steps` adds a step with `{day, channel, owner_role, title, detail?, subject?, body?, target_buying_roles?, crm_task?, owner_user_id?}`. Its due date comes from the plan start, using the same working-day rule. Its owner comes from the role unless given. It has `origin: added`, and its order is after the last step with a day at or below the new day.
   - `PATCH .../steps/{step_id}` additionally accepts `title`, `detail`, `day` (which recomputes the due date unless `due_date` is also given), `channel`, `subject`, `body`, `crm_task` and `target_buying_roles`. Any of these changes the origin to `edited`.
   - `DELETE .../steps/{step_id}` refuses a done step with 409 "A done step can't be removed. Skip it instead." It refuses a closed plan with 409 "This plan has ended."
   - Every change records history (`step_added`, `step_edited`, `step_removed`), sets `account_plan.customised = true`, and publishes `plan.changed` with `changed: ['steps']`.
   - Buying roles are checked against the workspace's active roles, keeping keys the step already holds (as R2c-2 does for templates).
9. **`plan.changed` steps payload grows** to `{id, order, day, channel, title, detail, subject, body, status, ownerUserId, dueDate, crmTask}` for every touched step. A removed step is sent as `{id, removed: true}`. R2c-3b's sync needs these fields.
10. **People per step:**
    - `plan_step` gains `target_buying_roles text[]` (migration), copied from the template step when the plan is built. Existing rows get an empty list.
    - Plan JSON steps gain `people: [{id, name}]`, computed when read from the account's current people who hold any target role as stated or set by a person. People Enrich found after acceptance are therefore linked.
    - Plan JSON steps also gain `missing_roles: [key]`, the target roles nobody holds.
    - `target_person_ids` stays as stored history.
11. **Preview (review view, §4a item 7):** a "Playbook" card after the Brief.
    - **Source:** the account's suggestion (`GET /accounts/{id}/playbook-suggestion`, only with `assign:act`), with steps from `GET /playbooks/{id}`. Without the permission, or with no suggestion, there is no card.
    - **Header:** "{name} · {n} steps over {d} days · starts when accepted".
    - **Rows:** "Day {n}", the step, the owner role word, and "Not started".
12. **Assigned but not yet accepted:** the assigned view shows a Playbook card.
    - **With a playbook:** "{playbook} starts when {AE first name} accepts." The name comes from the account's current assignment row; add `playbook_name` to `GET /accounts/{id}/review`'s `current_assignment` at the HTTP layer if missing.
    - **With no playbook:** "No playbook. {AE first name} works it with no set steps."
13. **Edit plan (web):** an `Edit plan` button in the plan card header (`playbooks:write`, open plans only) opens a drawer.
    - **Contents:** the steps with Edit and Remove, and an `Add step` form with Day, Channel, Done by, Title, Detail, Subject and Body for email, Buying roles, and HubSpot task.
    - **Saving:** each save is immediate (one request per action), with toasts "Step added.", "Step saved." and "Step removed.".
    - **Done steps:** a done step's Remove button is disabled, with the hint "Skip it instead.".

## Global Constraints

- Never run `npm run db:migrate`, `db:push`, or anything against the dev database or the user's running dev services (`localhost:5432`, NATS `4222`). Never touch `C:\dev\tz-scout`. Integration tests and e2e run on a throwaway embedded Postgres (port 54329) and a private NATS on a free port, with env overrides for the test process only (see `C:\dev\tz-scout\.superpowers\sdd\2026-11-04-r2c-1-playbooks-backend\task-6-report.md`).
- Module boundaries: routing and CRM never import playbooks. Any join happens at the HTTP layer.
- Web UI: existing `ui/` components and the `features/account` conventions. No new dependencies. Snake_case API types.
- Copy is exact per the rulings and map section 1.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A step added at day 5 to a plan started on a Friday** is due on a working day in the tenant's timezone. Task 1.
2. **Removing a done step** is refused. Editing a step on a closed plan is refused. Task 1.
3. **A person found by Enrich after acceptance** shows under the step and clears its "No {role} on file". Task 1 (API) and Task 2 (UI).
4. **A seller unticking a step they ticked by mistake** returns it to todo. History records both changes. Task 2.
5. **Someone with `playbooks:read` but not `playbooks:write`** sees the plan read-only, with no checkbox, menu or Edit plan. Task 2.

---

### Task 1: Backend (step roles, live people, customise, richer events)

**Files:**
- Modify:
  - `src/modules/playbooks/{db/schema.ts (+ drizzle-kit migration: plan_step.target_buying_roles, account_plan.customised), domain/plan.ts, services/{plans.ts, start.ts}, contracts/events.ts, index.ts}`
  - `src/http/routes/v1/plans/[id]/steps/route.ts` (new POST)
  - `src/http/routes/v1/plans/[id]/steps/[stepId]/route.ts` (PATCH fields, DELETE)
  - `src/http/routes.ts`
  - `src/http/routes/v1/accounts/[id]/review/route.ts` (current assignment `playbook_name`, if absent)
  - `docs/spec/architecture/event-catalog.md`
- Test: `tests/integration/playbooks/plans.test.ts`, `tests/integration/v1/plans.test.ts`

- [ ] **Step 1: Failing tests.** Cover Rulings 8, 9, 10 and 12 and Review Focus 1-3:
  - add, edit and remove, including the 409s;
  - the history kinds, and `customised` being true;
  - the `plan.changed` payload fields;
  - `people` and `missing_roles` on read, including a person added after acceptance;
  - roles copied from the template;
  - `current_assignment.playbook_name`.
- [ ] **Step 2: Implement.** **Step 3: Run** the playbooks and v1 plans/routing integration tests (throwaway PG), `npm run test:unit`, typecheck and lint. **Step 4: Commit** `feat(playbooks): edit plans and link people live`.

### Task 2: Web: the plan card on the assigned view

**Files:**
- Create: `web-ui/src/features/account/{PlanCard.tsx, PlanStep.tsx, plan.test.tsx}`
- Modify: `web-ui/src/features/account/{AssignedView.tsx, api.ts, testing.ts, Account.module.css}`

**Interfaces (produces):** `planQuery(tenant, accountId)` keyed `['account', tenant, id, 'plan']`, `patchStep`, `planAction`, and the `Plan` and `PlanStep` types.

- [ ] **Step 1: Failing tests.** Rulings 2-7 and 12, and Review Focus 3-5:
  - the header and bar;
  - pills and the amber row;
  - checkbox toggling;
  - step detail, including editing the note, owner, due date and status;
  - Copy on the email draft;
  - "No {role} on file" with Find opening the Enrich dialog with that role;
  - the menu actions, including the abandon reason;
  - closed plan states;
  - the newer-version note;
  - History;
  - the not-yet-accepted text;
  - someone with `playbooks:read` but not `playbooks:write` seeing it read-only;
  - 404 (no plan) showing nothing.
- [ ] **Step 2: Implement.** The plan card is the first card in the assigned view's main column (map section 6). **Step 3: Run** `cd web-ui && npx vitest run src/features/account`, typecheck and lint, then `npm test`. **Step 4: Commit** `feat(web-ui): the plan on the account page`.

### Task 3: Web: Edit plan drawer

**Files:**
- Create: `web-ui/src/features/account/{EditPlanDrawer.tsx, edit-plan.test.tsx}`
- Modify: `PlanCard.tsx`, `api.ts` (`addStep`, `editStep`, `removeStep`)

- [ ] **Step 1: Failing tests.** Ruling 13:
  - add, edit and remove, each with its toast;
  - a done step can't be removed;
  - field errors map onto the right fields;
  - focus after add and remove (as in the playbook form);
  - the plan refreshes after each save.
- [ ] **Step 2: Implement** by reusing the R2c-2 step-field components from `features/playbooks/PlaybookForm.tsx` where they're separable. Only extract a shared component if that's small; otherwise duplicate the field set. **Step 3: Run** the account tests, typecheck and lint. **Step 4: Commit** `feat(web-ui): edit a plan`.

### Task 4: Web: the playbook preview in the review view

**Files:** Modify `web-ui/src/features/account/{ReviewView.tsx, api.ts, testing.ts}`. Create `PlaybookPreview.tsx` and `preview.test.tsx`.

- [ ] **Step 1: Failing tests.** Ruling 11:
  - the header and rows;
  - no card without `assign:act` or without a suggestion;
  - loading and error states.
- [ ] **Step 2: Implement.** **Step 3: Run** the account tests. **Step 4: Commit** `feat(web-ui): playbook preview before assignment`.

### Task 5: Specs, e2e, suites

**Files:**
- Modify:
  - `docs/spec/playbooks/{account-plans.md, account-page.md, index.md}` (Rulings, endpoints, events)
  - `docs/spec/web-ui/screens.md` §4a item 7 and §4b item 2
  - `docs/spec/web-ui/api-gaps.md`
- Create: `tests/e2e/plan.spec.ts`

- [ ] **Step 1: E2E** on throwaway services:
  - An account has an accepted plan, set up as in `playbooks.spec.ts`.
  - Open the account page. It shows "Day 1 of …" and the first step "Due {today}".
  - Tick the step, then add a step through Edit plan. It appears in the list.
  - Pause the plan, then resume it.
- [ ] **Step 2: Full suites.** Run each of these:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test:unit`
  - `npm run test:int` (throwaway)
  - `cd web-ui && npm test`
  - `npm run e2e` (throwaway)

  Known flakes: the relay NATS-down test, the enrichment "two roles" test, and `split` and `jobs` under load.
- [ ] **Step 3: Commit** `docs(spec): R2c-3a account plan` and `test(e2e): account plan`.
