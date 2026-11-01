# Web UI R1 screens (Sources, Batches, Offers, Review statuses) and polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rest of the R1 screens in the new app, each with the backend gaps it needs. These are Sources (§10), the Source page with every tab including Settings (§11), Add a source (§12), Batches and imports (§13), Batch detail (§14), Import a list (§15), the R1 parts of Offers and practices (§19), and Settings > Review statuses (§21d). Before them comes a set of small fixes that the review flow and Playbooks work found: names instead of handles and keys, the full ownership warning, one-call queue counts, a bulk assign preview, the rescore banner, a light best-offer read for the weekly batches, and the take-back reason.

**Architecture:** Backend changes stay in the owning modules (intake, accounts, tenancy, offers, routing, scoring, crm, playbooks). They are exposed under `/api/v1` through `v1Route` and registered in the Hono route table `src/http/routes.ts`. Static paths (`sources/stats`, `members/directory`, `review-queue/assign-preview`) go before their `:id` siblings. On the UI side there are new `web-ui/src/features/{sources,batches,offers}` and `features/settings/review-statuses`, built on the existing primitives (`ui/*`, `FilterPopover`, `Table`, `Dialog`, `Drawer`, `Tabs`) with TanStack Query and MSW tests. Each screen group has a backend task, then a UI task, so groups can ship on their own in this order: Polish (Tasks 1 to 3), Sources (4, 5), Batches (6, 7), Offers (8, 9), Review statuses (10).

**Tech Stack:** As the review flow and Playbooks plans: Hono, Drizzle, Postgres with forced RLS, Vitest, React 18 with Vite, TanStack Router and Query, MSW, Playwright. No new dependencies.

**Spec:**
- `docs/spec/web-ui/screens.md` §2 (banner, loading line), §4a (facts, Why now), §6 (ownership warning), §10 to §15, §19, §21d, and "Main flows" 3
- `docs/spec/web-ui/index.md` C6 to C10, C14
- `docs/spec/web-ui/api-gaps.md`:
  - sections `## intake`, `## accounts`, `## tenancy` (source keys, member directory), `## offers`, `## routing` (statuses editor, assign preview), `## crm`
  - "Decisions taken" 9 to 16 (binding)
  - "Open questions" 6 (binding)

Earlier reports:
- `review-flow-ui-report.md` "Backend gaps" 1, 2, 4, 5 and "Concerns" (bulk previews)
- `playbooks-t7-8-report.md` "Backend gaps" 1 to 3
- `playbooks-t4-6-report.md` (the undo `{reason}` note)

## Scope

In:
- **Polish:** fact labels; signal source names; seeded display names and person source names; ownership preflight details; `total_all_tiers` and `source_count` on the queue facets; `POST /review-queue/assign-preview`; the latest rescore read and its banner; the light best-offer read in CRM weekly batches; the decline or withdraw reason on the take-back record and in the activity row.
- **Sources:**
  - one source read
  - list fields and filters
  - per-source stats
  - an editable owner (Decision 11)
  - the `list` kind (Decision 12)
  - Remove vs Archive (Decision 13, Open question 6)
  - duplicate names
  - `:sync`
  - key create, rotate and revoke for this source (Decision 14)
  - the member directory
  - `feedback?source_id`
  - `first_arrival` on the accounts list
  - all of §10 to §12 in the UI
- **Batches:** filters and derived status on the list; detail fields; item filters and fields; original file download; the rejections CSV; `:retry`; import `source_id`, `notes` and `name`; the column-match read; `without_website`; discarding an import; all of §13 to §15 in the UI.
- **Offers:** content fields (Decision 16); unapprove, approve under `offers:manage`, a guarded delete (Decision 15); offer stats; practice lead, practice read, `offer_count`; the R1 parts of §19 in the UI.
- **Review statuses:** one atomic save across statuses, reasons and auto-accept; the §21d editor.
- **e2e:** an operator adds a list source, imports a list into it and resolves a waiting row; an owner edits an offer; an owner edits a review status and a send-back reason and the queue shows both.

Out, by owner:
- **R2:** seller guide (talking points, objections, avoid), initial message, playbook by tier (§19: these sections are not rendered); "Waiting on enrichment"; per-account ownership decisions in bulk assign.
- **R3:** trust numbers, bars, the band filter and legend (show "Not enough data yet", C9); cost per win; `See in funnel`; attributed win rate.
- **R4:** partner portal and `Copy portal link`.
- **R1d:** "Used by" on a data vendor; scheduled pulls.
- **Unscheduled:** queue threshold and "Below Watch, not queued" (Decision 10).
- **Not in this plan:** `Open settings` on the rescore banner (the Scoring weights tab is hidden until the scoring redesign, Open question 5).

**Confirmed by the user (2026-11-01):** seed display names Zach Wiant, Ash, Mike, Andy, Yasir Drabu, Northwind Owner; add a dev-seed operator riley@taazaa.com "Riley"; build group by group, one PR per group (polish, Sources, Batches, Offers, Review statuses). The plan's other recommended answers stand.
## Rulings (where the spec leaves a gap; each is built as written)

1. **Where a `list` source sits in the chain.** A `list` has a person source as its parent and takes the `agent` slot of the source chain, as an agent does. So `account_summary.source_ids` rolls it up to its person. It is created only through `POST /sources` with `parent_id` set to a person source. The error is "A list needs an owner. Pick the person who uploads it." A list never holds keys: `create_key` and `POST /sources/{id}/keys` give 400 "A list gets its accounts from files, not the API.".
2. **Remove, Archive, and what shows where (Decision 13, Open question 6).**
   - `DELETE /api/v1/sources/{id}` removes a source that has sent nothing. It sets the new status `removed` (the column is text, so no migration is needed) and revokes the source's keys. A removed source is a 404 everywhere and is never listed or offered in a picker.
   - When the source has sent, the call is 409 `source-has-sent` with the title "{name} has sent accounts, so it can only be archived.".
   - `PATCH {status:"archived"}` stays as it is: it is final and revokes keys.
   - `GET /sources` leaves archived sources out by default and lists them with `?status=archived`. `GET /sources/{id}` still opens an archived source, and the page is read only, with the status pill "Archived".
   - `has_sent` means at least one arrival credits the source anywhere in its chain.
   - A source with children can't be removed or archived until its children are. The error is 409 `source-has-children` with the title "Remove or archive the sources under {name} first.".
3. **Owner (Decision 11).**
   - `intake.source.owner_user_id` is a nullable column. It must point at a member (400 "That person is not a member of this workspace.").
   - The owner starts as follows: a person source, its person; an agent or a list, the parent's person; anything else, the creating person when the actor is a user, else null.
   - `owner{user_id,name}` comes back on the list and on the read. `PATCH {owner_user_id: string|null}` changes it and is audited as `intake.source.owner_changed`.
   - The owner is display only: nothing routes to it.
4. **Stats tiles.**
   - **Sent** is the number of accounts that have the source in `source_ids`, so Sent, Reviewed, Assigned and Won share one base. Reviewed, Assigned and Won are cumulative by stage rank, as `FUNNEL` defines it. Declined and lost count in Sent and Reviewed only.
   - The `%` lines come from the API (`reviewed_pct`, `assigned_pct`, `won_pct`; null when the base is 0).
   - `is_new` is true when fewer than 10 accounts are reviewed. "New" and "Paused" are tags from the API.
5. **One HubSpot source.** Only the seeded `hubspot_qualified` source is polled. A second `crm` source is refused: 409 `conflict` "This workspace already syncs from HubSpot.". `GET /sources` meta carries `can_add_crm`, and the CRM card shows only when it is true.
6. **How it sends.** `method` is one of `api_key`, `through_parent`, `file_upload`, `hubspot_sync` or `none`:
   - `through_parent` for an agent or `scheduled_pull`
   - `file_upload` for a list
   - `hubspot_sync` for `crm`
   - `api_key` when there is an active key, else `none`

   `method_label` carries the words: "API key", "Through {parent}", "File upload", "HubSpot sync", "Not sending yet". `active_key` is the newest unrevoked key `{id, prefix, last_used_at, created_at}`, or null.
7. **Keys under a source (Decision 14).**
   - Rotate is per key: `POST /sources/{id}/keys/{key_id}:rotate`. In one transaction it creates a key with the old key's name, scopes, data limit and environment, then revokes the old one with the reason `Rotated`.
   - Revoke is `DELETE /sources/{id}/keys/{key_id}`.
   - A key that is not this source's is a 404.
   - The UI says "The old key stops working within a minute." because other instances keep it for up to 60 s.
