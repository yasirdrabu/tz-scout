# R2c playbooks full: code and spec map (2026-11-04)

Branch feat/r2c-playbooks at 5324b30. Read only. Paths are relative to the repo root. "Sketch" = the
mockup file `docs/design/Taazaa-Scout-UI-Mockups.zip` > `Taazaa Scout Operations.dc.html` (unzipped to
/tmp/mock_x for this read; not in the repo as text).

## 1. What the spec requires

### 1a. Checklist (spec IDs; all tagged R2 unless noted)

PLB-E1 templates (`docs/spec/playbooks/playbook-templates.md`):
- [ ] S1-AC1 create template: name, scope, motion, when to use, ordered steps with all fields (:145).
- [ ] S1-AC2 add, remove, reorder, duplicate steps; offsets need not be unique (:147).
- [ ] S1-AC3 saving an active template with step changes bumps `version`; old versions readable (:149).
- [ ] S1-AC4 archive stops suggestion; existing plans untouched (:151).
- [ ] S2-AC1 seed one template per Taazaa practice incl. "Public sector RFP" (:155).
- [ ] S3-AC1 template performance (plans run, outcomes, median days to meeting): R3, out.
- Rules: plan keeps template version; "A newer version of this playbook exists" + compare (:131-133);
  step types, placeholders `{account.name}`, `{person.business_owner.name}`, `{offer.promise}` (:134-138).

PLB-E2 plans (`account-plans.md`):
- [ ] S1-AC1 assign dialog shows suggested template, pick other or "No playbook" (:193).
- [ ] S1-AC2 plan exists within 2 s of assignment with all steps, owners, due dates; publish
  `playbooks.plan.created` (:195).
- [ ] S1-AC3 same template twice on one account prevented; second plan needs first completed/abandoned (:197).
- [ ] S2-AC1..AC3 customise plan: who/when history, CRM tasks update in seconds, a done step cannot be
  removed (skip instead) (:202-205). Publishes `playbooks.plan.changed`.
- [ ] S3-AC1 step todo, in progress, done or skipped with note (:210).
- [ ] S3-AC2 overdue steps amber and counted on the leader's queue (:211).
- [ ] S3-AC3 complete plan when all done/skipped; pause or abandon with reason (:213).
- Rules: due = start + week_offset x 7 moved to next working day (:175-177); owners by role (:178-180);
  steps targeting a buying role link to people, else "No <role> on file" + Find (:180-181);
  CRM task done -> step done via `crm.activity.observed`, step done in Scout -> `playbooks.step.completed`
  (:184-185); decline pauses, reassign resumes with new seller (:186-187).

PLB-E4 account page (`account-page.md`): R2 pieces only
- [ ] "Playbook" in right column and the suggested-playbook preview for reviewed-not-assigned (:239, :250-251).
- [ ] S2-AC1 working view: plan and activity above brief, overdue amber (:278). (AC2 Open in CRM, AC3 Log
  outcome are outcomes/CRM: not playbooks; AC3 is R3-ish, confirm.)

PLB-E5 (`outreach-calls-and-proposals.md`): S1-AC2 "email steps in the plan link to the matching
sequence email" (:?) is superseded by user answer (email step = draft; first email step = initial message).
S1-AC1/S2/S3 (sequence, call prep, proposals) are NOT in R2c scope as recorded; ask (Q below).

Events (index.md:61-83): publish `playbooks.plan.created`, `.plan.changed`, `.step.completed`;
consume `routing.assignment.created` (:77), `.declined` (:78), `crm.activity.observed` (:79),
`accounts.account.merged` (:82). API (index.md:93-102): `GET /accounts/{id}/plan`, `PATCH /plans/{id}/steps/{step_id}`,
`GET/POST/PATCH /playbooks`; api-gaps adds `PUT /offers/{id}/playbooks/{tier}`, `:duplicate`, `:archive`
(api-gaps.md:1040, 1046, 1051-1053).

