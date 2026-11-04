# R2b-3: buying committee coverage, gaps and Find

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The account page shows the buying committee against what the lead offer needs: which roles are covered, which are only guessed, and which are gaps. Each gap has a `Find` button that opens the Enrich dialog with that role picked. People get roles guessed from their titles when no source stated one. A person can confirm or remove a guessed role, set roles, and write a decision note. Offers list required and optional buying roles.

**Architecture:**
- **Accounts** gains a pure `guessRolesFromTitle`, used when people are matched or added, and a pure coverage rule. A service, `getCommittee(ctx, accountId, offerId?)`, reads the people and the offer; accounts may already read offers (`ACC --> OFF`).
- **Offers** gains `optional_buying_roles`. `target_buying_roles` stays as the required list, so scoring is unchanged.
- **Enrichment** sends the searched role as a guess, not a stated role.
- **Playbooks** adds the same committee structure to the brief read.
- **Web UI:** the committee rail shows coverage and gap rows, the review checklist gets a gap line, the Enrich dialog accepts preset roles, and people become editable.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest, React 19 + TanStack Query, msw, Playwright.

**Spec:**
- `docs/spec/accounts/buying-committee.md` (ACC-E2)
- `docs/spec/web-ui/screens.md` §4a (items 2 and 8), §4b item 5, §4c
- `docs/spec/web-ui/api-gaps.md` (row "Committee gap rows, Find")
- `docs/spec/offers-and-practices/` (offer fields)
- `docs/spec/playbooks/account-brief.md`

Code map: `docs/plans/2026-11-03-r2b-3-committee.map.md`. Read it before any task.

## Rulings (user answers 2026-11-03 marked; the rest are Claude's calls; Task 6 writes them into the specs)

1. **(User) Required and optional roles.**
   - **Schema:** `offers.offer.target_buying_roles` stays and means *required*. A new `optional_buying_roles text[] not null default '{}'` holds the optional roles.
   - **API:** `target_buying_roles` and `optional_buying_roles` on create and patch. The route checks every key against `listBuyingRoles` (400 "Unknown buying role: {key}"), and that the two lists don't overlap (400 "A role can't be both required and optional: {label}").
   - **Seeds:** set on every seeded offer in `offers/defaults.ts`: required `business_owner`, `technical_buyer`, `commercial_buyer`; optional `procurement`. Existing workspaces get no data migration.
   - **Editor:** `OfferForm` gets two checkbox groups, "Required buying roles" and "Optional buying roles". A role ticked in one is disabled in the other.
2. **(User) Enrich finds guesses.**
   - People found by `people_for_roles` carry the searched role as a guess. The arrival person schema gains `guessed_buying_roles: string[]`, which normalises to `ArrivalPerson.guessedRoleKeys`.
   - Enrichment sets `guessed_buying_roles` instead of `buying_role(s)`.
3. **(User) Full committee editing on the account page:** confirm or remove a guessed role, set roles, and a decision note of up to 1,000 characters showing who wrote it and when.
4. **(User) No "ask an agent" in Find.** Find opens only the Enrich dialog. "Ask an agent" waits for the MCP server, and the spec records that.
5. **Guessing from title** (pure, `src/modules/accounts/domain/roles.ts`): `guessRolesFromTitle(title: string | null): string[]`, matched case-insensitively on word boundaries, after `&` and `,` are read as spaces.
   - `commercial_buyer`: CFO, chief financial, owner, president, CEO, chief executive, finance director, controller.
   - `technical_buyer`: CIO, CTO, CISO, chief information, chief technology, IT, information technology, engineering, security, data, technology, infrastructure.
   - `procurement`: procurement, purchasing, contracts, buyer, sourcing.
   - `business_owner`: chief/VP/vice president/head/director of a business function, meaning any title starting with or containing `chief `, `vp`, `vice president`, `head of` or `director`, when no rule above matched.

   A title can give several roles. For example, "CTO" gives only `technical_buyer`, because the technical rule matched first, and `business_owner` applies only when nothing else matched. "Chief of Paratransit Operations & Mobility Services" gives `business_owner`, and "Contracts Manager" gives `procurement`.