8. **Derived batch status.**
   - `failed`: the linked import is `failed`.
   - `in_progress`: the stored status is `processing`, or the import is `queued`.
   - `needs_attention`: waiting > 0, or rejected > 0 with a retryable row.
   - `complete`: anything else.

   The status labels are "Failed", "In progress", "Needs attention" and "Complete". `issue` is one line:
   - "Import stopped: {error}"
   - "{n} rows need a website, a company or a duplicate check"
   - "{n} rows hit the daily limit"
   - else null

   `retryable` counts the rejected `daily_cap_reached` rows, plus the rows an import left when it stopped because its source was paused.
9. **Item outcome copy** comes from the API as `outcome_label`:
   - "Resolved: New account"
   - "Resolved: Matched {account}"
   - "Rejected: Duplicate of another row in this batch"
   - "Rejected: Invalid row"
   - "Rejected: Excluded"
   - "Rejected: Daily limit reached"
   - "Waiting: Needs a website"
   - "Waiting: Needs a company"
   - "Waiting: Possible duplicate"

   Each row also carries `outcome` (`new_account|matched|rejected|waiting|resolving`) and `waiting_on`.
10. **Import source (Decision 12).**
    - People with `sources:manage` may send `source_id` naming an active `person`, `partner` or `list` source. Anyone else sending `source_id` gets 403 "Only people who manage sources can credit another source.".
    - The batch chain is that source's chain. Mappings are saved under that source.
    - Daily caps apply to the credited source.
    - `uploaded_by` is always the actor.
11. **Discard an import.** `DELETE /imports/{id}` works only while the import is `needs_confirm` (409 otherwise). It sets the new status `cancelled`, deletes the stored blob and leaves the batch row empty. `GET /batches` leaves out batches whose only import is `cancelled`.
12. **Offer lifecycle (Decision 15).**
    - `:approve` needs `offers:manage` (the owner-only check goes) and people only. Its `offer-incomplete` `errors[]` stays as it is.
    - `:unapprove` moves `approved` to `draft`, clears the approver and publishes `offers.offer.changed`. It is 409 for an archived offer.
    - `DELETE /offers/{id}` answers 204 when the offer never matched, else 409 `offer-has-history` "{name} has matched accounts, so it can only be retired.". "Never matched" means all of these: no `scoring.offer_match` row; no `scoring.score_change` with this offer as `from_offer_id` or `to_offer_id`; no lead-offer override or `routing` lead offer change naming it. Scoring and routing answer through a new port `OfferUsage.hasHistory(ctx, offerId)` that offers declares, compose.ts registers, and scoring and routing implement. The delete also removes the offer's signal rules and case-study links, and is audited.
    - Practice archive keeps the "approved offers only" rule. The copy becomes "Retire or move its active offers first.".
13. **Offer fields (Decision 16).** These are new columns on `offers.offer`:
    - `price_model` (`fixed|starting_at|per_month|custom`, nullable)
    - `length_weeks` (int, 1 to 260, nullable)
    - `key_offer`, `why_us`, `why_now` (text, 4,000 characters, nullable)

    Summary is `promise` and Ideal customer is `description`. Editing these fields never moves an approved offer to draft; only buyer fields do, as today. The price line (`price_label`) comes from the API: "Fixed fee · 6 weeks", "Starting at $40,000", "$8,000 per month", "Custom quote".
14. **Offer stats.** `matched` counts accounts whose current `offer_match` is not `not_fit`. `won` counts accounts at stage `won` whose best offer or lead offer is this one, under `visibleAccounts`. `win_rate` is `won / matched`, or null when `matched` is 0. The page labels these "current", not attributed (R3).
15. **Display names.** A person's name is never a handle:
    - New users (`addMember`, `ensurePlatformAdmin`, and the e2e helpers) get `displayNameFromEmail`. It splits the local part on `.`, `_` and `-` and capitalises each part: `zach.wiant` becomes `Zach Wiant`, `ash` becomes `Ash`.
    - The seed sets explicit names, and the backfill renames any user whose name equals their email's local part.
    - Person sources are named after their person's name.
    - Microsoft sign-in keeps the name Entra sends.
16. **Rescore banner.**
    - The banner reads the scoring profile's `updated_at` and `updated_by` together with `scoring.score_change` rows with cause `rules_changed` since then. No new table is needed.
    - "Recent" means within 7 days. The banner is dismissed per person and per change (localStorage key `scout:rescore-banner:{tenant}:{version}`).
    - A manual `POST /rescore` shows no banner. The spec ties the banner to settings changes.
17. **Bulk preview uses the stored check.** `POST /review-queue/assign-preview` runs the preflight with `fresh: false`, so it reuses a check under a day old and asks HubSpot only for accounts with none. Each account runs in its own savepoint, so a 503 for one is that account's row. The single `:assign-preview` stays fresh.
18. **Take-back reason.** `HandoffUndone` gains `cause {kind: 'declined'|'withdrawn', reason_label, by_name}` (jsonb, no migration). Undo records stored before this have no cause and keep today's wording. The copy:
    - declined: "Scout took the account back: {seller} declined it ({reason}). {what the undo did}."
    - withdrawn: "Scout took the account back: {by} withdrew the assignment. {what the undo did}."
19. **Saving review statuses is one request.** `PUT /api/v1/settings/review` accepts `{statuses?, reasons?, auto_accept_working_days?}` in one transaction. The statuses and reasons routes stay, but the editor uses only this one.

## Global Constraints

- Everything in the earlier plans' Global Constraints holds:
  - module boundaries (imports only through `index.ts` or `contracts/*`, the boundaries lint passes)
  - forced RLS on every table
  - `v1Route` with explicit permissions
  - problem+json with `errors[{path,message}]`
  - snake_case JSON and bounded bodies
  - POSTs idempotent, except key create and rotate, which keep `idempotent: false` because the response holds the secret
  - domain functions take `now`
  - an integration test per endpoint: success, permission refusal, validation error, and a cross-tenant or hidden 404
- Migrations, one per module that changes, after the module's latest:
  - intake `0004_source_owner.sql` (`owner_user_id`, backfilled per Ruling 3)
  - offers `0002_offer_content_practice_lead.sql`
  - nothing for crm (jsonb) or scoring
- `tests/integration/v1/route-access.test.ts` lists every new route with its permission.
- No number is computed in the browser (C8). That covers tiles, percentages, counts, totals, the derived status, the issue text, `price_label`, `win_rate`, `retryable` and `tier_changed_count`. Names, labels, statuses, reasons, stages, kinds and import targets come from the API (C6, C7).
- No sample data where there is no data (C9). Trust is "Not enough data yet".
- URL carries tabs, filters and what is open (C10). Polling per C14: the import Resolve step every 2 s while running, Batches every 30 s while any batch is `in_progress`.
- Copy is exactly as screens.md and this plan give it. No em dashes.
- Never touch `.env` or the dev `scout` database. Commit per task, `git add` specific paths, conventional messages with the Co-Authored-By line.

## Review Focus

1. **Remove vs Archive.**
   - A source that has sent cannot be removed: the API answers 409 and the UI offers only `Archive source`.
   - A removed source is gone from the list, the pickers and `GET /sources/{id}`.
   - An archived one is listed only under `status=archived` and its page is read only.
   - Both revoke the source's keys.

   Tests in Tasks 4 and 5.
2. **A key never leaks or outlives its source.**
   - The secret appears only in the create and rotate responses, and those are not idempotent-stored.
   - `GET` returns the prefix only.
   - Keys of another source are 404 under this source's path.
   - Rotate is one transaction, so a failed create leaves the old key working.

   Test in Task 4.
3. **The import credits the right source.** An operator with `sources:manage` imports into a list source: the batch chain is that list's chain, its accounts roll up to the person, and the mapping is saved under the list. A seller-like role sending `source_id` gets 403. Tests in Tasks 6 and 7.
4. **Offer delete is safe.**
   - An offer that ever matched, or that was ever a lead offer, gets 409.
   - A never-matched draft deletes along with its rules and links.
   - Approving needs `offers:manage` and the completeness check.
   - Unapprove publishes `offers.offer.changed`, so scoring rescores.

   Tests in Task 8.
5. **The review status save is atomic.** A bad reason in the same save leaves the statuses unchanged. Archiving a status moves its accounts to the first status. The queue's status names and the Send-back dialog's reasons change after the save, with no reload logic of their own. Tests in Task 10.
6. **No handles on screen.** After Task 1, `Edited by Zach`, the AE cards, `Assigned by`, the audit `who` and `Owned by` all show display names. Tests in Tasks 1 and 3.

## File Structure