### 1b. screens.md sections
- §4a item 7 Playbook preview (:224-225): "{name} . {n} steps over {d} days . starts when accepted"; rows day, step, owner, status.
- §4b item 2 Playbook progress (:253-255): "{name} . Day {d} of {n}", bar, rows checkbox/day/step/owner/status
  (Done, "Due Nov 18" amber, In progress, Not started); item 1 tile "Next: Nov 18 with ..." (:244, meetings; CRM, not playbooks).
- §6 Assign dialog (:335, :349-353): Playbook radio cards + footer "and starts {playbook} on {date}".
- §7 My accounts (:370-391): subtitle "{n} next step due today, {n} overdue"; New assignments row
  " . {playbook} playbook"; toast "Accepted. {playbook} starts {day}."; Active table Next step + Due columns.
- §8 All accounts Next step (and due) column (:407). Queue: not mentioned beyond overdue count (E2-S3-AC2 "count on the leader's queue" has no screens.md home).
- §19 Offers (:668, :681-684): Playbook by tier selects (Act now, Good fit, Watch) with "{n} steps over {d} days . {x}% book a meeting" (rate R3), Initial message + Copy, Seller guide (Talking points, When they say, Proof points, Avoid). Form fields :(Initial message, Talking points, Objections `objection | answer`, Proof points, Avoid).
- §20 Playbooks screen (:708-736): list, detail, form, assign dialog. Route `/t/:tenant/playbooks/:id?`, `playbooks:read`, edits `playbooks:manage`. Rates/Won tiles R3.
- §21f Scoring weights footnote (:901): "running playbooks keep going" after rescore.
- Not in R2c: Settings has no playbook tab. No separate "seller guide" screen: the guide is a section of the offer page, shown to the AE "on every account matched to this offer" (sketch) , but §4 account page does NOT list a seller-guide panel (gap, see Q).

### 1c. Contradictions
1. **Start trigger.** Spec: plan created on `routing.assignment.created` (account-plans.md:175; index.md:77; REV index.md:40-42 passes `templateId` through) vs screens: "starts when accepted" (:224), "Accept to start the playbook" (:375), explainer "Starts on acceptance" (:719), assign dialog text "start this playbook when an AE accepts" (:735). CRM push still starts on assignment, not acceptance (`docs/spec/crm-sync/index.md:97`). Decision 25 is silent on trigger; the mockup/screens win -> start on `routing.assignment.accepted`.
2. **Per-assignment pick vs per tier.** Account-plans S1-AC1, REV-E2-S1 (`assignment-and-decline.md:16, 42, 46`), screens §6 radio cards, and routing `templateId` all assume the leader picks a playbook at assignment. Decision 25 (api-gaps.md:106) + §20:735 + §19 make it automatic: offer + account tier -> `offer_playbook`. Needs a ruling: drop the §6 cards, or keep as an optional override (then `assignment.template_id` is used). "Recommended for this account" (§6:350) fits the override reading.
3. **Weeks vs days; template scope.** Spec is `week_offset`, `scope practice|offer`, `practice.default_playbook_id` suggestion chain (playbook-templates.md:128-130; offers practices.md:32); Decision 25 says days, tier mapping, stop rule, mode "go into docs/spec/playbooks/ before its plan" and api-gaps.md:1204 marks it "Applied" but `docs/spec/playbooks/*` is still week-based and has no `offer_playbook`, `stop_when`, `draft_mode` (grep: none). The spec edit is still to do.
4. **Decision 25 text vs user answer.** Decision 25 (quote): "(As recommended.) The mockup wins for Playbooks: `offer_playbook(offer_id, tier, template_id)`, day-based steps, a stop rule and a draft or auto-send mode go into `docs/spec/playbooks/` before its plan." User answer says drafts only. So: no auto-send mode, no "Sends automatically" tag, no `auto_send` (api-gaps.md:1051-1053), drop the form's "Send emails automatically" option (§20:731) and rule "Drafts" row; spec text and the screen must be edited.
5. **Initial message ownership.** §19 and the sketch make it an editable offer field (`message`) shown with Copy; api-gaps.md:861 says "better owned by playbook templates"; user answer: it is the tier playbook's first email step, read-only on the offer page. So remove "Initial message" from the offer form (§19:693) and take it from the playbook step. Placeholders differ: sketch `{first_name}`/`{company}` vs spec `{person.business_owner.name}`/`{account.name}`.
6. **Channel/owner vocab.** Sketch channels Email, LinkedIn, Call, Task, Meeting and "who" Scout, AE, Practice lead; spec types (9, playbook-templates.md:134) and `owner_role` seller/leader/operator. "Scout" as a doer = a draft step.
7. **CRM tasks overlap.** CRM already makes a first-touch task (day 0) and follow-up tasks (days 3/7/14, tenant setting) at handoff (`docs/spec/crm-sync/handoff-push.md:93-96`, code below). A playbook with an email on day 0 and 5 would double them. Spec PLB-E5 also has a 4-email sequence. Needs a ruling.
8. **Task timing.** Plan starts on accept but the handoff (and `HandoffPackageProvider`) runs on assignment; plan step tasks therefore must be added by a later push/update, not at handoff (CRM index.md:100 consumes `playbooks.plan.created`; not built).
9. **Stop rule / pause.** Screens "Stops when reply/meeting, Pauses when" (:728-729, :724); spec has only manual complete/pause/abandon (S3-AC3) and pause-on-decline (api-gaps.md:1041 "pause on decline is fixed"). With acceptance as the start, a decline happens before any plan exists, so "declined -> paused" only matters for post-accept withdrawal/reassign.
10. Permissions: spec `playbooks:write` for step patch and `playbooks:manage` for templates (index.md:99-102); seller holds read+write, leader/operator/owner hold manage (`src/modules/tenancy/domain/permissions.ts:19-21,73`). Consistent with screens.
11. Tier set: screens show 3 selects (Act now, Good fit, Watch); tiers also include Nurture and Not a fit (no playbook; stage `back_to_nurture` fires on `playbook_no_reply`).

