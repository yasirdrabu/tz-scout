# R2b-3 code map: buying committee coverage, gaps, Find

Read-only survey of main at 16d4fb4. Paths relative to C:\dev\tz-scout.

## 1. Buying roles
- Schema `accounts.buying_role` (tenant_id, key, label, sort, archived; PK tenant+key): src/modules/accounts/db/schema.ts:222-233.
- Schema `accounts.person_role` (person_id, role_key, origin `stated|guessed_from_title|set_by_person`, set_by, set_at; PK person+role): schema.ts:127-141. `person.decision_note` is a plain text column (schema.ts:115); no who/when columns.
- Defaults seeded per tenant: DEFAULT_BUYING_ROLES src/modules/accounts/defaults.ts:5-14 = business_owner, commercial_buyer, technical_buyer, influencer, champion, procurement, blocker, user (labels "Business owner" etc.). Seeder (idempotent) defaults.ts:~57+.
- `listBuyingRoles(ctx)` -> `{key,label}[]`, active only, by sort: src/modules/accounts/services/read.ts:73-75 (allBuyingRoles :68). Exported accounts/index.ts:46.
- Route `GET /api/v1/buying-roles` (accounts:read): src/http/routes/v1/buying-roles/route.ts. Web: `buyingRolesQuery` web-ui/src/features/account/api.ts:230.
- `PersonView.roles[{key,origin,label}]` built in read.ts peopleOf (:78-110); returned on `GET /accounts/{id}` and `/accounts/{id}/people`.

## 2. Where person roles get written
- Intake (stated): normalise-arrival reads `buying_role` + `buying_roles` -> `roleKeys`: src/modules/intake/domain/normalise-arrival.ts:101-111. `matchOrAddPerson` inserts them with origin `stated` (onConflictDoNothing): src/modules/accounts/services/people.ts:~95-110; `extraRoleKeys` opt exists. Publishes person.added/updated from services/upsert.ts:181-183.
- Edit API (set_by_person): `editPerson` src/modules/accounts/services/edit.ts:80-135. `roleKeys` = the FULL desired set: deletes the rest, inserts new as `set_by_person` with setBy=userId (:101-116). Existing roles kept (onConflictDoNothing) so their origin is not upgraded: confirming a guessed role is NOT possible via this path today.
- Enrichment `people_for_roles`: src/modules/enrichment/services/run.ts:~125-145 sets `buying_role` + `buying_roles` on each found Person, then submits a targeted arrival from the vendor source (run.ts ~submit) -> origin `stated`, NOT guessed. A person found for several roles gets all.
- Role guessing from title: NONE. grep for guessRoles / guessed_from_title finds only the schema comment, the RoleOrigin type, and ACC spec. Confirmed missing.
- Natural home for `guessRolesFromTitle(title): string[]`: pure file src/modules/accounts/domain/ (siblings: seniority.ts, primary.ts; unit tests in tests/unit/accounts/). Call it in `matchOrAddPerson` (people.ts, where `wanted` is computed ~:95) only when `input.roleKeys` AND opts.extraRoleKeys are empty, inserting with origin `guessed_from_title`. That also covers enrichment results (they currently always carry a stated role, so ACC-E2-S3-AC2 "guessed from title" would need enrichment to stop sending buying_role, or send it as a hint; decide in plan). The PersonResult/origin typing: RoleOrigin in accounts/contracts/types.ts.
- Seniority precedent for title heuristics: src/modules/accounts/domain/seniority.ts; `matchesTarget`/title matching in domain/primary.ts:28.

## 3. Role editing + decision note (ACC-E2-S2)
- API exists: `PATCH /api/v1/people/{id}` (people:write, users only): src/http/routes/v1/people/[id]/route.ts. Body `patchPersonBody` = personFields + `role_keys: list`, includes `decision_note`: src/http/routes/v1/accounts/schemas.ts:30-52. API keys cannot send role_keys (route.ts:~25 returns 400).
- Publishes `accounts.person.updated` (changedKeys incl. `roles`, `decision_note`; payload roleKeys): edit.ts:125-130; event def src/modules/accounts/contracts/events.ts:62.
- GAPS vs spec: (a) decision note max 1,000 chars not validated (check personFields `decision_note: text` schemas.ts:41); (b) note "who and when" is not stored: decision_note is a pinned fact (facts carry editor + time in the fact table) but PersonView returns only the string; (c) no per-role add/remove or "confirm guessed role" operation; (d) set_by/set_at exist on person_role but PersonView.roles omits them.
- Web UI: NOTHING. RightRail.tsx BuyingCommittee only renders people read-only plus `Add a person` (POST accounts/{id}/people with name/title/email/one role, `addPerson` api.ts:239). No grep hits for role_keys or PATCH /people anywhere in web-ui/src.