6. **When guesses apply** (`matchOrAddPerson`):
   - **Stated roles:** they are stored as `stated`, as today, and a stated role upgrades a stored `guessed_from_title` row of the same key (`on conflict do update ... where origin = 'guessed_from_title'`).
   - **Guesses:** they are used only when this arrival states no roles *and* the person has no stored roles. Guesses are the union of `guessedRoleKeys` and `guessRolesFromTitle(title)`, kept only for the tenant's active buying roles, and stored as `guessed_from_title`.
   - **No backfill:** existing people with no roles get guesses on their next arrival. Parked: a one-off backfill.
7. **Confirming.** `PATCH /api/v1/people/{id}` gains `confirm_role_keys: string[]`. Each key must be among the person's roles after the patch (400 "Only a role the person holds can be confirmed."). It becomes `set_by_person` with `set_by` and `set_at` now. `changedKeys` gains `roles`, so `accounts.person.updated` is published. An edit that only removes roles leaves the other guesses as they were.
8. **Decision note.** `decision_note` is at most 1,000 characters (400 "Keep the note under 1,000 characters."). `PersonView` gains:
   - `decision_note_by: {id, name} | null` and `decision_note_at`, from the pinned note fact's editor and time (null when a source wrote it);
   - `roles[].set_by_name` and `set_at`.
9. **Coverage** (pure, `src/modules/accounts/domain/committee.ts`): `coverage(roles, people, offer)` works as follows.
   - **Which roles:** the offer's required roles, then its optional ones, in buying-role sort order. With no offer, or an offer with no required roles, the required roles are the core three (`business_owner`, `commercial_buyer`, `technical_buyer`) and there are no optional ones. Archived roles are dropped.
   - **Status:** `covered` when a person holds the role as `stated` or `set_by_person`, `guessed` when only `guessed_from_title`, otherwise `gap`.
   - **Summary:** `{covered, required}` counts required roles only. The text reads "{covered} of {required} roles covered" ("1 of 1 role covered").
10. **Shape.** `getCommittee(ctx, accountId, offerId?)` returns `Committee`: `{offer: {id, name} | null, roles: [{key, label, required, status, people: [{id, name, title, origin}]}], summary: {covered, required, text}, gaps: string[]}`, where `gaps` is the required gap keys. The offer is `offerId` when given (404 when unknown), else `leadOfferOverrideId ?? bestOfferId` from the account's summary.
    - **Committee route:** `GET /api/v1/accounts/{id}/committee?offer_id=` (`accounts:read`) returns it in snake_case.
    - **Brief route:** `GET /api/v1/accounts/{id}/brief` adds `committee` with the same structure (ACC-E2-S1-AC2). The brief prompt is unchanged.
11. **Find.** `EnrichDialog` gains `initialRoles?: string[]`, which preselects those roles in place of the default.
    - **Rail gap row:** `Find` opens the dialog with `[role]`.
    - **Checklist:** `Find with Enrich` opens it with every required gap.
    - **Permission:** without `enrichment:request`, gap rows show with no button.
    - **After a request:** the committee query's key starts with `['account', tenant, id]`, so the dialog's invalidation and the R2b-2 notice refresh both cover it.
12. **Optional gaps** show in the rail as "No {label} yet · Optional" with `Find`. They are not counted and not in the checklist.

## Global Constraints

- Never run `npm run db:migrate` or anything else against the dev database (`localhost:5432/scout` or its workspace databases). Tests use their own databases (`tests/integration` helpers, `tests/e2e/env.ts`).
- Copy (exact):
  - **Rail gap:** "No {label lowercase} yet", e.g. "No technical buyer yet"; optional: "No procurement yet · Optional". Button `Find`.
  - **Rail summary under the title:** "{offer name}: {summary text}", e.g. "Modernization Blueprint: 2 of 3 roles covered". With no offer, "Core roles: {summary text}".
  - **Guessed role chip:** "Guessed from title", with buttons `Confirm` and `Remove` (with `people:write`). Toasts: "{role label} confirmed for {name}." and "{role label} removed from {name}."
  - **Checklist line:** "Buying committee has no {labels joined: 'a', 'a or b', 'a, b or c', lowercase}." with `Find with Enrich`. Labels are in buying-role order, for example: "Buying committee has no commercial buyer or technical buyer."
  - **Empty committee:** "No people yet. Add someone you know, or Enrich will look for {required labels joined with 'and', lowercase, each with 'a'}." For example: "...look for a business owner, a commercial buyer and a technical buyer." Plus a `Find with Enrich` button with `enrichment:request`.
  - **Edit person dialog:** title "Edit {name}"; a checkbox group "Buying roles"; a textarea "Decision note" with hint "Where they stand. Up to 1,000 characters."; buttons `Save` and `Cancel`; toast "Saved {name}." Under the note in the rail: "{note} · {name}, {date}" when the API gives who and when.