## 2. What exists today

### 2a. src/modules/playbooks (brief + handoff only)
- Schema `src/modules/playbooks/db/schema.ts`: `brief` (:15), `brief_section` (:77), `brief_section_history`. NO plan, template, step, offer_playbook tables. Migrations 0000_playbooks_schema.sql, 0001_brief_drafting_guards.sql (`db/migrations/meta/_journal.json`); next is 0002. Module order in `src/platform/db/migrate.ts:8` has playbooks after routing.
- Services: brief.ts, draft.ts, edit.ts, read.ts (getBrief), inputs.ts, merge.ts, sweep.ts, backfill.ts, best-offer.ts, package.ts (`handoffPackage`, `playbooksHandoffPackage` :80ff).
- Domain: package.ts (`buildPackage`, sets `planSteps: []` at ~:108), follow-ups.ts (rules follow-up emails by tenant follow-up days), rules-brief.ts, recommendation.ts.
- AI tasks: only `account_brief` (`tasks/account-brief.ts`, prompts/account_brief.v1.0.ts). No `outreach_sequence`, `call_prep` etc.
- Consumers (`consumers.ts`): scored, signal, fact, person added/updated, review.changed, assignmentCreated (freezes brief), declined/withdrawn (unfreeze), account merged, tenant created (sweep schedule). None for assignment accepted, crm.activity.observed.
- Public interface `src/modules/playbooks/index.ts`; `defaults.ts` seeds only the sweep schedule (:7).
- Routes under `src/http/routes/v1`: only `accounts/[id]/brief/route.ts` (GET, `playbooks:read`) and `accounts/[id]/brief/sections/[key]/route.ts`; POST `:draft-brief` lives in `accounts/[id]`. No `playbooks/`, `plans/`, `offers/[id]/playbooks` routes.
- HandoffPackageProvider "playbooks minimum": port in `src/modules/crm/contracts/ports.ts:8` (`package(ctx, accountId, assignmentId)`); type `HandoffPackage` in `src/modules/crm/contracts/types.ts:44-50` has `planSteps: {stepId, subject, body, dueAt}[]`. Implementation ignores assignmentId; registered `src/entry/compose.ts:27`.
- Existing playbook placeholders: `routing/services/read.ts:171 playbookName: null`, `:175 nextStep: null`, set at `:228,:231`; `routing/services/pipeline.ts:47,128 nextStep: null` (AccountListRow). `routing/services/assign.ts:165,194 templateId: null`. `offers/db/schema.ts:37 practice.defaultPlaybookId` (opaque, unused).
- Unit/integ tests: `tests/integration/playbooks/*.test.ts`, `tests/integration/v1/playbooks.test.ts`, `tests/unit/playbooks/*`.

