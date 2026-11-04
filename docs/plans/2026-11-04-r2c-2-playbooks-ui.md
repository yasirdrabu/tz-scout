# R2c-2: playbooks web UI (Playbooks screen, offer tiers, seller guide, assign, next steps)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see and use playbooks in the web app.
- **Playbooks screen:** leaders build and assign playbooks there.
- **Offer page:** it shows the playbook for each tier, each tier's initial message with Copy, and the seller guide. The seller guide is also shown on the assigned account page.
- **Assign dialog:** it offers a playbook choice.
- **Account lists:** My accounts and All accounts show the next step and when it's due.
- **Operators:** they can edit plans.

**Architecture:**
- **Small backend part:**
  - operators get `playbooks:write`;
  - offers get seller-guide columns and fields;
  - archiving a playbook clears its offer tiers.
- **Web UI:** everything else, built on the R2c-1 API (`docs/plans/2026-11-04-r2c-1-playbooks-backend.md`), following the existing feature folder conventions.

**Tech Stack:** React 19, TanStack Router and Query, CSS modules, msw, vitest + Testing Library, Playwright; backend TypeScript, Hono, Drizzle.

**Spec:**
- `docs/spec/web-ui/screens.md` §6, §7, §8, §19 and §20
- `docs/spec/playbooks/*`
- `docs/spec/web-ui/api-gaps.md`

Code map, with the exact copy from screens.md and the mockup and its conflicts already resolved in section 1: `docs/plans/2026-11-04-r2c-2-playbooks-ui.map.md`. The copy in map section 1 is binding unless a ruling below says otherwise.

## Rulings (user answers marked; the rest are Claude's calls under the user's "fine for a first pass" guidance, 2026-11-03)

1. **(User 2026-11-04) Everyone who works an account can edit its plan.** Operators get `playbooks:write`, added to the default role set. Owners, leaders and sellers already have it. Workspaces with a customised operator role keep their saved list, and the spec notes this.
2. **Seller guide (offers module).**
   - **New columns** on `offers.offer`:
     - `talking_points text[]`;
     - `objections jsonb` (`[{objection, answer}]`);
     - `avoid text[]`.
     - All default empty.
   - **API:** they're on create, patch and get as `talking_points`, `objections` and `avoid`.
   - **Approval:** they don't affect matching, so editing them never sends an approved offer back to draft.
   - **Proof points:** `proof_points` stays as it is and shows inside the guide.
   - **Limits:** at most 20 items in each list. Each talking point and avoid item is up to 300 characters; each objection and answer is up to 500.
3. **Archiving a playbook clears its offer tiers.** `archiveTemplate` deletes its `offer_playbook` rows in the same transaction, as the mockup says ("It will be removed from {n} offer tiers"). Running plans are untouched.
4. **Only active playbooks** appear in the offer tier selects and the assign dialog's cards. The Playbooks list shows every status.
5. **Delete versus Retire:** Delete shows when `running == 0` and `runs_on` is empty, otherwise Retire. A 409 on delete shows the API's message and offers Retire.
6. **Copy decisions:**
   - **Assign dialog footer:** "… and starts {playbook} when {AE first name} accepts." With "No playbook", nothing is added.
   - **Accept toast:** "Accepted. {playbook} starts today." when the row has a playbook name, else the existing toast.
   - **My accounts subtitle:** zero clauses are dropped, e.g. "2 next steps due today." or "1 overdue." Singular and plural follow the count.
   - **Rules card:**
     - Starts when: "When an AE accepts an account matched to its offer and tier."
     - Stops when: the stop rule's label.
     - Pauses when: "When the assignment is withdrawn, or someone pauses it."
     - Drafts: "Scout drafts each email for the AE to review and send."
7. **Bulk assign:** the first card is "Recommended for each account", the default, which sends no `playbook_id`. Then the active playbooks, then "No playbook".
8. **Initial message:** one block per tier that has a first email, with its subject and body (raw template text) and `Copy` (toast "Initial message copied."). The note reads "Scout fills in {account.name}, {person.first_name} and the other placeholders when the plan starts."
9. **Template form steps:** the form sends each step with only `order`, `day`, `channel`, `owner_role`, `title`, `detail`, `target_buying_roles`, `crm_task`, `subject` and `body`. The template GET returns extra fields that the strict API refuses.
10. **Gates:**
    - **Tier selects:** shown with `offers:manage` or `playbooks:manage`; read-only text otherwise.
    - **Playbooks screen:** edit controls need `playbooks:manage`.
    - **Seller guide editing:** needs `offers:manage`.
    - **Next step and Due:** the columns show only when the API returns them. They're null without `playbooks:read`, and then the columns are hidden.
11. **Due words:** "Due today" (amber), "{n} days overdue" or "1 day overdue" (red), else the date via `f.day`.

## Global Constraints