## 4. Offers target roles / titles
- Columns `target_titles`, `target_buying_roles` (text[] not null default {}): src/modules/offers/db/schema.ts:67-68 (helper :24). ONE flat list each: NO required vs optional split (spec says required/optional) -> a schema or encoding decision for the plan.
- API: offers create/patch schema `target_titles: list, target_buying_roles: list`: src/http/routes/v1/offers/schemas.ts:25-26. No validation that role keys exist in buying_role.
- Approval rule: needs at least one title OR role: src/modules/offers/domain/approval.ts:32-33.
- Web UI offer editor: OfferForm.tsx has a Target titles ChipsInput (web-ui/src/features/offers/OfferForm.tsx:41,68,109,365) but NO buying-roles control; `target_buying_roles` only in the type (offers/api.ts:40, testing.ts:38 = []). So no offer can get target roles from the UI today.
- Seed data: src/modules/offers/defaults.ts offers set `targetTitles` only (lines 69,86,103,120,137,154,169,180); NO `targetBuyingRoles` anywhere in defaults. Tests set them ad hoc: tests/integration/enrichment/run.test.ts:169 (['technical_buyer']); tests/integration/offers/helpers.ts:16 (titles ['CTO'] only).
- Consumers today: scoring fit.ts:121 (buyer-on-file), explain.ts:186 ("A technical buyer on file" would_raise), enrichment/domain/run.ts:17, playbooks rules-brief.ts:46.