### 2b. web-ui
- Offers: `web-ui/src/features/offers/OfferView.tsx:34` comment: playbook by tier, initial message, seller guide "are R2 and not rendered". `OfferForm.tsx`: no initial message / guide fields. `offers/api.ts` Offer type has `proof_points`, `key_offer`, `why_us`, `why_now`, roles.
- Playbooks screen: `web-ui/src/routes/workspace.tsx:153-156` Placeholder (`routes/screens.ts:13` tag R2); nav `app/nav.ts:65` (`playbooks:read`).
- Account page: `features/account/BriefCard.tsx` (brief only); `AssignedView.tsx`, `ReviewView.tsx` have no playbook section/preview (grep "playbook" returns none). `features/account/testing.ts` has `ASSIGNED`, `BRIEF`, `serveAccount`.
- My accounts: `features/accounts/MyAccountsScreen.tsx:141` already shows `" . {playbook_name} playbook"`; `accounts/api.ts:38 playbook_name`. No Next step/Due columns in My or All accounts (grep nextStep: none in web-ui). Assign dialog `features/review/AssignDialog.tsx`: no playbook cards.

## 3. Tiers
- Keys: `TIERS = ['not_fit','nurture','watch','good_fit','act_now']` (`src/modules/scoring/contracts/types.ts:7`), labels `TIER_NAMES` (:12: Act now, Good fit, Watch, Nurture, Not a fit). Tier computed in `scoring/domain/tiers.ts` (`tierFor`); stored on `scoring` schema and copied to `accounts.account_summary.tier` (used by `routing/services/pipeline.ts:127 tierLabel`). Spec: four-weight-model.md wins over tiers-and-best-offer.md (:5); hand-set tier exists (`accounts/[id]/tier`).
- Offer holds a playbook per tier: new table in playbooks `offer_playbook(tenant_id, offer_id, tier, template_id)` (Decision 25; PK tenant+offer+tier; tiers allowed: act_now, good_fit, watch, since screens show three). Cross-module refs are ids only (`docs/spec/architecture/module-boundaries.md:12`). Offers module must not import playbooks (OFF -> TEN only); the HTTP route `PUT /api/v1/offers/{id}/playbooks/{tier}` (api-gaps.md:1040) sits above modules and may call both (module-boundaries.md:~75).
- Resolution at accept: lead offer = `account_review.leadOfferOverrideId ?? summary.bestOfferId` (same rule as `routing/services/read.ts:~218`), tier = `account_summary.tier` at accept time; snapshot template_id + version in the plan so later changes and rescores do not move running plans (§19:683, §21f:901).