- Never run `npm run db:migrate`, `db:push`, or anything against the dev database (`localhost:5432/scout` and its workspace databases). The user's dev services are running now, and you must not touch or restart them, or the dev NATS. Integration tests run on a throwaway embedded Postgres on port 54329, with env overrides for the test process only, as the R2c-1 task reports describe.
- Web UI: types follow the API's snake_case. Use the existing `ui/` components and `features/*` conventions (map section 2). No new dependencies.
- Copy is exact per map section 1 and the rulings above.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A leader (who has `playbooks:manage` but not `offers:manage`) on an offer page.** The tier selects work and the seller guide is read-only. Test in Task 4.
2. **Editing an existing template's steps.** The save sends only the allowed step fields, not 400. Test in Task 3.
3. **An objections line without "|".** The form shows a field error and doesn't drop the line silently. Test in Task 4.
4. **An operator.** They can tick a plan step (403 before). The lists hide Next step and Due for a viewer. Test in Tasks 1 and 5.
5. **Bulk assign with the default card.** The request has no `playbook_id`. Test in Task 5.

---

### Task 1: Backend (operator permission, seller guide fields, archive clears tiers)

**Files:**
- Modify:
  - `src/modules/tenancy/domain/permissions.ts`
  - `src/modules/offers/{db/schema.ts (+ drizzle-kit migration), services/*}` (pass-through)
  - `src/http/routes/v1/offers/schemas.ts`
  - `src/modules/playbooks/services/templates.ts` (`archiveTemplate`)
- Test:
  - `tests/unit/tenancy/permissions.test.ts`
  - `tests/integration/v1/plans.test.ts` (an operator can now update a step)
  - `tests/integration/v1/offers.test.ts`
  - `tests/integration/playbooks/templates.test.ts`

- [ ] **Step 1: Failing tests.**
  - An operator holds `playbooks:write`, and PATCHing a step as an operator returns 200.
  - The offer create and patch round-trip carries `talking_points`, `objections` and `avoid`. An approved offer stays approved after a guide edit. Over-limit lists return 400.
  - Archiving a mapped template removes its `offer_playbook` rows, so `GET /offers/{id}/playbooks` shows that tier as null.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/unit/tenancy tests/integration/v1/plans.test.ts tests/integration/v1/offers.test.ts tests/integration/offers tests/integration/playbooks tests/integration/platform/migrate.test.ts`, typecheck and lint. **Step 4: Commit** `feat: operators edit plans, seller guide fields`.

### Task 2: Playbooks screen (list and detail)

**Files:**
- Create: `web-ui/src/features/playbooks/{api.ts, testing.ts, PlaybooksScreen.tsx, PlaybookList.tsx, PlaybookView.tsx, Playbooks.module.css, playbooks.test.tsx}`
- Modify: `web-ui/src/routes/workspace.tsx` (replace the Placeholder; add `playbooks/$id`), `web-ui/src/router.tsx`

**Interfaces (produces):**
- Types `Playbook` (list row) and `PlaybookDetail` (with `steps[]`).
- `playbooksQuery(tenant)`, `playbookQuery(tenant, id, version?)`, `createPlaybook`, `patchPlaybook`, `duplicatePlaybook`, `archivePlaybook`, `deletePlaybook`, all keyed `['playbooks', tenant, ...]`.

- [ ] **Step 1: Failing tests (msw).**
  - The list shows the title, sub, explainer, rows ("{n} steps over {d} days", channel mix, "Runs on" offer names or "Not assigned", Running), and the R3 rate columns' empty state.
  - The detail shows steps with "Day {n}", channel and who, and the tags "Draft ready for AE" or "HubSpot task".
  - "Runs on" rows, or the empty text.
  - The Rules card (Ruling 6).
  - Duplicate, Retire and Delete per Ruling 5, with the confirms and toasts.
  - A seller sees no edit controls.
  - Loading, error and empty states follow the shared pattern.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/playbooks && npm run typecheck && npm run lint`. **Step 4: Commit** `feat(web-ui): playbooks list and detail`.

### Task 3: Playbook form and the "Assign {playbook}" dialog

**Files:**
- Create: `web-ui/src/features/playbooks/{PlaybookForm.tsx, AssignPlaybookDialog.tsx, playbook-form.test.tsx}`
- Modify: `PlaybookView.tsx`, `PlaybooksScreen.tsx` (search params `edit` and `assign`)

- [ ] **Step 1: Failing tests.**
  - New and Edit forms with every field from map section 1. Steps can be added, removed and moved up or down. Email steps show subject and body. Buying roles are checkboxes from `buyingRolesQuery`.
  - "Give the playbook a name." and "Add at least one step." are shown.
  - API field errors map onto the right field.
  - Editing an existing playbook sends only the Ruling 9 fields (Review Focus 2).
  - Saving shows the right toast.
  - The Assign dialog has an offer select labelled "{offer} · {practice}" and tier checkboxes, each with "Already uses this playbook", "Replaces {x}" or "No playbook now". It PUTs each changed tier, and the toast reads "{playbook} now runs on {offer} · {tiers}."
- [ ] **Step 2: Implement.** **Step 3: Run** the web-ui tests for `src/features/playbooks`, typecheck and lint. **Step 4: Commit** `feat(web-ui): playbook form and assign`.