- **Who:** `people:write` edits; `enrichment:request` sees Find; anyone with `accounts:read` sees coverage.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A person whose title guesses a role, then a source states another role for them.** They keep the stated role. The guessed role stays guessed (Ruling 6), and is not wiped. Test in Task 1.
2. **Someone removes a guessed role, and the same source sends the person again.** The person still has another role, so no guess re-adds it. With no roles at all it would come back; that case is parked. Test in Task 1.
3. **The offer lists an archived role, or a role is both required and optional.** Coverage drops the archived role; the API refuses the overlap. Test in Tasks 2 and 3.
4. **Enrich finds no one for a gap.** The gap stays a gap. The committee refreshes when the request finishes, with no reload. Test in Task 4.
5. **A seller without `people:write` (or a viewer).** They see coverage and gaps, with no Confirm, Remove or Edit. They see Find only with `enrichment:request`. Test in Tasks 4 and 5.

---

### Task 1: Guess roles from titles

**Files:**
- Create: `src/modules/accounts/domain/roles.ts`, `tests/unit/accounts/roles.test.ts`
- Modify: `src/modules/accounts/services/people.ts` (`matchOrAddPerson`), `src/modules/accounts/contracts/types.ts` (`ArrivalPerson.guessedRoleKeys`), `src/modules/intake/contracts/arrival.ts` (`guessed_buying_roles`), `src/modules/intake/domain/normalise-arrival.ts`, `src/modules/enrichment/services/run.ts` (found people carry `guessed_buying_roles`)
- Test: `tests/integration/accounts/upsert.test.ts` (or a new `roles-guess.test.ts` beside it), `tests/unit/intake/normalise-arrival.test.ts`, `tests/integration/enrichment/run.test.ts`

**Interfaces (produces):** `guessRolesFromTitle(title: string | null): string[]` (Ruling 5), exported from `@/modules/accounts`.

- [ ] **Step 1: Failing unit tests.** Use 20 sample titles (ACC-E2-S1-AC3), including:
  - "Chief of Paratransit Operations & Mobility Services" → `['business_owner']`
  - "Contracts Manager" → `['procurement']`
  - "CFO" → `['commercial_buyer']`
  - "VP, Information Technology" → `['technical_buyer']`
  - "Director of Purchasing" → `['procurement']`
  - "Head of Data & Security" → `['technical_buyer']`
  - "Marketing Coordinator" → `[]`
  - `null` → `[]`
  - "Datapoint Analyst" → `[]` (word boundaries)

  Normalise test: `guessed_buying_roles` becomes `guessedRoleKeys`.
- [ ] **Step 2: Failing integration tests.**
  - A new person with title "CTO" and no stated role gets `technical_buyer` as `guessed_from_title`.
  - A later arrival stating `technical_buyer` upgrades it to `stated`.
  - A person with a stated role gets no guesses.
  - Review Focus 1 and 2.
  - A guess for an archived role is dropped.
  - Enrichment `people_for_roles` for `champion` stores `champion` as `guessed_from_title`: update the existing run test that expected `stated`.
- [ ] **Step 3: Implement** Ruling 6.
- [ ] **Step 4: Run** `npx vitest run tests/unit/accounts tests/unit/intake tests/integration/accounts tests/integration/enrichment`.
- [ ] **Step 5: Commit** `feat(accounts): guess buying roles from titles`.

### Task 2: Required and optional offer roles

**Files:**
- Modify:
  - offers schema + a new offers migration (`optional_buying_roles`);
  - `src/modules/offers/{contracts,services,defaults.ts}` (wherever `targetBuyingRoles` flows);
  - `src/http/routes/v1/offers/schemas.ts` and the create/patch routes (validation per Ruling 1);
  - `web-ui/src/features/offers/{api.ts, OfferForm.tsx, testing.ts}`.