## 4. Plan start trigger
- `routing.assignment.created` (`routing/contracts/events.ts:27-42`, has `templateId`, `offerId`) consumed by crm (`crm/consumers.ts:60`) and playbooks `briefFreeze` (`playbooks/consumers.ts`).
- `routing.assignment.accepted` (`routing/contracts/events.ts:47-55`, `acceptedHow` seller | crm_activity | auto_timeout) is published at `routing/services/respond.ts:55` and has NO consumer anywhere in src. R2c adds a playbooks consumer ordered by accountId; auto accepted (timeout / CRM activity) must also start plans (screens §7 "Accepted automatically"). Event lacks tier/offer: read offer from `getSummaries` + review override, or add fields (routing change).
- `assignment.declined`/`withdrawn`: pause or abandon (only matters if plan exists; reassign: `previousAssignmentId` on created).
- Stages: `docs/spec/review-and-routing/configurable-stages.md:41,62` and `routing/domain/pipeline.ts:17,61`: trigger `playbook_no_reply` ("fires once R2 playbooks run") moves to `back_to_nurture`; nothing publishes it yet. `stage-tracking-and-status.md:21` and REV index.md:80: `playbooks.outcome.recorded` -> Engaged (outcomes are R3, but a stop rule "they reply/book" reads CRM `crm.activity.observed` reply/meeting, which Routing already uses for Engaged). Need a stable hook: playbooks publishes e.g. `playbooks.plan.finished`/changed with `status`; routing consumes for `playbook_no_reply`. Decision needed on event name (not specified).
- Routing depends on stage keys (tenant-configurable): playbooks should not hardcode stage keys.

## 5. CRM
- Task code: `crm/domain/tasks.ts` `buildTasks` (first touch day 0, follow-ups by `crmSetting.followUpDays`, due 17:00 tenant tz, :4-54); `crm/services/handoff.ts:310-338` upserts tasks keyed `${assignmentId}:first_touch` / `:follow_up:${day}`, records `crm.link` (scoutType 'task'). Adapter ops `upsertTask`, `closeTask` in `crm/contracts/adapter.ts:99-111,230-231`; mock `crm/adapters/hubspot/mock.ts` (mock/live selected by `registerAdapter('hubspot', {mock, live})`, `adapters/hubspot/register.ts:6`; mock tables `mockTask`, test uses `seedMockCrm`, `tests/integration/playbooks/handoff-package.test.ts:1-30`).
- NOT built: use of `pkg.planSteps` (type exists, never read in handoff.ts); a `crm.task_link` writer (table `crm/db/schema.ts:215-225` exists, read in `crm/services/follow-through.ts:105-107` to resolve `stepId` on `task_done` activities which already publish `crm.activity.observed` with `stepId` (`crm/contracts/events.ts:71`)); consumers for `playbooks.plan.created/.changed/step.completed` (spec crm index.md:100-101).
- Events crm consumes today: tenant created, account created/updated, assignment created/declined/withdrawn, person added/updated, account merged (`crm/consumers.ts`). CRM must not import playbooks (module-boundaries; crm index.md:48-57): it needs a new port or event carrying step data (spec index.md:65 lists `steps` in `plan.created`). Task for each non-draft step: `crm_task` flag default true (index.md:23). User rule: email step = DRAFT in Scout (body stored on the step), HubSpot task carries the draft/subject; AE sends.
- Complete direction: step done in Scout -> `playbooks.step.completed` -> crm `closeTask` (completes). HubSpot done -> `task_done` -> Playbooks marks step done (needs consumer on `crm.activity.observed` kind `task_done`, `stepId`).

## 6. Queue / My accounts / All accounts "next step" and "due"
- `AssignmentRow.nextStep: null` and `playbookName: null` (`routing/services/read.ts:171-176, 228-231`) and `AccountListRow.nextStep: null` (`routing/services/pipeline.ts:46-47, 128`); web-ui types have `playbook_name` (accounts/api.ts:38) but no `next_step`. Fix shape: `{title, due_at, overdue}`, derived from earliest open plan_step by due date.
- Routing cannot import playbooks (REV -> PLB dependency is the other direction: PLB depends on REV, module-boundaries.md PLB-->REV). So the join must be done either at the HTTP layer (route calls playbooks `nextSteps(ctx, accountIds)` and merges) or via an inverted provider port defined in routing. Pick one in the plan; HTTP-layer merge is least invasive (handlers may call any module).
- Review queue (`review-queue` routes, `routing/services/queue.ts`): no next-step field; E2-S3-AC2 "overdue count on leader's queue" has no screen. Treat as optional/defer.
- Subtitle counts ("{n} next step due today, {n} overdue"): needs `GET /api/v1/me/counts` or an assignments total (api-gaps.md ~:543) , `me/counts` route exists under `src/http/routes/v1/me`.