## 5. Best offer for an account
- Scoring computes it: src/modules/scoring/services/score.ts:172 (`bestOffer(...)` from domain/best-offer.ts), stored as `account_summary.best_offer_id` (score.ts:256,316). Read via accounts `getSummaries` (read.ts:~361-380, `AccountSummaryView.bestOfferId`, `leadOfferOverrideId`).
- Lead offer (person's pick overrides): routing `setLeadOffer` (PUT /accounts/{id}/lead-offer: src/http/routes/v1/accounts/[id]/lead-offer/route.ts); `GET /accounts/{id}/review` returns `leadOffer{offerId,name,chosen}` + `bestOfferId`: src/modules/routing/services/account-review.ts:39-40,118-119.
- Score explain `GET /accounts/{id}/score?offer_id=`: src/http/routes/v1/accounts/[id]/score/route.ts (explainScore(ctx,id,{offerId})).
- Account page: AccountPage.tsx builds `lead_offer: r.lead_offer` from the review query (web-ui/src/features/account/AccountPage.tsx:187); `scoreQuery` api.ts:77. Effective offer rule used elsewhere: `leadOfferOverrideId ?? bestOfferId` (enrichment/services/run.ts:~90 `leadOffer`; playbooks/services/inputs.ts:51 `review.leadOffer?.offerId ?? score.bestOfferId`).

## 6. Playbooks brief
- Inputs: src/modules/playbooks/services/inputs.ts:36-120 `buildBriefInput`. Imports accounts + offers + routing + scoring via their index.ts. Offer part includes targetTitles/targetBuyingRoles (:87-88); `people` = up to INPUT_CAPS.people of {id,name,title,roleKeys,roleLabels,isPrimary} (:99-106). NO coverage/gap structure, no origin.
- Schema: src/modules/playbooks/domain/brief-io.ts:44-45 (offer roles/titles), people array; ids citable via `citableIds` (inputs.ts:~122).
- Rules brief: domain/rules-brief.ts:42-60 `whoFirst` (primary, else person holding an offer target role, else first target title). Prompt: tasks/prompts/account_brief.v1.0.ts:57 prints titles/roles.
- Route: `GET /api/v1/accounts/{id}/brief` -> `getBrief` (src/http/routes/v1/accounts/[id]/brief/route.ts) - no committee/gaps field. The spec'd `committee[]` + `gaps[]` (playbooks/index.md:95,108; mcp/agent-tools.md:160-163) are NOT built.
- No `get_account_brief` tool anywhere: there is no src/mcp (src has only entry/ http/ lib/ modules/ platform/). Agent tools are spec-only. `add_person` spec (agent-tools.md:188-193) returns `committee_gaps` - also unbuilt.
- Spec: committee shape only says "same structure as getCommittee(accountId, offerId)" (ACC-E2-S1-AC2); `gaps` = buying-role keys.

## 7. Web UI
- Rail: `BuyingCommittee` web-ui/src/features/account/RightRail.tsx:19-50. Card "Buying committee"; actions: `Add a person` (people:write). Each person: Avatar, name, title, comma-joined role labels (no origin, no "Guessed from title"), decision_note. Empty copy (:34): "No people yet. Add someone you know, or Enrich will look for a business owner, commercial buyer and technical buyer." Used in ReviewView.tsx:338 and AssignedView.tsx:197 (props tenant, me, account; no onEnrich/offer prop yet). Add form `AddPersonDialog` :53-130.
- Checklist: `BeforeYouApprove` ReviewView.tsx:79-108 (Card "Before you approve"; items: open conflicts with Resolve jump, "Facts agree", `WarmIntroLine`). Returns null when none -> a gap item must be added to the guard (:92) and body. Uses `dotRow/dotWarn` styles, `textButton` for actions. It gets only (tenant,id), no onEnrich.
- Enrich dialog: `EnrichDialog` web-ui/src/features/enrichment/EnrichDialog.tsx. Props {tenant,me,accountId,name,onClose,onDone} (:15-23): NO preset-role prop. Role selection state `roles: string[]|null` (:44) defaults to CORE_ROLES (words.ts:27: business_owner, commercial_buyer, technical_buyer) not yet covered (:55-58); kind state defaults `people_for_roles`. Adding `initialKind/initialRoles` props is a small change. Estimate via `estimateQuery`.
- Opening: AccountPage.tsx:98 `enriching` state, header button `onEnrich` (AccountHeader.tsx:32,100), dialog rendered :243. Peek drawer: review/PeekDrawer.tsx:61,110,123 - own Enrich button + dialog. Peek does NOT show people/committee (no hits for committee/people in PeekDrawer.tsx).
- Spec text: screens.md:194 gap line "Buying committee has no IT, security or technical buyer." `Find with Enrich`; :225-226 rail gap rows "No IT or security contact yet" / "No technical buyer yet" + `Find`; :258 empty state. api-gaps.md:616 `Committee gap rows, Find | LATER (R2b-3) | none`.

## 8. Enrichment people_for_roles
- Request input: `RequestInput {kind, providerKey, roles?, personIds?, reason?}` src/modules/enrichment/services/requests.ts:28; route body `{kind, provider_key, roles?, person_ids?, reason?}` src/http/routes/v1/accounts/[id]/enrichment-requests/route.ts:9-14 (estimate route takes roles too). NO offer_id.
- Titles: `searchTitles(roleKey, roleLabel, offer)` src/modules/enrichment/domain/run.ts:15-19: ROLE_TITLES for business_owner/commercial_buyer/technical_buyer (:7-11), else the role label; PLUS the lead offer's targetTitles only when the offer's targetBuyingRoles includes that role. Spec ACC-E2-S3-AC1 wants "the role and the offer's titles": partly done implicitly.
- Offer is resolved server-side: `leadOffer()` src/modules/enrichment/services/run.ts:~88-103 (override ?? best). So Find needs no offer param unless a "chosen offer" is wanted.
- Per role up to PEOPLE_PER_ROLE, cap 25 people per run; found people get `buying_role(s)` (run.ts:~125-145) -> stated. Test: tests/integration/enrichment/run.test.ts:164-200.
- Because ROLE_TITLES lacks procurement/influencer/champion etc., those fall back to the label as the title.

## 9. Module boundaries
- Rules: docs/spec/architecture/module-boundaries.md:5-26 (index.ts/contracts only, ids not FKs, ctx on every call, pure logic in domain/).
- Dependency diagram lists `ACC --> OFF` (line 55): accounts may read offers. Already done: src/modules/accounts/services/primary.ts:2,16 imports `getOffer` from '@/modules/offers' (reads targetTitles of best offer). Enrichment does the same (enrichment/services/run.ts:6,98). Playbooks reads accounts+offers+routing+scoring (inputs.ts:1-7).
- Therefore `getCommittee(ctx, accountId, offerId?)` can live in accounts/services (new file e.g. committee.ts) with pure `domain/committee.ts` (coverage status); export from src/modules/accounts/index.ts (pattern at index.ts:40-60). Offers must not import accounts (offers -> TEN only). Scoring->ACC, so accounts must not import scoring (best offer id comes from accounts' own `account_summary.bestOfferId` + `leadOfferOverrideId` held in accounts summary; but lead override lives in routing's accountReview in some paths - enrichment run.ts:88-92 uses getSummaries `leadOfferOverrideId`, which IS in accounts, so use that).
- Playbooks would then call accounts `getCommittee` (PLB --> ACC allowed).

## 10. Test helpers / fixtures
- Integration: tests/integration/enrichment/helpers.ts (person(), agentKey(), accountFrom(), approved(), apolloMock; uses submitArrival + listPeople); tests/integration/intake/helpers (freshTenant, asSource); tests/integration/offers/helpers.ts:16 (`completeOffer`); tests/integration/accounts/read-edit.test.ts (editPerson roles), upsert.test.ts (roles stated), score-summary.test.ts:25 & scoring-reads.test.ts:254 (createOffer with targetTitles); run.test.ts:164 builds practice+offer with roles and sets `account_summary.lead_offer_override_id` directly.
- Unit: tests/unit/intake/normalise-arrival.test.ts (role parsing). No tests/unit/accounts dir check done; mirror existing unit layout for guess tests.
- Web: web-ui/src/features/account/testing.ts:15-30 `ACCOUNT` fixture (one person, business_owner/stated, decision_note); :193 msw handler for acc_ccu with `people: []` (empty committee). REVIEW fixture :36+. Enrichment fixtures web-ui/src/features/enrichment/testing.ts; tests enrich.test.tsx, account-page.test.tsx, brief.test.tsx. msw server: web-ui/src/test/{server,http,renderApp}.