- Test: `tests/integration/offers/*` (beside the existing create/patch tests), `web-ui/src/features/offers/*.test.tsx`

**Interfaces (produces):** `OfferView.optionalBuyingRoles: string[]`; API field `optional_buying_roles`.

- [ ] **Step 1: Failing tests.**
  - The create and patch round-trip keeps both lists.
  - An unknown key gives 400 "Unknown buying role: wizard".
  - An overlap gives 400 "A role can't be both required and optional: Procurement".
  - Seeded offers have the Ruling 1 roles.
  - Web: the form shows both groups. Ticking Procurement as optional disables it under Required. Saving sends both lists.
- [ ] **Step 2: Implement.** Generate the migration with drizzle-kit (no hand-written journal edits).
- [ ] **Step 3: Run** `npx vitest run tests/integration/offers tests/integration/platform/migrate.test.ts` and `cd web-ui && npx vitest run src/features/offers`.
- [ ] **Step 4: Commit** `feat(offers): required and optional buying roles`.

### Task 3: Committee coverage, confirming roles, decision notes (API)

**Files:**
- Create:
  - `src/modules/accounts/domain/committee.ts`
  - `src/modules/accounts/services/committee.ts`
  - `src/http/routes/v1/accounts/[id]/committee/route.ts` (add it to `src/http/routes.ts`)
  - `tests/unit/accounts/committee.test.ts`
  - `tests/integration/accounts/committee.test.ts`
- Modify:
  - `src/modules/accounts/{index.ts, services/edit.ts, services/read.ts, contracts/types.ts}`: Rulings 7 and 8;
  - `src/http/routes/v1/accounts/schemas.ts`: `confirm_role_keys` and the note limit;
  - the people route's response mapping;
  - the playbooks brief route and service: `committee` (Ruling 10).
- Test: `tests/integration/accounts/read-edit.test.ts`, the brief route test.

**Interfaces (produces):**
- `coverage(...)`, `Committee` type, `getCommittee(ctx, accountId, offerId?)`, exported from `@/modules/accounts`.
- `PersonPatch.confirmRoleKeys`.
- `PersonView.decisionNoteBy`, `decisionNoteAt`, `roles[].setByName`, `setAt`.
- JSON: `GET /accounts/{id}/committee` returns `{offer, roles[{key,label,required,status,people[{id,name,title,origin}]}], summary{covered,required,text}, gaps}`.

- [ ] **Step 1: Failing unit tests (coverage).**
  - With no offer, the core three apply.
  - An offer with required technical buyer and optional procurement, plus one stated technical buyer: `1 of 1 role covered`, with procurement a non-counted gap.
  - Guessed only gives `guessed`.
  - An archived role is dropped (Review Focus 3).
  - A person holding two roles shows under both.
- [ ] **Step 2: Failing integration tests.**
  - The route returns the lead offer's coverage, and `?offer_id=` switches it. An unknown offer gives 404.
  - Confirming a guessed role makes it `set_by_person` and publishes `accounts.person.updated` with `roles`. Confirming a role not held gives 400.
  - A 1,001-character note gives 400.
  - `decision_note_by` is the editor's name after a PATCH.
  - The brief includes `committee` equal to the committee route's body.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/accounts tests/integration/accounts tests/integration/playbooks`.
- [ ] **Step 5: Commit** `feat(accounts): buying committee coverage and role confirming`.

### Task 4: Web UI — coverage, gaps and Find

**Files:**
- Modify:
  - `web-ui/src/features/account/{api.ts, RightRail.tsx, ReviewView.tsx, AssignedView.tsx, AccountPage.tsx, testing.ts, Account.module.css}`
  - `web-ui/src/features/enrichment/EnrichDialog.tsx` (`initialRoles`)
- Test: `web-ui/src/features/account/committee.test.tsx` (new), `web-ui/src/features/enrichment/enrich.test.tsx`

**Interfaces:**
- Consumes the Task 3 JSON.
- Produces `committeeQuery(tenant, id)` with key `['account', tenant, id, 'committee']`.
- `BuyingCommittee` gains `onFind(roles: string[])`. AccountPage owns the dialog state and passes `initialRoles`.