## 7. Seller guide
- Spec: no module or story defines it. Only screens §19 (:683-684, form :689-694) and api-gaps.md:862 "Seller guide: talking points, objections, avoid | LATER (R2) | none | Tagged R2"; api-gaps.md:879 "R2: seller guide, initial message, playbook by tier". Sketch (lines ~1595-1612 and `OF_FIELDS` ~2767): Seller guide block = Talking points (one per line, numbered), "When they say" (objection | answer pairs), Proof points, Avoid; "Shown to the AE on every account matched to this offer." Empty state: "No seller guide yet. Write one".
- Code: `offers/db/schema.ts` offer has `proofPoints` (:78) but no talking points, objections, avoid. Where the guide is shown to an AE is unspecified (account page has no panel). Natural home: offers module columns (`talking_points`, `objections jsonb`, `avoid` text[]) plus a read-only "Seller guide" card on the account page assigned view reading the lead offer; offers owns data, edit needs `offers:manage` (`offers.test` helpers: `tests/integration/offers/helpers.ts`).

## 8. Module boundaries
- `docs/spec/architecture/module-boundaries.md` graph: PLB -> ACC, OFF, AI, SCO, REV, CRM; CRM, REV and OFF never import PLB. Playbooks code already imports routing events (`playbooks/consumers.ts:3`), accounts, crm (`HandoffPackageProvider`, `getCrmSettings`), intake. Boundary lint: `eslint.config.mjs`, test `tests/unit/boundaries.test.ts` (modules import others only via `index.ts`/`contracts/*`).
- Who may call playbooks: HTTP handlers and MCP (`get_account_brief`, spec mcp/agent-tools.md:158); CRM and Routing via events or inverted ports only. Add exports to `src/modules/playbooks/index.ts`. Cross-module ids, no FKs. All tables tenant_id + RLS (header of `playbooks/db/schema.ts`; policy added by hand in the migration, see 0000_playbooks_schema.sql). IDs `plb_`, `pln_`, `stp_` (data-conventions.md:26). Events must be defined (`defineEvent`) and added to the worker consumer list `playbooksConsumers`, `docs/spec/architecture/event-catalog.md:54-58`.
- Scheduling: due-date "overdue" reads need no job; "Due today" needs tenant timezone (`@/platform/time`, used by crm tasks.ts).

## 9. Test helpers and fixtures
- Integration: `tests/integration/playbooks/helpers.ts` (`routingTenant`, `scoredAccount(t, tier, over, opts)`, `runPlaybooks`, `briefRow`, `draftJobs`, `deferred`), `tests/integration/routing/helpers.ts` (`routingTenant`, `arrivedAccount`, `resolved`, `member(t, 'seller'|'leader')`, `asPerson`, `summaryOf`, `setSummary`), `tests/integration/offers/helpers.ts` (`completeOffer`; use with `createOffer`/`approveOffer`/`createPractice` as in handoff-package.test.ts:1-30), `tests/integration/helpers/run-outbox.ts` (`runOutbox`), `helpers/publish.ts` (`publishTestEvent`), `helpers/wait.ts`. HTTP: `tests/integration/v1/review-helpers.ts` (`workspace()`, `Role`), `session-helpers.ts` (`signedIn`, `v1Req`); examples `v1/playbooks.test.ts`, `v1/offers.test.ts`, `v1/routing.test.ts`. CRM mock seeding: `seedMockCrm`, `syncOwners`, `setCrmSettings` (crm index). Accept flow: `routing/respond.test.ts`, `assign.test.ts`.
- E2E: `tests/e2e/helpers.ts`, `offers.spec.ts`, `account.spec.ts`, `committee.spec.ts` (latest pattern), `background*.ts` (worker for consumers).
- web-ui msw: `web-ui/src/test/server.ts`, `http.ts`, `renderApp.tsx` (`serveMe`); `features/offers/testing.ts` (`offer()`, `practice()`, `BLUEPRINT`, `MANAGER`, `READER`, `BUYING_ROLES`); `features/account/testing.ts` (`ACCOUNT`, `ASSIGNED`, `REVIEW`, `BRIEF`, `serveAccount`, `PAGE_LEADER`, `SELLER`); `features/review/testing.ts` (assign dialog); `features/accounts/my-accounts.test.tsx` (My accounts rows).
- API types: web-ui hand-types per feature `api.ts` today (C3 generated schema not present; `web-ui/src/api` has no schema.ts).