```
src/modules/accounts/contracts/fact-labels.ts      factLabel(key) catalog
src/modules/accounts/services/source-stats.ts      stageCountsBySource
src/modules/tenancy/domain/display-name.ts         displayNameFromEmail
src/modules/tenancy/services/directory.ts          memberDirectory
src/modules/intake/services/{sources,source-read,batches-read,imports,retry}.ts
src/modules/intake/db/migrations/0004_source_owner.sql
src/modules/offers/services/{offers,practices,stats,delete}.ts  contracts/ports.ts (OfferUsage)
src/modules/offers/db/migrations/0002_offer_content_practice_lead.sql
src/modules/scoring/services/last-rescore.ts
src/modules/routing/services/{assign,queue}.ts      bulk preview, facets totals
src/modules/crm/services/{preflight,undo,activity,batches}.ts
src/modules/playbooks/services/best-offer.ts        bestOfferNames
src/http/routes/v1/sources/{stats/route.ts,[id]/route.ts,[id]/keys/[keyId]/route.ts}
src/http/routes/v1/members/directory/route.ts
src/http/routes/v1/review-queue/assign-preview/route.ts
src/http/routes/v1/scoring/last-rescore/route.ts
src/http/routes/v1/batches/[id]/{files/[fileId],rejections}/route.ts
src/http/routes/v1/offers/stats/route.ts
web-ui/src/features/sources/      SourcesScreen, SourceTree, SourcePage, SourceHeader, tabs/*, AddSourceDialog, api.ts
web-ui/src/features/batches/      BatchesScreen, BatchDetail, WaitingForms, import/{ImportScreen,UploadStep,SheetStep,MatchStep,ConfirmStep,ResolveStep}, api.ts
web-ui/src/features/offers/       OffersScreen, PracticeTree, PracticeView, OfferView, OfferForm, PracticeForm, api.ts
web-ui/src/features/settings/review-statuses/  ReviewStatusesTab, StatusTable, ReasonList, api.ts
tests/e2e/{sources-import,offers,review-statuses}.spec.ts
```

---

### Task 1: Names, not keys or handles (accounts, intake, tenancy, seed)

**Files:**
- Create: `src/modules/accounts/contracts/fact-labels.ts`, `src/modules/tenancy/domain/display-name.ts`, `tests/unit/accounts/fact-labels.test.ts`, `tests/unit/tenancy/display-name.test.ts`
- Modify:
  - `src/modules/accounts/index.ts`
  - `src/http/routes/v1/accounts/[id]/facts/route.ts`
  - `src/http/routes/v1/accounts/respond.ts` (signals)
  - `src/modules/tenancy/services/{members,tenants}.ts`
  - `src/modules/tenancy/index.ts`
  - `src/entry/seed.ts` (names, `backfillDisplayNames`)
  - `src/modules/intake/services/sources.ts` (`renamePersonSources`)
  - `tests/e2e/{account,review,settings}.spec.ts` (names)
- Test: `tests/integration/v1/account-page.test.ts`, `tests/integration/tenancy/members.test.ts`, `tests/unit/seed.test.ts`

**Interfaces:**
- `factLabel(key: string): string`. There is a label for every key in `FACT_KEYS`, for example `buying_process` gives "Buying process", `hq_city` "HQ city", `revenue_cents` "Revenue", `employees` "Employees", `website_url` "Website". A `form.<name>` key gives the name in sentence case. An unknown key gives the key with its underscores turned into spaces, in sentence case.
- `GET /api/v1/accounts/{id}/facts`: each fact gains `label`.
- `GET /api/v1/accounts/{id}`: each `signals[]` gains `source_name` (the nearest of vendor, agent, person, through intake `sourceNames`; null when none) and `source_names {person, agent, vendor}`, as facts have.
- `displayNameFromEmail(email): string` (Ruling 15). Seed `TENANTS` people take `name`:
  - `zach.wiant@taazaa.com` "Zach Wiant"
  - `ash@taazaa.com` "Ash"
  - `mike@taazaa.com` "Mike"
  - `andy@taazaa.com` "Andy"
  - `yasir@taazaa.com` "Yasir Drabu"
  - `owner@northwind.example` "Northwind Owner"
  - a new operator `riley@taazaa.com` "Riley", role `operator` (for the e2e in Task 7; see Decisions)
- `backfillDisplayNames()`: a user whose `name` equals their email's local part gets `displayNameFromEmail`. A person source whose name equals the old handle gets its person's name. It is safe to run again and runs from `seed()`.

- [ ] **Step 1: Write failing tests.**
  - Unit: `factLabel` covers every `FACT_KEYS` entry (none falls through to the fallback), the `form.` keys, and the fallback. `displayNameFromEmail` gives `zach.wiant` "Zach Wiant", `mary-jo_smith` "Mary Jo Smith", `ash` "Ash".
  - Integration: facts carry `label` "Buying process". A signal from the dev agent carries `source_name` "Local development agent", and a seller without `arrivals:read` gets it too.
  - `addMember` for `new.person@x.com` stores "New Person".
  - The seed test: after `seed()`, the members' names are display names and the person sources are named "Zach Wiant" and so on.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Update the e2e matchers: `/^ash/i` becomes `/^Ash/`, and audit `zach.wiant` becomes `Zach Wiant`.