### Task 4: Offer page (playbook by tier, initial message, seller guide)

**Files:**
- Create: `web-ui/src/features/offers/{PlaybookByTier.tsx, SellerGuide.tsx, offer-playbooks.test.tsx}`
- Modify: `web-ui/src/features/offers/{OfferView.tsx (remove the R2 comment), OfferForm.tsx (Seller guide group: talking points, objections "q | a", proof points, avoid), api.ts, testing.ts}`

**Interfaces (produces):** `SellerGuide({offer})`, a read-only component reused by Task 6. `offerPlaybooksQuery`, `setOfferPlaybook`.

- [ ] **Step 1: Failing tests.**
  - "Playbook by tier" shows three rows with selects of active playbooks, the notes for empty tiers, and the footer note. Changing a select PUTs the tier and shows a toast.
  - Review Focus 1: a leader can change the tiers, and a reader sees text only.
  - "Initial message" blocks per tier with Copy, which uses `copyText`, and the toast "Initial message copied.".
  - The seller guide view has numbered talking points, "When they say" quote and answer pairs, proof points and avoid. With an empty guide it shows "No seller guide yet." and a `Write one` button that opens the form for `offers:manage`.
  - The form's guide group round-trips. A line without "|" shows a field error (Review Focus 3).
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/offers`, typecheck and lint. **Step 4: Commit** `feat(web-ui): offer playbooks and seller guide`.

### Task 5: Assign dialog, My accounts and All accounts

**Files:**
- Modify:
  - `web-ui/src/features/review/{AssignDialog.tsx, api.ts, testing.ts}`
  - `web-ui/src/features/accounts/{MyAccountsScreen.tsx, AccountsScreen.tsx (or the all-accounts screen), api.ts, testing.ts}`
  - `web-ui/src/api/me.ts` (`Counts` gains `next_steps_due_today` and `next_steps_overdue`)
  - `web-ui/src/lib/format.ts` (only if a helper is needed)
- Test: the existing assign, my-accounts and accounts tests

- [ ] **Step 1: Failing tests.**
  - **Single assign:** cards come from `GET /playbooks` (active ones) plus "No playbook". The suggested one is preselected and tagged "Recommended for this account". The footer follows Ruling 6. The request sends `playbook_id` only when the choice differs from the suggestion, or `null` for "No playbook".
  - **Bulk:** Ruling 7 (Review Focus 5).
  - **My accounts:**
    - The subtitle follows Ruling 6.
    - The pending hint reads "Accept to start the playbook. Declining returns the account to {assigner}."
    - The accept toast follows Ruling 6.
    - The Active table has Next step and Due columns using the Ruling 11 words.
  - **All accounts:** a Next step column with the due words beneath.
  - **No `playbooks:read`:** the columns are hidden and the subtitle falls back to today's text (Review Focus 4).
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/review src/features/accounts`, typecheck and lint. **Step 4: Commit** `feat(web-ui): playbook choice and next steps`.

### Task 6: Seller guide on the assigned account page

**Files:** Modify `web-ui/src/features/account/{AssignedView.tsx, RightRail.tsx or a new SellerGuideCard.tsx, testing.ts}`. Test `web-ui/src/features/account/seller-guide.test.tsx`.

- [ ] **Step 1: Failing tests.**
  - The assigned view shows a "Seller guide" card for the account's lead offer. It reuses Task 4's `SellerGuide` and reads `GET /offers/{lead offer id}`.
  - With no guide, it shows "No seller guide for {offer} yet." with no button.
  - The review view does not show the card.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/account`. **Step 4: Commit** `feat(web-ui): seller guide on the account page`.

### Task 7: Specs, end-to-end and full suites

**Files:**
- Modify:
  - `docs/spec/web-ui/screens.md` §6, §7, §8, §19 and §20 (Rulings 3-11)
  - `docs/spec/offers-and-practices/*` (seller guide fields)
  - `docs/spec/tenancy/roles-and-data-scopes.md` (operator `playbooks:write`)
  - `docs/spec/playbooks/*` (archive clears tiers)
  - `docs/spec/web-ui/api-gaps.md`
- Create: `tests/e2e/playbooks.spec.ts`

- [ ] **Step 1: E2E** (an e2e-only offer and account).
  - As the owner, create a playbook with two steps (email on day 0, call on day 1) and assign it to an offer's Good fit tier from the Playbooks screen.
  - The offer page shows it, and its initial message has Copy.
  - Assign a Good fit account of that offer to a seller. The dialog preselects the playbook.
  - As that seller, My accounts names the playbook. Accept it. The toast reads "Accepted. {playbook} starts today." and the Active row shows "Intro email · Due today".
- [ ] **Step 2: Full suites.** Run each of these:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test:unit`
  - `npm run test:int` (throwaway Postgres and NATS as in R2c-1)
  - `cd web-ui && npm test`
  - `npm run e2e`

  Known flakes: the relay NATS-down test, the enrichment "two roles" test, and `split` and `jobs` under load.
- [ ] **Step 3: Commit** `docs(spec): R2c-2 playbooks UI` and `test(e2e): playbooks`.