## 10. Suggested split (3 plans)

**R2c-1 Backend: templates, tiers, plans** (no UI)
- Spec edit first (Decision 25 + user answers): days, `offer_playbook`, stop rule, drafts only, start on accept, drop auto-send.
- Playbooks tables: `playbook_template` (+ steps, versioning), `offer_playbook`, `account_plan`, `plan_step` (+ history); migration 0002 with RLS.
- Services: template CRUD/duplicate/archive/delete, set offer playbook per tier, resolve (offer, tier) at accept, build plan with snapshot version, due dates in tenant tz, step owners, `PATCH step`, complete/pause/abandon, overdue/next-step query `nextSteps(ctx, accountIds)`.
- Consumers: `assignmentAccepted` (start), declined/withdrawn (pause/abandon), `accountMerged` (repoint). Events `playbooks.plan.created/.changed/.step.completed`.
- Routes: `GET/POST/PATCH /playbooks`, `:duplicate`, `:archive`, `PUT /offers/{id}/playbooks/{tier}`, `GET /accounts/{id}/plan`, `PATCH /plans/{id}/steps/{id}`; `next_step`/`playbook_name` in assignments and accounts list; seed templates (S2-AC1).
- Draft email content for email steps (rules/AI draft using `followUps` domain; keep AI optional).

**R2c-2 Web UI: Playbooks screen and offer page**
- §20 list/detail/form/assign dialog; offer page "Playbook by tier" selects, read-only Initial message with Copy (first email step), Seller guide card plus form fields (offers module columns); My accounts + All accounts Next step/Due, subtitle counts, accept toast with playbook; nav/permissions.

**R2c-3 Plans on accounts and CRM tasks**
- Account page: §4a item 7 preview, §4b item 2 progress, step update (status, note, owner, due), customise (add/edit/remove), seller guide on assigned view.
- CRM: consume plan events (new port/event, not import), upsert/close HubSpot tasks, write `crm.task_link`, handle `task_done` -> step done, resolve first-touch/follow-up overlap, `playbook_no_reply` stage trigger. Mock mode first (`seedMockCrm`), live adapter already has `upsertTask`/`closeTask`.
- Could be merged into -1 backend if the owner wants fewer plans; CRM piece is the riskiest and independent of UI.

## Questions only the product owner can answer
1. Keep the assign-dialog playbook picker (override) or drop it entirely for tier-driven only? Does `assignment.template_id` stay?
2. Existing HubSpot first-touch and day 3/7/14 follow-up tasks vs the playbook's email steps: replace them with the playbook's tasks when a plan exists, or keep both?
3. Where does the seller guide live (offer columns in Offers, or playbook-owned) and where does the AE see it (account page panel, HubSpot note)?
4. Stop rule semantics: does "they reply / book a meeting" end the plan (status completed vs a new `stopped`), what is "Pauses when", and which event name drives the `playbook_no_reply` stage move?
5. Are PLB-E5 sequence/call prep/proposals and the leader-queue overdue count in R2c, or later? Is "Log outcome" (PLB-E4-S2-AC3) R3?
6. Tiers: only Act now, Good fit, Watch get playbooks? If a tier has no playbook, accepting starts no plan (silent), correct?