- [ ] **Step 1: Failing tests.**
  - The rail shows "Modernization Blueprint: 1 of 3 roles covered", one person, and gap rows "No commercial buyer yet" and "No technical buyer yet" with `Find`. An optional gap reads "No procurement yet · Optional".
  - Clicking `Find` on technical buyer opens "Enrich {name}" with only Technical buyer ticked.
  - The checklist reads "Buying committee has no commercial buyer or technical buyer." and `Find with Enrich` ticks both.
  - The checklist card shows with only a gap, and no conflict or intro.
  - The empty committee uses the dynamic copy and the button.
  - Without `enrichment:request`, there is no Find (Review Focus 5).
  - The assigned view shows the same rail.
  - After the dialog creates a request, the committee query is refetched.
- [ ] **Step 2: Implement.** Keep the existing rail layout; add the summary line under the card title and gap rows after the people. Use existing tokens and styles (`dotRow`, `dotWarn`, `textButton`).
- [ ] **Step 3: Run** `cd web-ui && npx vitest run src/features/account src/features/enrichment && npm run typecheck && npm run lint`.
- [ ] **Step 4: Commit** `feat(web-ui): buying committee coverage and Find`.

### Task 5: Web UI — edit people and confirm guessed roles

**Files:**
- Modify: `web-ui/src/features/account/{api.ts, RightRail.tsx, testing.ts}`; create `web-ui/src/features/account/EditPersonDialog.tsx`
- Test: `web-ui/src/features/account/committee-edit.test.tsx`

**Interfaces:** consumes `PATCH /api/v1/people/{id}` with `{role_keys?, confirm_role_keys?, decision_note?}` (Task 3). `editPerson(tenant, personId, body)` in `api.ts`.

- [ ] **Step 1: Failing tests.**
  - A guessed role shows "Guessed from title" with `Confirm` and `Remove`.
  - `Confirm` sends `{role_keys: <current>, confirm_role_keys: [key]}`; the toast is "Technical buyer confirmed for Dana Ortiz."
  - `Remove` sends `role_keys` without it; the toast is "Technical buyer removed from Dana Ortiz."
  - `Edit` on a person opens "Edit Dana Ortiz". Changing roles and the note, then `Save`, sends both; the toast is "Saved Dana Ortiz."
  - A 1,001-character note shows the API's message on the field.
  - The note line reads "{note} · Zach Lee, Nov 3".
  - Without `people:write`, there is no Confirm, Remove or Edit.
  - After any save, the account and committee queries refetch.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/account && npm run typecheck && npm run lint`. **Step 4: Commit** `feat(web-ui): edit buying committee people`.

### Task 6: Specs, end-to-end, full suites

**Files:**
- Modify:
  - `docs/spec/accounts/buying-committee.md` (Rulings 1-12, shipped R2b-3, "ask an agent" deferred to MCP, no backfill);
  - the offers spec (optional roles);
  - `docs/spec/web-ui/screens.md` (§4a items 2 and 8, §4b item 5, §4c `initialRoles`, the editor dialog, offers editor);
  - `docs/spec/web-ui/api-gaps.md` (committee rows READY);
  - `docs/spec/playbooks/account-brief.md` (`committee` on the brief read);
  - `docs/spec/mcp/agent-tools.md` (REST only until the server exists).
- Create: `tests/e2e/committee.spec.ts`

- [ ] **Step 1: E2E** (mock providers, an e2e-only account and offer).
  - As the owner, open an account with one stated business owner. The rail shows "1 of 3 roles covered" with "No commercial buyer yet" and "No technical buyer yet".
  - Click `Find` on Technical buyer, then `Run enrichment`. Within 30 seconds a new person appears with "Guessed from title", and the technical buyer row is no longer a gap.
  - `Confirm` it. The summary rises by one.
- [ ] **Step 2: Full suites.** Run each of these:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test:unit`
  - `npm run test:int`
  - `cd web-ui && npm test`
  - `npm run e2e`

  All must be green, except the known failures on main: the `per-workspace` afterAll, and `split` under load (it passes alone).
- [ ] **Step 3: Commit** `docs(spec): R2b-3 buying committee` and `test(e2e): buying committee`.