- [ ] **Step 4:** Run `tests/unit`, `tests/integration/v1`, `tests/integration/tenancy`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): fact labels, signal source names, and display names instead of handles`.

### Task 2: Queue, assign and CRM gaps (routing, crm, scoring, playbooks)

**Files:**
- Create:
  - `src/http/routes/v1/review-queue/assign-preview/route.ts`
  - `src/modules/scoring/services/last-rescore.ts`
  - `src/http/routes/v1/scoring/last-rescore/route.ts`
  - `src/modules/playbooks/services/best-offer.ts`
- Modify:
  - `src/modules/routing/contracts/ports.ts` (`OwnershipPreflightResult` details)
  - `src/modules/routing/services/{assign,queue}.ts`
  - `src/modules/crm/services/{preflight,undo,activity,batches}.ts`
  - `src/modules/crm/contracts/{ports,types}.ts` (`HandoffPackageProvider.bestOfferNames`, `HandoffUndone.cause`)
  - `src/modules/crm/domain/*` (the activity wording)
  - `src/modules/playbooks/index.ts`
  - `src/entry/compose.ts`
  - `src/http/routes/v1/accounts/[id]/route.ts` (`:assign-preview` body)
  - `src/http/routes.ts`
  - `src/modules/scoring/index.ts`
  - `docs/spec/web-ui/api-gaps.md` (rows to READY)
- Test: `tests/integration/v1/{review-actions,review-reads,scoring,crm}.test.ts`, `tests/integration/crm/{undo,batches}.test.ts`, `tests/unit/crm/activity.test.ts`

**Interfaces:**
- `POST /api/v1/accounts/{id}:assign-preview` and each bulk row:
  - `preflight`: `{ result, message, reason: 'open_deal'|'customer'|'owned_elsewhere'|'no_owner'|null, current_owner_name, deal: { name, amount_cents, currency, last_activity_at } | null }`
  - `deal` is the stored top open deal from `crm.company_check`, and only when `reason` is `open_deal`
  - the routing port carries these optional fields through; `compose.ts` checks the shape
- `POST /api/v1/review-queue/assign-preview` (`assign:act`, people only) takes `{ account_ids: string[1..50], seller_user_id }` and returns `{ data: [ { account_id, ok: true, preflight, approves_to, replaces } | { account_id, ok: false, status, message } ] }` in the order asked. It uses the stored check (Ruling 17). An account that is hidden or missing gets `ok:false, status:404`.
- `GET /api/v1/review-queue/facets` adds:
  - `total_all_tiers`: the total with every filter but `tier`
  - `source_count`: the number of distinct sources with an account in the filtered queue, every filter but `source_id` applied
- `GET /api/v1/scoring/last-rescore` (`review:act`) returns `{ data: { version, changed_at, changed_by_name, summary: "Scoring settings changed", weights_text: "Fit {f}, buying intent {i}", tier_changed_count } | null }`. The data is null when the profile was never changed or changed more than 7 days ago (Ruling 16). `tier_changed_count` counts distinct accounts with a `rules_changed` score change since `changed_at` whose `from_tier` differs from `to_tier`.
- `HandoffPackageProvider.bestOfferNames(ctx, accountIds): Promise<Map<string, string | null>>`. Playbooks implements it as the lead offer override, else the scored best offer, with the names from offers, in one read per call, with no brief and no package. `refreshBatch` uses it instead of `package(...)`.
- `HandoffUndone.cause` and the activity copy per Ruling 18.

- [ ] **Step 1: Write failing tests.**
  - Preview on `open-deal.example` returns `reason: 'open_deal'`, `current_owner_name` "Vijay Kumar" and `deal.name` "Open Deal renewal" with `amount_cents` 5,000,000.
  - A `customer` stop has `deal: null`.
  - Bulk preview: 3 accounts, one of them the other tenant's, gives `ok:false, 404` for that one. It makes zero HubSpot calls for accounts checked within a day (count the mock's calls). It refuses 51 ids with 400 and a key with 403.
  - Facets with `tier=act_now`: `total` counts only Act now, and `total_all_tiers` counts all of them. `source_count` is 2 with accounts from two sources.
  - `last-rescore`: null before any change. After `PUT /scoring/profile` as Zach and a run of the rescore jobs it gives "Zach Wiant", the weights text, and a `tier_changed_count` that matches the moved accounts. It is null after 8 days (fake `now`). A seller gets 403.
  - Weekly batch refresh: the package provider is never called (spy), and the message names the lead offer.
  - Decline undo: `undone.cause` is `{kind:'declined', reason_label:'Not my territory', by_name:'Ash'}`, and the activity row starts "Scout took the account back: Ash declined it (Not my territory)." followed by today's description of what the undo did. A withdrawal reads "Scout took the account back: Zach Wiant withdrew the assignment. …". An older undo row with no cause keeps today's wording.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Register `review-queue/assign-preview` before `review-queue/:x` siblings if any, and `scoring/last-rescore` next to `scoring/profile`.
- [ ] **Step 4:** Run `tests/integration/v1`, `tests/integration/{routing,crm,scoring,playbooks}`, `tests/unit`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): ownership warning details, bulk assign preview, one-call queue totals, rescore read, light best offer, take-back reason`.

### Task 3: Polish in the app (web-ui)

**Files:**
- Modify:
  - `web-ui/src/features/review/{QueueScreen,AssignDialog,api}.tsx|ts`
  - `web-ui/src/features/account/{ReviewView,AssignedView,api}.tsx|ts`
  - `web-ui/src/features/review/testing.ts`, `web-ui/src/features/account/testing.ts`
- Create: `web-ui/src/features/review/RescoreBanner.tsx`
- Test: `web-ui/src/features/review/{queue,assign}.test.tsx`, `web-ui/src/features/account/{account-page,assigned}.test.tsx`

**Interfaces:**
- **Queue:**
  - The "All" tab count is `total_all_tiers` from the one facets call; the second facets call goes.
  - The loading line is "Loading accounts from {n} sources" once facets have `source_count` (n > 0), "Loading accounts" before that, and "Loading accounts from 1 source" for one.
  - `RescoreBanner` above the table when `last-rescore` has data: "{summary} · {when} by {name}" and "Priorities were recalculated with {weights_text}. {n} accounts changed tier." ("1 account changed tier."; while `tier_changed_count` is 0: "Priorities were recalculated with {weights_text}."). It has a dismiss `IconButton` "Dismiss" (Ruling 16) and no `Open settings` (hidden tab).
- **Assign dialog:**
  - Bulk: one `POST /review-queue/assign-preview` instead of one preview per account.
  - Single: as now.
  - The warning title is "Scout can't take over the HubSpot owner". The body depends on `reason`:
    - `open_deal`: "{owner} owns an open deal on this company: {deal}, {amount}, last activity {Mon D}. Scout will send the account and leave {owner first name} as owner. Ask {owner first name} to hand it over if {AE first name} should lead."
    - `customer`: "{owner} owns this company and it is a customer in HubSpot. Scout will send …" (same tail)
    - `owned_elsewhere`: "{owner} owns this company in HubSpot. Scout will send …" (same tail)
  - With no `deal.amount_cents` the amount is left out. The amount is formatted in `deal.currency`.
  - The footer with a warning is "Scout sends {account} to HubSpot and leaves {owner} as owner.".
  - In bulk the warning lists "{account}: {owner}, {deal or reason words}" per stopped account.
- **Account page:**
  - Account facts show `label`.
  - Why now links show `source_name`, or the host when `source_name` is null.
  - The activity row shows the API's summary as it is (the reason now comes from the API).

- [ ] **Step 1: Write failing tests (MSW).**
  - The All tab count comes from `total_all_tiers`, with exactly one facets request per render (count the handler calls).
  - The loading line wording for n of 0, 1 and 3.
  - The banner shows with data, hides with null, and stays hidden after Dismiss and a reload for the same version (localStorage) but shows for a new version.
  - The bulk Assign makes one preview request for 5 accounts, and lists the stopped accounts with names.
  - The open-deal warning reads "Vijay Kumar owns an open deal on this company: Open Deal renewal, $50,000, last activity …".
  - The customer and owned-elsewhere variants.
  - The facts label "Buying process".
  - The Why now link text is the source name.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run web-ui `npm test`, `npm run typecheck`, `npm run lint`. Root `npm run e2e -- review.spec.ts account.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): queue totals and loading line, rescore banner, full ownership warning, fact labels and source names`.

### Task 4: Sources backend (intake, accounts, tenancy)

**Files:**
- Create:
  - `src/modules/intake/db/migrations/0004_source_owner.sql`
  - `src/modules/intake/services/source-read.ts`
  - `src/modules/accounts/services/source-stats.ts`
  - `src/modules/tenancy/services/directory.ts`
  - `src/http/routes/v1/sources/stats/route.ts`
  - `src/http/routes/v1/sources/[id]/keys/[keyId]/route.ts`
  - `src/http/routes/v1/members/directory/route.ts`
- Modify:
  - `src/modules/intake/{db/schema.ts,services/sources.ts,services/feedback.ts,index.ts}`
  - `src/modules/intake/services/qualified-leads.ts` (expose the poll cursor and last error, enqueue on demand)
  - `src/modules/accounts/index.ts`, `src/modules/tenancy/{services/api-keys.ts,index.ts}`
  - `src/http/routes/v1/sources/{route.ts,[id]/route.ts,[id]/keys/route.ts}`
  - `src/http/routes/v1/feedback/route.ts`
  - `src/http/routes/v1/accounts/route.ts` (`first_arrival`)
  - `src/http/routes.ts` (`sources/stats` and `members/directory` before their `:id` routes)
  - `docs/spec/web-ui/api-gaps.md` (intake, accounts and tenancy rows to READY)
- Test: `tests/integration/v1/{sources,api-keys,members,feedback,accounts,route-access}.test.ts`, `tests/integration/intake/sources.test.ts`, `tests/integration/accounts/source-stats.test.ts`

**Interfaces:**
- Source view, on list and read:

  ```
  { id, name, kind, kind_label, status, status_label, parent_id, parent: {id,name,kind}|null,
    owner: {user_id,name}|null, method, method_label, active_key: {id,prefix,last_used_at,created_at}|null,
    created_at, last_sent_at, has_sent, arrivals_last_30_days, trust: null, trust_label: "Not enough data yet",
    children_count, is_new, can_remove, can_archive }
  ```

  - `kind_label`: "Person", "Agent", "Data vendor", "List", "Partner", "CRM", "Web form", "Scheduled pull"
  - `status_label`: "Active", "Paused", "Archived"
  - `can_remove` is `!has_sent && children_count === 0 && status !== 'archived'`; `can_archive` is `has_sent && children_count === 0 && status !== 'archived'`
- `GET /api/v1/sources` (`arrivals:read`): query `kind` (repeatable), `status` (`active,paused` by default, or `archived`), `q` (name). It stays in tree order. `meta: { counts_by_kind: {person:n,...}, can_add_crm }`.
- `GET /api/v1/sources/{id}` (`sources:manage`) adds:
  - `breadcrumb: [{id,name}]`, root first
  - `daily_arrival_cap`, `initial_review_status_key`
  - `sync: { last_polled_at, last_error, connected } | null`, for `crm` only

  A removed source, one outside `visibleSourceIds`, or another tenant's is a 404.
- `POST /api/v1/sources` (`sources:manage`):
  - kind `list` (Ruling 1)
  - `owner_user_id?`
  - `create_key?: boolean` (agent, partner): the 201 adds `api_key: {id, prefix, secret, environment, created_at}` once
  - name errors with `errors[{path:"name"}]`: empty name "Give the source a name so its batches can be traced back to it."; duplicate (case-insensitive, among sources that are not removed) 409 `conflict` "A source called {name} already exists. Pick another name."
  - a second `crm` source: 409 (Ruling 5)
  - `POST /sources` is not idempotent-stored when `create_key` is true
- `PATCH /api/v1/sources/{id}` adds `owner_user_id` and the same duplicate-name check. Archive is guarded by children (Ruling 2).
- `DELETE /api/v1/sources/{id}` (`sources:manage`, people only): 204, or 409 `source-has-sent` or `source-has-children`.
- `POST /api/v1/sources/{id}:sync` (`sources:manage`, people only): 202 `{queued:true}`. It enqueues the qualified-leads poll. When the source is not `crm` the answer is 400 "Only the HubSpot source syncs."; when HubSpot is not connected, 409 "Connect HubSpot first".
- `GET /api/v1/sources/stats` (`sources:manage`) returns `{ data: [{ source_id, sent, reviewed, assigned, won, reviewed_pct, assigned_pct, won_pct, by_stage: [{ key, label, count }], is_new }] }` (`by_stage` has every stage in the API's order with routing's labels), from accounts `stageCountsBySource(ctx)` under `visibleAccounts`, with children rolled up (Ruling 4).
- Keys under a source:
  - `POST /api/v1/sources/{id}/keys/{key_id}:rotate` (`sources:manage`, people only, not idempotent) returns 201 `{id, prefix, secret, environment, created_at}`
  - `DELETE /api/v1/sources/{id}/keys/{key_id}` returns 204
  - both are audited as `tenancy.api_key.rotated` and `tenancy.api_key.revoked`
- `GET /api/v1/members/directory` (any of `sources:manage`, `imports:run`, `assign:act`, `members:read`) returns `{ data: [{ user_id, name }] }`, active members by name.
- `GET /api/v1/feedback?source_id=` (`sources:manage` when `source_id` is given; checks visibility; covers the source and its children). Rows add `summary`:
  - "Sent back by {name}: {reason}"
  - "Not pursued at review: {reason}"
  - "Declined by {seller}: {reason}"
  - "Lost a conflict to {source}"
  - "Enrichment declined"

  Rows also add `account_name` and `by_name`.
- `GET /api/v1/accounts?source_id=` rows add `first_arrival: { at, batch_id, batch_name, source_id, source_name }`, the earliest arrival through this source or its children, from a new intake read `firstArrivals(ctx, accountIds, sourceId)`.

- [ ] **Step 1: Write failing tests.** Every endpoint gets success, 403, 400 and a cross-tenant 404. Plus:
  - the migration backfills `owner_user_id` for the seeded person sources and the dev agent
  - a list under a person source rolls up: the person's stats count the list's accounts
  - `has_sent` is false for a new list; `DELETE` gives 204, then `GET /sources/{id}` is 404 and the list leaves it out
  - after an arrival credits it, `DELETE` is 409 and `PATCH archived` is OK; `GET /sources` hides it, `?status=archived` shows it, and its keys fail auth
  - a duplicate name is 409 with `errors[0].path` `name`
  - `create_key` returns the secret once, and a replay with the same Idempotency-Key does not return it again
  - rotate: the old key fails within the cache window on this instance, the new one works, and a key of another source is 404
  - `:sync` with HubSpot not connected is 409
  - an operator (no `members:read`) reads the directory
  - `first_arrival` names the batch and the child source
  - `feedback?source_id` as an operator lists the sent-back row with its reason label
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/integration`, `tests/unit` (the boundaries test included). Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): source read, stats, owner, list kind, remove vs archive, sync, source keys and member directory`.

### Task 5: Sources, Source page and Add a source (web-ui)

**Files:**
- Create:
  - `web-ui/src/features/sources/{SourcesScreen,SourceTree,SourcePage,SourceHeader,StatTiles,AddSourceDialog,KeyReveal,api}.tsx|ts`
  - `web-ui/src/features/sources/tabs/{OverviewTab,AccountsTab,BatchesTab,ChildrenTab,SettingsTab}.tsx`
  - `web-ui/src/features/sources/Sources.module.css`, `sources/testing.ts`
  - tests `sources/{sources,source-page,add-source}.test.tsx`
- Modify: `web-ui/src/routes/workspace.tsx` (`sources`, `sources/$id`, `sources/$id/$tab`), `web-ui/src/routes/screens.ts`, `web-ui/src/test/server.ts`
- Note: `BatchesTab` renders the shared `BatchesTable` from Task 7 when that is merged. Before then it reuses `GET /batches?source_id=` with a plain table, swapped in Task 7.

**Interfaces:**
- **§10 Sources** (`/t/:tenant/sources?kind=&q=`):
  - Title and sub as in screens.md.
  - `Add a source` (with `sources:manage`).
  - Search "Find a source", 300 ms, in the URL.
  - The Filter popover's Type options are the API's `counts_by_kind` with `kind_label`. There is no Trust filter.
  - `Expand all`, `Collapse all`.
  - Tree table with the columns:
    - Source: caret, name, `kind_label`, a "New" or "Paused" tag
    - How it sends: `method_label`
    - Trust: `trust_label`
    - Sent, Reviewed, Assigned, Won (from stats, right-aligned)
    - Last sent: relative
  - Rows open the Source page.
  - Empty "No sources match. Clear the filters, or add a source." Plus loading ("Loading sources") and error states.
- **§11 Source page** (`/t/:tenant/sources/:id/:tab?`; tabs `overview` (default), `accounts`, `batches`, `runs`|`pulls-from`, `settings`):
  - Breadcrumb from `breadcrumb`.
  - Header: initials tile, name, `kind_label`, status pill, and "Owned by {owner} · {method_label} · Part of {parent} · Last sent {when}", where a missing part is left out and "No owner" shows when there is none.
  - `Pause` / `Resume`, toasts "{name} paused. Anything it sends is refused until you resume it." / "{name} resumed. New accounts will reach review again.".
  - Primary `Import a list` (list) goes to `/batches/import?source={id}`. `Sync now` (crm), toast "Sync started.".
  - `See in funnel` is not rendered (R3).
  - Tiles: Sent, Reviewed (`{reviewed_pct}% of sent`), Assigned (`% of reviewed`), Won (`% of assigned`), Trust "Not enough data yet". There is no Cost per win tile (R3), as C9 allows.
  - **Overview:**
    - "Where its accounts went" bars from the stats' `by_stage` (labels and order from the API).
    - "Recent activity" from `feedback?source_id`, with the empty state "Nothing sent back or declined yet.".
    - Details: owner, how it sends, last sent, part of, runs or pulls from.
    - There is no Trust card (R3).
  - **Accounts ({n}):** `GET /accounts?source_id=` with search and Filter Stage and Tier; the columns Account, Stage, Tier, Priority, Best offer, Came in through (`first_arrival.batch_name` · `source_name`), Owner, Arrived; the empty state as screens.md.
  - **Batches ({n}):** the batches table filtered to the source.
  - **Runs** (person) / **Pulls from** (agent): child rows with How it sends, Trust, Sent, Assigned, Won. The tab is hidden when there are no children.
  - **Settings:**
    - Owner select from `members/directory`, with the help "Answers for what this source sends." and the toast "{owner} now owns {source}.". "No owner" is an option.
    - Connection by method. For an API key: the source's keys (name, `{prefix}…`, created, last used), `Rotate key` (confirm "Rotate {key}?" / "The old key stops working within a minute.", then `KeyReveal` "Copy this now. You won't see it again." with `Copy`), `Revoke key` (confirm "Revoke {key}?" / "Calls with it fail from now on.", toast "{name} revoked. Calls with it now fail."), and `Create a key` when there is none. For a list: `Import a list`. For crm: `Sync now`, "Last synced {when}", the last error, and "Connect HubSpot first" with a link to Settings > Integrations for `integrations:manage`. `Open {parent}` when there is a parent.
    - Pause or remove: `Pause` / `Resume`. `Remove source` when `can_remove` (confirm "Remove {source}?" / "It has sent nothing, so nothing else changes.", toast "{source} removed.", then go to Sources). `Archive source` when `can_archive` (confirm "Archive {source}?" / "It stops sending for good and its keys stop working. Its accounts and history stay.", toast "{source} archived."). With children: "Remove or archive the sources under {name} first." and no button.
  - An archived source is read only: no Pause, no Settings actions, and a status pill "Archived".
- **§12 Add a source**, a three-step `Dialog`:
  1. "Add a source / Pick what kind of source this is. You can change the details later." Cards Agent, Data vendor, Partner, List or research sheet, and CRM (only when `can_add_crm`), with the screens.md descriptions. `Continue`.
  2. "Add a {type}":
     - Name, with the API errors at `name`.
     - Under (a person-source select, required for an agent and a list): "An agent needs an owner. Pick the person who runs it." / "A list needs an owner. Pick the person who uploads it.".
     - Owner, which defaults to the person under it.
     - How accounts arrive: Send through the API (agent, partner; sends `create_key:true`), Upload files (list), Sync from HubSpot (crm), with the screens.md copy.
     - The note "Not enough data yet" on trust.
     - "Shows under {parent}".
     - `Back`, `Add source`, toast "Added {name}.".
  3. "Source added":
     - API: the key, once, with a sample `curl` against `location.origin` + `/api/v1/arrivals`.
     - List: `Upload the first list` (to the import with `source`).
     - CRM: `Run the first sync`.
     - Anything else: `Done`.

- [ ] **Step 1: Write failing tests (MSW).**
  - The tree order and the expand and collapse.
  - The Type filter counts come from meta.
  - Trust always reads "Not enough data yet".
  - An archived source is hidden.
  - The header line with and without an owner.
  - Pause and Resume toasts.
  - The tiles use the API's percentages (the test feeds numbers the browser could not derive, for example `reviewed_pct: 33` with `sent: 2`).
  - The Accounts tab "Came in through".
  - The Settings owner change toast.
  - Rotate shows the secret once and the confirm copy.
  - Revoke toast.
  - Remove shown only with `can_remove`, Archive only with `can_archive`, and a 409 shows the API title.
  - Wizard: an agent without Under shows the error; a duplicate name 409 shows under Name; the API path shows the key and the sample request; a list leads to `Upload the first list`; the CRM card is hidden when `can_add_crm` is false.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run web-ui `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): Sources, the Source page with its tabs and Settings, and Add a source`.

### Task 6: Batches and imports backend (intake)

**Files:**
- Create:
  - `src/modules/intake/services/{batches-read,retry}.ts`
  - `src/http/routes/v1/batches/[id]/files/[fileId]/route.ts`
  - `src/http/routes/v1/batches/[id]/rejections/route.ts`
- Modify:
  - `src/modules/intake/services/{status,imports,files,mappings}.ts`
  - `src/modules/intake/import/synonyms.ts` (target labels)
  - `src/modules/intake/index.ts`
  - `src/http/routes/v1/batches/{route.ts,[id]/route.ts,[id]/items/route.ts}`
  - `src/http/routes/v1/imports/{route.ts,[id]/route.ts}`
  - `src/http/routes/v1/_lib/intake.ts` (upload fields)
  - `src/http/routes.ts`
  - `docs/spec/web-ui/api-gaps.md`
- Test: `tests/integration/v1/{batches,imports,route-access}.test.ts`, `tests/integration/intake/{retry,imports}.test.ts`, `tests/unit/intake/batch-status.test.ts`

**Interfaces:**
- Batch row, on list and detail:

  ```
  { id, name, notes, run_at, completed_at, status, status_key: complete|in_progress|needs_attention|failed,
    status_label, issue, item_count, stages: {received,resolving,waiting,resolved,rejected},
    progress_label: "{n} resolved, {n} rejected, {n} waiting", counts, source: {id,name,kind}|null,
    sent_by: {kind: user|api_key, id, name}, files: [{id, file_name, size_bytes, content_type}],
    import: {id, status, error}|null, retryable }
  ```

  `status_key`, `issue` and `retryable` follow Ruling 8. `source` is the closest source in the chain. `sent_by.name` is the member's name, or the key's name.
- `GET /api/v1/batches` adds the filters `status_key` (repeatable), `source_id` (any chain column), `sent_by` (user id), `since` (ISO date), and `q` (over batch name, notes and file name). The response adds `total` and `meta: { counts_by_status: {complete,in_progress,needs_attention,failed}, attention: { count, issues: [string] (first 3) } }`.
- `GET /api/v1/batches/{id}`: the same row plus today's `counts_by_stage`, `rejections`, and `in_queue: n | null` (the review-queue count for the batch, only with `review:act`).
- `GET /api/v1/batches/{id}/items?status=all|waiting|resolved|rejected` adds `total`. Each item adds `company_name`, `website`, `account_id`, `account_name`, `priority`, `tier`, `tier_label`, `review_status_label`, `stage`, `outcome`, `outcome_label`, `waiting_on`, and `duplicate_candidates [{account_id,name,domain}]` (visible ones only). Fields the caller may not see are null, as `getSummaries` does.
- `GET /api/v1/batches/{id}/files/{file_id}` (`arrivals:read`) streams the original with `Content-Disposition: attachment; filename="{file_name}"`. A file of another batch is a 404.
- `GET /api/v1/batches/{id}/rejections?format=csv` (`arrivals:read`) gives `text/csv` with the columns `row,company,website,reason,detail` and the filename `{batch id}-rejected.csv`. Contact columns are left out without `people:read`.
- `POST /api/v1/batches/{id}:retry` (`imports:run`, people only) returns 202 `{ retried: n }`. It resubmits the retryable rows through `storeItems` as new arrivals in the same batch and marks the old ones `superseded_by`. When there is nothing to retry, 409 "Nothing in this batch can be retried.".
- `POST /api/v1/imports` takes the multipart fields `source_id` (Ruling 10), `notes` (up to 1,000 characters) and `name` (up to 200; defaults to the file name). The 202 and `GET /api/v1/imports/{id}` add:
  - `sample_rows` (the first 5, as strings; contact columns blanked without `people:read`)
  - `targets: [{key, label}]`: "Company name", "Website", "Location", "Person name", "Job title", "Email", "Phone", "Notes", "Don't import" (`key: null`), plus the rest of the allowed targets with labels
  - `file: {name, type: CSV|Excel|Markdown, size_bytes, sheet}`
  - `uploaded_by: {user_id, name}`
  - `source: {id, name, kind}`
  - `notes`
  - `mapping_origin`
  - `suggested_count`: columns with `confidence >= MIN_CONFIDENCE`
- `POST /api/v1/imports/{id}:preview` adds `without_website` (rows with no website or domain mapped value) and `go_ahead` (rows that go now).
- `DELETE /api/v1/imports/{id}` (`imports:run`, people only): 204 while `needs_confirm`, else 409 "This import has started, so it can't be discarded." (Ruling 11).
- `POST /api/v1/batches` accepts `notes`.

- [ ] **Step 1: Write failing tests.**
  - Unit: `batchStatus` for each of the four keys and its `issue` text.
  - Integration:
    - The list filters each narrow, and `total` matches.
    - `counts_by_status` and `attention`.
    - An operator importing with `source_id` of a list puts the batch chain on that list and the person. The mapping is saved under the list, so a second upload with the same headers is `saved` and `queued`.
    - A seller-like key sending `source_id` gets 403.
    - Imports with a paused credited source refuse as today.
    - `sample_rows` and `targets` labels; `without_website` is 2 for a file with two blank websites.
    - `DELETE` while `needs_confirm` is 204, and the batch is gone from the list. After confirm it is 409.
    - Items `status=waiting` returns only waiting rows with `outcome_label` "Waiting: Needs a website", and a resolved one "Resolved: New account".
    - The file download bytes equal the upload, and another batch's file id is 404.
    - The rejections CSV header and a row.
    - `:retry` after a `daily_cap_reached` rejection (cap 1, three rows) gives `retried: 2`, and the retried rows are waiting again or resolved the next tenant day (fake `now`).
    - 403 and 404 for each endpoint.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/integration`, `tests/unit`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): batch filters and derived status, batch items, file download, rejections CSV, retry, import source and column-match read`.

### Task 7: Batches, Batch detail and Import a list (web-ui) and the operator e2e

**Files:**
- Create:
  - `web-ui/src/features/batches/{BatchesScreen,BatchesTable,BatchDetail,WaitingForms,api}.tsx|ts`
  - `web-ui/src/features/batches/import/{ImportScreen,UploadStep,SheetStep,MatchStep,ConfirmStep,ResolveStep}.tsx`
  - `web-ui/src/features/batches/Batches.module.css`, `batches/testing.ts`
  - tests `batches/{batches,batch-detail,import}.test.tsx`
  - `tests/e2e/sources-import.spec.ts`, `tests/e2e/fixtures/list.csv`
- Modify: `web-ui/src/routes/workspace.tsx` (`batches`, `batches/import`, `batches/$id`), `web-ui/src/features/sources/tabs/BatchesTab.tsx` (shared table), `web-ui/src/routes/screens.ts`

**Interfaces:**
- **§13** (`/t/:tenant/batches?status=&source=&sentBy=&runDate=&q=`):
  - Tabs `Batches ({total})` and `Import a list` (with `imports:run`).
  - The attention banner "{n} batches need attention", the API's issues, and `Show them` (sets `status=needs_attention,failed`).
  - Search "Find by batch, file or notes".
  - Filter: Status (with the API counts), Source (from `GET /sources`), Sent by (from `members/directory`), Run date (Last 7, 14 or 30 days, sent as `since`).
  - Columns:
    - Batch (id)
    - Status chip (`status_label`)
    - Sent by (source name · person)
    - Run date
    - Accounts (`item_count`)
    - Notes and files (notes, file name, `issue`, action)
    - Progress (a stacked bar from `stages` and `progress_label`)
  - Row actions:
    - `Retry {retryable} rows` when `retryable > 0`, toast "Retrying {n} rows in {id}. They're waiting again."
    - `Download error report` when rejected > 0
  - Empty and filtered-empty copy as screens.md, with `Clear filters`.
  - The list polls every 30 s while any row is `in_progress`.
- **§14** (`/t/:tenant/batches/:id?tab=all|waiting|resolved|rejected`):
  - Breadcrumb Batches / {id}.
  - The title is the notes, else the name. The sub is "{source} · {person} · Run {date} · {file}".
  - `Download file` (the first file).
  - Summary "{n} resolved", "{n} rejected", "{n} waiting on you", and "{in_queue} in the review queue" with `review:act`.
  - Tabs with counts from `stages`.
  - Columns Account (a link when visible), Website, Status (`outcome_label`), Priority.
  - The waiting forms by `waiting_on`:
    - Needs a website: "Add a website, like example.org", `Resolve`. Empty: "Add a website first, like {name}.org".
    - Needs a company: company name, optional website, or the checkbox "This is a sole proprietor" with the person's name; `Resolve`.
    - Possible duplicate: candidates, each with `Same company`, and `It's a new company`.
  - Toast "{name} resolved.". The footnote "Rows still waiting after 30 days are rejected.".
  - `Skip the waiting rows` (confirm "Skip {n} waiting rows?" / "They're rejected and won't reach review.", toast "Skipped {n} rows.") with `imports:run`.
  - API errors are shown inline under the row's form.
- **§15** (`/t/:tenant/batches/import?step=upload|sheet|match|confirm|resolve&import=&source=`):
  - **Upload:**
    - A dropzone with the screens.md copy and a keyboard-operable "choose a file" button.
    - Source: a select for `sources:manage` (person, partner and list sources, preselected from `?source=`), else the person's own source read only.
    - Batch notes.
    - `Upload`.
  - **Sheet** (for `needs_sheet`): "Pick the sheet to import", one row per sheet.
  - **Match:**
    - The file card "{type} {file}, {n} rows · {sheet} · uploaded by {person}".
    - `Use a different file` (`DELETE /imports/{id}`, back to Upload).
    - "Match your columns / Scout suggested {suggested_count} of {headers}. Check them, then confirm."
    - A table of Your column, Sample values (the first 3), and Scout field (a select from `targets`), with the tags "Suggested", "No match. Check this one", "Changed by you".
    - `Continue`.
  - **Confirm:** `:preview` with the callout "{n} rows have no website / They'll be held in the batch until you add one. The other {m} rows go ahead now. You can add websites here or later from the batch." (for one row: "1 row has no website", "It'll be held …"; with none, no callout). `Back`, and `Import {m} rows and hold {n}` (`Import {m} rows` when n is 0) runs `:confirm`. A 400 mapping error shows its title above the table.
  - **Resolve:** it polls `GET /imports/{id}` and `GET /batches/{batch_id}` every 2 s until the import is `imported` or `failed` and the batch is not `in_progress`. It shows:
    - "Batch {id} created"
    - "Matching companies and checking for duplicates"
    - then "Done. {resolved} accounts resolved. {waiting} rows need you."
    - "{in_queue} are in the review queue." with `review:act`
    - "{notes} · {n} accounts"
    - the progress line
    - `Open the {k} waiting rows` (Batch detail `tab=waiting`)
    - `Go to review queue` with `review:act`

    Research and Vibe layouts (`queued` at upload) jump from Upload to Resolve.
  - Errors show the API title with what to change, for example "This file has more than 10,000 rows. Split it and import the parts.", and the 413 copy "This file is over 20 MB. Split it and import the parts.".
- **e2e `sources-import.spec.ts`**, "an operator adds a list source, imports a list into it and resolves a waiting row":
  - sign in as `riley@taazaa.com`
  - Sources, `Add a source`, List or research sheet, name `E2E list {timestamp}`, Under `Riley`, `Add source`: toast `Added …`, then `Upload the first list`
  - Upload `fixtures/list.csv` (4 rows; two without a website), notes `E2E import`, `Upload`
  - Match: Company and Website are suggested, `Continue`
  - Confirm: "2 rows have no website", `Import 2 rows and hold 2`
  - Resolve: wait for `Done.` and "2 rows need you.", then `Open the 2 waiting rows`
  - Add `{name}.example` to the first and `Resolve`: toast `{name} resolved.`; the Waiting tab count is 1
  - Back on the source page: the Batches tab lists the batch, and Sent is at least 3 after the worker runs (poll)

- [ ] **Step 1: Write failing tests (MSW)** for every line above, plus the e2e. The MSW tests cover:
  - the filters in the URL and `Show them`
  - Retry shown only with `retryable`
  - the error report downloads a blob
  - the detail tab counts and each waiting form, the empty-website error, and the duplicate choice
  - import: the sheet step, the source select for `sources:manage` vs read only, `Use a different file` calling DELETE, the "Changed by you" tag, the singular and zero confirm copy, Resolve polling stops at done, layout skip, and the 413 copy
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run web-ui `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and root `npm run e2e -- sources-import.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): Batches, Batch detail and Import a list, with the operator e2e`.

### Task 8: Offers and practices backend (offers, scoring, routing)

**Files:**
- Create:
  - `src/modules/offers/db/migrations/0002_offer_content_practice_lead.sql`
  - `src/modules/offers/services/{stats,delete}.ts`
  - `src/modules/offers/contracts/ports.ts` (`OfferUsage`)
  - `src/http/routes/v1/offers/stats/route.ts`
- Modify:
  - `src/modules/offers/{db/schema.ts,services/offers.ts,services/practices.ts,index.ts}`
  - `src/modules/scoring/index.ts` and `src/modules/routing/index.ts` (the `OfferUsage` parts)
  - `src/entry/compose.ts`
  - `src/http/routes/v1/offers/{schemas.ts,[id]/route.ts}`
  - `src/http/routes/v1/practices/{schemas.ts,route.ts,[id]/route.ts}`
  - `src/http/routes.ts` (`offers/stats` before `offers/:id`)
  - `docs/spec/web-ui/api-gaps.md`
- Test: `tests/integration/v1/{offers,route-access}.test.ts`, `tests/integration/offers/{lifecycle,delete,stats}.test.ts`

**Interfaces:**
- Offer read, list, create and patch add `price_model`, `length_weeks`, `key_offer`, `why_us`, `why_now` (Ruling 13), and the read adds `price_label`, `status_label` ("Active", "Draft", "Retired"), `practice_lead_name`, `can_delete` (from `OfferUsage`).
- `POST /api/v1/offers/{id}:approve` (`offers:manage`, people only); `POST /api/v1/offers/{id}:unapprove` (`offers:manage`, people only) returns the offer; `DELETE /api/v1/offers/{id}` (`offers:manage`, people only) returns 204, or 409 `offer-has-history` (Ruling 12).
- `GET /api/v1/offers/stats?practice_id=` (`offers:read`, data-limited) returns `{ data: [{ offer_id, practice_id, matched, won, win_rate }] }` (Ruling 14).
- Practices:
  - `lead_user_id` (a member, 400 otherwise) in create and patch
  - the read and list add `lead_name` and `offer_count` (non-archived offers)
  - `GET /api/v1/practices/{id}` (`offers:read`)
  - the `:archive` 409 copy becomes "Retire or move its active offers first."

- [ ] **Step 1: Write failing tests.**
  - Create and patch round-trip the five new fields. `length_weeks` 0 is 400 at `length_weeks`. Editing `why_us` on an active offer keeps it active, but editing `industries` moves it to draft with the warning.
  - `price_label` for each model.
  - An operator (holds `offers:manage`) approves a complete draft. An incomplete one is 400 `offer-incomplete` with `errors[]`. A key is 403.
  - Unapprove: active becomes draft, `offers.offer.changed` is published (outbox row), and an archived offer is 409.
  - Delete:
    - a fresh draft gives 204, and its signal rules and case-study links are gone
    - an offer with an `offer_match` gives 409
    - an offer that was a lead offer once (and has no match now) gives 409
    - another tenant's offer gives 404
  - Stats: matched and won for a seeded set; `win_rate` null at 0; a seller with a practice data limit sees only their accounts.
  - Practice lead: `lead_name`, `offer_count`, and `GET /practices/{id}` with a 404 cross-tenant.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/integration`, `tests/unit`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): offer content fields, approve and unapprove under offers:manage, guarded delete, offer stats and practice lead`.

### Task 9: Offers and practices (web-ui) and the offer e2e

**Files:**
- Create:
  - `web-ui/src/features/offers/{OffersScreen,PracticeTree,PracticeView,OfferView,OfferForm,PracticeForm,api}.tsx|ts`
  - `web-ui/src/features/offers/Offers.module.css`, `offers/testing.ts`
  - tests `offers/{offers,offer-form}.test.tsx`
  - `tests/e2e/offers.spec.ts`
- Modify: `web-ui/src/routes/workspace.tsx` (`offers`, `offers/$practiceId`, `offers/$practiceId/$offerId`, plus search `edit=offer|practice|new-offer|new-practice`), `web-ui/src/routes/screens.ts`

**Interfaces:**
- **Left tree:** `New practice` (with `offers:manage`). Each practice shows its `offer_count`, and its offers each have a status dot (`status_label`) and `Add offer`.
- **Practice view:**
  - Name, "Led by {lead_name} · {n} offers" ("No lead yet · {n} offers"), positioning.
  - An offer card each: title, status, `price_label`, summary, and "{matched} accounts matched · {won} won" or "No accounts matched yet".
  - `Delete practice` (confirm "Delete {practice}?" / "Its draft and retired offers stay in the history.", or blocked with the API's 409 title), `Edit practice`, `Add an offer to this practice`.
- **Offer view:**
  - Breadcrumb {practice} / Offer, title and status, "Updated {date} · Practice lead {name}".
  - `Duplicate` (opens the form prefilled as a new Draft named "{title} (copy)").
  - `Retire` when `can_delete` is false (confirm "Retire {offer}?" / "Scout stops matching accounts to it. Accounts already matched keep it. You can't undo this.", toast "{x} retired."). `Delete` when `can_delete` (confirm "Delete {offer}?" / "It never matched an account, so nothing else changes.", toast "{x} deleted.").
  - `Edit offer`.
  - The `price_label` line.
  - Stats tiles Accounts matched, Won, Win rate (from the API, with "Current, not yet attributed to outcomes" under them).
  - `See accounts for this offer` (All accounts with `offer`).
  - The sections Summary, Ideal customer, Key offer, Why us, Why now, each with the empty state "Not written yet. Add it" (with `offers:manage`; it opens the form at that field) and Proof points.
  - Playbook by tier, Initial message and the Seller guide are not rendered (R2).
- **Offer form** (a drawer):
  - Title ("Give the offer a title.").
  - Practice.
  - Status: Active "Scout matches accounts to it", Draft "Hidden from matching". A retired offer shows "Retired. Kept for history." read only.
  - Pricing (Fixed fee, Starting at, Per month, Custom quote), Amount (sent as both `price_min_cents` and `price_max_cents`; Custom quote sends neither), Length (weeks).
  - The sections.
  - Who it's for: typical deal size, sales cycle in days, target titles or roles (chips), industries (chips), company size min and max.
  - Proof points (one per line).
  - `Cancel`, and `Save changes` or `Add offer`.
  - Saving: `POST`/`PATCH`, then `:approve` or `:unapprove` when Status changed. On `offer-incomplete` the form lists "To make this offer active, add: {errors[].message joined}" and keeps the offer saved as Draft. On a `warning` it shows "This offer is back in Draft. Make it active again when you're ready.".
  - Toasts: "{title} added to {practice}.", "Changes to {x} saved.", "{x} is active.", "{x} is back in Draft.".
- **Practice form:** Name ("Give the practice a name."), Practice lead (`members/directory`), Positioning; `Create practice` or `Save changes`; toast "{practice} created. Add its first offer.".
- People without `offers:manage` see no edit, create, retire or delete controls. Drafts are hidden from them by the API.
- **e2e `offers.spec.ts`**, "an owner edits an offer":
  - sign in as Zach
  - Offers, pick the first practice, then the first active offer
  - `Edit offer`: set Why us to `E2E why us {timestamp}`, Pricing Fixed fee, Length 6, `Save changes`: toast `Changes to … saved.`
  - The view shows the Why us text and "Fixed fee · … · 6 weeks", and the offer is still Active (a content edit)
  - `Edit offer` again: add an industry, `Save changes`: the warning "This offer is back in Draft. …"; then set Status Active and save: toast "{x} is active."
  - Reload: the edits stay

- [ ] **Step 1: Write failing tests (MSW)** for each item above: tree counts, the card stats line, Retire vs Delete by `can_delete`, the blocked practice delete, the incomplete-approve list, the back-to-draft warning, Duplicate prefill, read-only for `offers:read`, and the R2 sections absent. Plus the e2e.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run web-ui `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and root `npm run e2e -- offers.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web-ui): Offers and practices, with the offer e2e`.

### Task 10: Settings > Review statuses (routing, web-ui), its e2e and full verification

**Files:**
- Create:
  - `web-ui/src/features/settings/review-statuses/{ReviewStatusesTab,StatusTable,ReasonList,api}.tsx|ts`
  - `web-ui/src/features/settings/review-statuses/review-statuses.test.tsx`
  - `tests/e2e/review-statuses.spec.ts`
- Modify:
  - `src/http/routes/v1/settings/review/route.ts`
  - `src/modules/routing/services/settings.ts` (`saveReviewSettings`)
  - `src/modules/routing/index.ts`
  - `web-ui/src/features/settings/SettingsScreen.tsx` (the tab)
  - `docs/spec/web-ui/api-gaps.md` (21d rows to READY)
  - `docs/spec/migration-and-rollout/release-plan.md` (the R1 screen lines)
- Test: `tests/integration/v1/review-settings.test.ts`

**Interfaces:**
- `PUT /api/v1/settings/review` (`settings:manage`, people only) takes `{ statuses?: [...as the statuses PUT], reasons?: [...as the reasons PUT], auto_accept_working_days?: number|null }`. It saves all of them in one transaction, in the order statuses, reasons, auto-accept, and returns `getReviewSettings` with counts. The errors carry the paths `statuses.{i}.label`, `reasons.{i}.label` and `auto_accept_working_days`. Audit as today (one row per part).
- **§21d tab:**
  - The intro copy as screens.md.
  - The status table, with `Add status` and these columns:
    - Color: a select of Plum, Amber, Green, Red, Gray, from the API's colors
    - Name
    - What it means
    - Set by: Scout, automatically / A reviewer
    - Flag after: hours, "Never", or "Final" for statuses that count as reviewed (read only)
    - In it now: "{n}", "{n} late"
    - Reorder: up and down buttons, keyboard-operable
    - Archive: hidden for `required` statuses, which show "Scout needs this status" instead. Confirm "Archive {status}?" / "Its {n} accounts move to {first status}."
  - Send-back reasons: the screens.md intro; each reason with a "Note required" switch and "{n} this quarter"; "Add a reason"; archive. At least one must stay live ("Keep at least one send-back reason.").
  - Decline reasons for AEs (`applies_to` `assignment`), the same controls.
  - "Accept assignments automatically after {n} working days" (1 to 10, or off).
  - `Restore defaults` (confirm "Restore the default statuses and reasons?" / "Statuses and reasons you added are archived and their accounts move to {first status}.", then `POST /settings/review:reset`).
  - `Discard` (back to the loaded values).
  - `Save statuses` (enabled when something changed), toast "Review statuses saved. The review queue now shows them.". Errors are shown at their rows from `errors[].path`.
  - Leaving with unsaved changes asks "Leave without saving?".
- **e2e `review-statuses.spec.ts`**, "an owner edits a review status and a send-back reason and the queue shows it":
  - sign in as Zach, send an account (`sendAccount`)
  - Settings > Review statuses: rename `In review` to `Being checked {ts}`; add a send-back reason `Wrong region {ts}` with Note required off; `Save statuses`: toast as above
  - Review queue: the Filter > Review status lists `Being checked {ts}`; set the sent account's status to it in the peek, and the row's status reads it
  - `Send back` on that account: the dialog's reasons include `Wrong region {ts}`; pick it and send: toast "Sent … back …"
  - `test.afterAll`: `POST /api/v1/settings/review:reset` through the page's fetch, so later specs see the defaults

- [ ] **Step 1: Write failing tests.**
  - Integration: one PUT with a good status rename and a bad reason (an empty label) gives 400 at `reasons.0.label`, and the status keeps its old name. A good combined save changes all three, and `GET /review-queue/facets` statuses show the new label. 403 for a leader and 403 for a key.
  - MSW: every control above, required statuses without Archive, the archive confirm count, the at-least-one-reason check, the server error at its row, Discard, Restore defaults, the unsaved-changes prompt, and one PUT per save (count the handler calls).
  - The e2e.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Verify everything.**
  - root `npm run lint`, `npm test`, `npm run build`
  - `web-ui` `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
  - `npm run e2e` (all specs: shell, settings, admin, review, account, sources-import, offers, review-statuses)

  Expected: all PASS.
- [ ] **Step 5:** Commit `feat(web-ui): Settings > Review statuses editor with one atomic save, and its e2e`.
