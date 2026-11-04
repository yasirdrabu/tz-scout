# WEB API gaps

Draft v1 · Updated 2026-10-31

Each screen in `screens.md` (and the shell in `index.md`) checked against the backend as it stands
after R1c: route handlers in `src/http/routes/v1/**`, services in `src/modules/**` and `src/platform/**`.
Every need gets one status: READY (an HTTP endpoint does exactly this), SMALL GAP (the endpoint or
service exists, a field, filter or rule is missing), SERVER ACTION ONLY (the logic exists but only
behind a Next page or server action, so the SPA cannot call it), NEW ENDPOINT (new endpoint over
existing data or a new service), LATER (needs backend work that belongs to a named release, or
"unscheduled" when no release plan has it). Paths are written without the `/api` prefix: `/api/v1/accounts`
is served at `/api/v1/accounts` once C1 lands, `/auth/sign-in/social` at `/api/auth/sign-in/social`.
All v1 responses are snake_case JSON (`v1Route` runs `snakeCase`); field names below follow that.

## Summary

| Module | READY | SMALL GAP | SERVER ACTION ONLY | NEW ENDPOINT | LATER | Total |
|---|---|---|---|---|---|---|
| tenancy (incl. auth, HTTP layer) | 12 | 17 | 8 | 16 | 10 | 63 |
| routing | 21 | 18 | 0 | 9 | 12 | 60 |
| accounts | 13 | 9 | 0 | 4 | 3 | 29 |
| scoring | 12 | 4 | 0 | 2 | 3 | 21 |
| intake | 27 | 10 | 0 | 4 | 6 | 47 |
| crm | 8 | 2 | 0 | 1 | 1 | 12 |
| offers | 25 | 0 | 0 | 0 | 3 | 28 |
| integrations | 1 | 5 | 5 | 1 | 3 | 15 |
| ai-tasks | 0 | 2 | 1 | 5 | 1 | 9 |
| platform | 1 | 8 | 11 | 1 | 2 | 23 |
| playbooks | 1 | 0 | 0 | 0 | 11 | 12 |
| analytics (not built) | 1 | 0 | 0 | 0 | 14 | 15 |
| **Total** | **112** | **82** | **25** | **46** | **69** | **334** |

Rows are de-duplicated across the four source passes; a need that spans modules is counted once, in
the module that owns the data.

### Cross-cutting, first regardless of module

These sit in the HTTP layer (`src/http/routes/v1/_lib/v1-route.ts`, `src/modules/tenancy/services/principal.ts`,
`src/modules/tenancy/auth.ts`) and block the shell and sign-in, so they come before any screen plan.

1. **No-tenant session route.** Every `/api/v1` route goes through `v1Route`, which always resolves a
   tenant principal and opens `withTenant`. `resolvePrincipal` with no `x-scout-tenant` takes the
   user's landing tenant; a platform admin with no membership gets null, so `GET /api/v1/me` is 401 and the
   `/admin` shell cannot load. Add `sessionRoute(opts, handler)` (cookie only, people only, same idle
   12 h and 7-day rules as `sessionPrincipal`, no tenant, `Idempotency-Key` stored under `t_platform`)
   and `adminRoute(opts, handler)` (adds the `platformAdmin` check, uses `adminDb`). Same problem+json,
   snake_case and `x-correlation-id` handling as `v1Route`.
2. **CSRF header rule.** `assertSameSite` requires `Origin` equal to `APP_PUBLIC_URL`'s origin and an
   `x-scout-tenant` header on every cookie write. Admin writes and `PUT /api/v1/me/...` have no tenant:
   for `sessionRoute` and `adminRoute` the check is Origin only. Every POST (multipart
   `POST /api/v1/imports` and `POST /api/v1/batches/{id}/files` included) takes an `Idempotency-Key`. In Vite
   dev behind a proxy, `APP_PUBLIC_URL` must be the Vite origin (and the Entra redirect URI
   `.../api/auth/callback/microsoft` registered for it), or writes get 403 and OAuth returns to the
   wrong origin.
3. **`/me` shape.** Today `{tenant{id,slug,name}, kind, id, scopes[], data_limit, source_id, environment}`
   (`src/http/routes/v1/me/route.ts`). C4 says "permissions"; the field is `scopes`. Add person fields (`name`,
   `email`, `platform_admin`, `role`, `support_access`, `sign_in_method`), `workspaces[{id,slug,name,role,member_count}]`
   (all active tenants for a platform admin), and answer with `tenant:null, scopes:[]` for a platform
   admin with no tenant. Decide once whether to rename `scopes` to `permissions` or keep `scopes` and
   change C4's wording (recommended: keep `scopes`, it is also the API key term).
4. **SPA sign-in return and error paths.** The old client sends `callbackURL:'/'`
   (`src/components/client.tsx:141`). The SPA must send a validated relative `callbackURL` (single
   leading `/`, no `//`, no scheme) and `errorCallbackURL:'/signin'`. better-auth's own `/error` page is
   in `DISABLED_PATHS` and blocked by `ALLOWED_PATH`, so today an OAuth failure (non-member, disabled
   user) lands on a 404. Map the codes thrown in `databaseHooks` (`not_set_up`, `account_turned_off`,
   `sign_in_failed`; copy `NOT_SET_UP`, `ACCOUNT_TURNED_OFF`, `SIGN_IN_FAILED`) to the §1 copy, with an
   integration test per code. The SPA decides "signed in" from `GET /api/v1/me`, never from
   `GET /auth/get-session` (that does not apply the idle and age caps).
5. **Permissions the spec names that do not exist.** `costs:read`, `costs:manage`, `review:configure`
   are not in `PERMISSIONS` (`src/modules/tenancy/domain/permissions.ts`). Backend names:
   `analytics:read` (already exists, in `COMMON`, so every role holds it), `costs:write`,
   `settings:manage`. API keys are `keys:manage`, not `integrations:manage`. See Spec corrections.
6. **Names behind ids.** Most payloads carry user ids only (`owner_user_id`, `assigned_by`,
   `seller_user_id`, audit `actor_id`, batch `principal`). Resolve names server side in each endpoint
   (preferred, keeps C8) rather than asking the SPA to call a members list that most roles cannot read.
7. **`status_url` paths.** `src/http/routes/v1/batches/route.ts` and `src/http/routes/v1/arrivals/route.ts` build
   `/api/v1/batches/{id}` and `/api/v1/arrivals/{id}`; change to `/api/v1` with C1.

## Decisions taken

| # | Decision (2026-10-31, the user) |
|---|---|
| 1 | Send back takes a reason from a Settings list; a note is required only for reasons marked `note_required`. Seed a "Sent back to source" status with `returns_to_source`. |
| 3 | Notes are a list: new `accounts.account_note` table, `GET/POST /api/v1/accounts/{id}/notes`, `note_count` on queue rows. |
| 4 | Manual tier override: `PUT /api/v1/accounts/{id}/tier` `{tier or null, note}`, kept across rescores, shown with who changed it and the scored tier. |
| 2 | The review status editor comes now (R1): add, rename, recolor, "What it means", "Set by", SLA hours with late counts, reorder, archive, and the send-back and decline reason lists (`PUT /api/v1/settings/review/statuses`, `/reasons`, reset). Seeds renamed to the mockup's words. |
| 5 | Best offer is editable inline: `PUT /api/v1/accounts/{id}/lead-offer`; rows show the override when set, else the scored best offer. |
| 7 | The account page waits for the Playbooks handoff package (`HandoffPackageProvider`), so it opens with Recommendation and Brief filled. Playbooks (minimum) moves ahead of the account page in the build order. |
| 8 | "Best match" AE by a stated rule in `GET /api/v1/assignable-sellers`: the seller whose practice access covers the account's best offer, fewest active accounts first; the reason line says which. |
| 9 | Paused sources keep refusing sends (403). Toast copy: "{name} paused. Anything it sends is refused until you resume it." |
| 10 | No per-source queue threshold for now; revisit with trust in R3. The Settings field and "Below Watch, not queued" are left out. |
| 11 | Every source gets an editable owner: nullable `owner_user_id` on `intake.source`, set through `PATCH /api/v1/sources/{id}`; person sources default to their person, agents to their parent's person. Display only for now. |
| 12 | New source kind `list` (under a person source) and `source_id` on `POST /api/v1/imports` for `sources:manage` holders. |
| 13 | (Recommendation taken.) Keep "Remove source": 409 when the source has arrivals, `has_sent` on the source; otherwise archive. |
| 14 | (Recommendation taken.) `/api/v1/api-keys` under `keys:manage`, plus `/api/v1/sources/{id}/keys` under `sources:manage` for that source's keys only. |
| 15 | (Recommendation taken.) Approve and unapprove offers under `offers:manage`; guarded `DELETE` for never-matched offers; practice archive keeps the "approved offers only" rule with the copy changed. |
| 16 | (Recommendation taken.) Summary maps to `promise`, Ideal customer to `description`; add `key_offer`, `why_us`, `why_now`, `price_model`, `length_weeks`. |
| 17 | Editable roles-and-permissions matrix per workspace, with the Viewer role as in the mockup: `tenancy.role_permission`, `GET /api/v1/roles`, `PUT /api/v1/roles/{role}`, `permissionsFor` reads the table; the principal cache is invalidated on save. Owner column locked. |
| 18 | (Recommendation taken.) R1 invites stay membership rows (link = sign-in URL, no expiry, Revoke = remove), plus a `suspended` member status. Tokens, expiry and email come when email sending exists. |
| 19 | Microsoft sign-in only for now. Google and allowed domains per workspace come later; the Members card shows Microsoft only. |
| 20 | Both logs now: `tenancy.sign_in_event` from the auth hooks (successes and failures, 12-month retention) and `tenancy.api_key_call` written for key principals, trimmed to the last 1,000 per key. |
| 21 | Scoring changes to the mockup's model: four weighted scores (Fit, Buying intent, Revenue potential, Source trust) summing to 100, one cutoff per tier (Act now, Good fit, Watch) and Nurture below. A scoring redesign with a full rescore; its own backend plan. Source trust stays the R1 constant until R3 computes it. |
| 22 | (Recommendation taken.) Rescoring stays whole-tenant; the footnote changes to say assigned accounts may change tier too. |
| 23 | Build per-tenant infrastructure as in the mockup: its own database, file storage and encryption key per tenant, region, backups and point-in-time restore, schema version and migrations per tenant, provisioning and deletion states, seats, quotas, export, and owner-granted support access. This replaces the one-database-with-row-level-security model and is its own platform project (architecture change first: `docs/spec/architecture/`). Until it lands, the Tenants screen ships list, create, suspend and resume, and the other sections stay hidden. |
| 24 | (As recommended.) Admin cross-tenant AI runs list with Succeeded, Failed, Stopped by limit; no daily cap, no Retry; tenant `GET /api/v1/ai-runs` kept for owners. |
| 25 | (As recommended.) The mockup wins for Playbooks: `offer_playbook(offer_id, tier, template_id)`, day-based steps and a stop rule go into `docs/spec/playbooks/` before its plan. Drafts only replaced the draft or auto-send mode: nothing is sent automatically (user, 2026-11-02). Built in R2c-1. |
| 26 | Cost budgets per category and month with the 90% alert and the 110% pause of paid pulls through integrations `checkCap`; return on spend from actual won amounts. R3. |
| 6 | Pipeline stages are fully configurable (add, rename, reorder, delete, HubSpot stage, targets). This is a routing, CRM and analytics redesign and gets its own backend plan; until it lands the app reads stages from the API and the editor is hidden. **Status:** done 2026-11-01 (`docs/plans/2026-11-01-pipeline-stages.md`, REV-E5). |

## Decision analysis

The outcomes are in "Decisions taken" above; where an option or recommendation below differs from
them, the decision wins. The module tables further down record the gaps as found before the
decisions, so a row's status or release can be out of date where a decision changed it.

Ordered by how early the decision blocks work: the first R1 plans are Review queue, Account page
(review view), Assign, My accounts; then Sources and Batches; then Offers and Settings; then Admin;
then R2 and R3 screens.

1. **Send-back: reason, note, or both (§2, §3, §5, §21d, C5).**
   Mockup: send back needs a reason chip from Settings on every path, bulk included; C5 says the
   backend validates it.
   Backend today: send back means moving to a status with `returns_to_source`, which requires a note
   ("Say what the source should fix", `routing/domain/status-rules.ts`) and takes no reason; reasons
   apply only to declined statuses and seller declines. No seeded status has `returns_to_source`
   (`routing/defaults.ts`: Unvetted, Needs review, Reviewed, Declined), and none can be created over
   HTTP, so send back is impossible on a fresh tenant.
   Options: (a) seed a "Sent back to source" status (`returns_to_source`, counts as reviewed so it
   leaves the queue), add `send_back` to `decline_reason_def.applies_to`, a `note_required` column,
   validate `reason_key` in `statusChangeProblems`, keep the note required; (b) seed the status only
   and keep note-only, change C5 and the dialog to a note; (c) both reason and note required.
   Recommendation: (a) with the note optional unless the reason has `note_required`. Cost: one seed
   migration plus about a day in routing (schema column, rule, tests).

2. **Review statuses: names, "In review by", editor release (§2, §4, §21d).**
   Mockup: statuses "Ready for review", "In review by Dana", "Waiting on enrichment", "Sent back to
   source", "In HubSpot", with "What it means", "Set by", SLA hours; editor tagged R1.
   Backend today: seeded Unvetted (initial), Needs review, Reviewed, Declined; `tone` is
   `neutral|near|good|bad`; statuses are archived, never deleted; only `auto_accept_working_days` is
   writable (`PUT /api/v1/settings/review`); the editor is REV-E1-S4, R2. "In HubSpot" is the CRM handoff
   state; "Waiting on enrichment" is R2.
   Options: (a) R1 ships with the seeded statuses (renamed in the seed to the mockup's words where they
   map: Unvetted to "Ready for review"), the 21d screen read-only, editor in R2; (b) pull the editor
   (`PUT /api/v1/settings/review/statuses`, `/reasons`, reset) into R1.
   Recommendation: (a). Cost: none beyond the read endpoint and a seed change; (b) costs about three to
   four days of routing work plus the constraint tests.

3. **Notes: a list or the single insights text (§2, §3, §4a).**
   Mockup: a per-account note list (author, date, text), `Add note`, a notes count column in the queue.
   Backend today: one `insights` text per account (`PUT /api/v1/accounts/{id}/insights`, REV-E1-S3), each
   write replaces it, with author and time.
   Options: (a) new `accounts.account_note` table and `GET/POST /api/v1/accounts/{id}/notes`, `note_count`
   on `account_summary`; (b) show `insights` as one note and drop the list and count column.
   Recommendation: (a), notes are the reviewer's main memory across a team. Cost: one table, two
   endpoints, a summary column, about two days.

4. **Manual tier override (§2, §3, §4a).**
   Mockup: inline tier select, "Scout scored this {old}. You changed it.", "Changed by {name}".
   Backend today: tier is computed only (`tierReason`: computed, research_floor, warm_intro_floor); no
   override, no author.
   Options: (a) drop the select, show the tier and its reason; (b) `PUT /api/v1/accounts/{id}/tier`
   `{tier|null, note}` with a `tier_override` honoured by `applyScore`, audited, kept across rescores.
   Recommendation: (a) for R1; the research-rating floor already lets people raise a tier. Cost of (b):
   about two days in scoring plus rescore tests.

5. **Best offer: scored or chosen (§2, §3, §6).**
   Mockup: inline Best offer select in the peek drawer.
   Backend today: `routing.account_review.lead_offer_override_id` exists, set only by `:assign`
   `lead_offer_id` (approved offers only); the queue's `best_offer_id` comes from scoring.
   Options: (a) `PUT /api/v1/accounts/{id}/lead-offer` and the row shows the override when set, else the
   scored best; (b) select only in the assign dialog.
   Recommendation: (a). Cost: one endpoint and a summary field, under a day.

6. **Configurable pipeline stages (§4, §8, §9, §21e, C6).**
   Mockup: stages from Settings (rename, add, reorder, delete "moves accounts back one stage"),
   HubSpot stage per stage, quarter targets.
   Backend today: a fixed enum (`arrived, reviewed, assigned, engaged, opportunity, won, lost,
   declined`, `routing/contracts/types.ts`, `domain/stages.ts`) wired into `nextStage()`, the event
   catalog and CRM; no table, no labels.
   Options: (a) fixed keys with editable labels and descriptions (`routing.stage_def`,
   `PUT /api/v1/settings/stages`); (b) read-only list (`GET /api/v1/stages`) and C6 changed to "stage names
   come from the API"; (c) fully configurable stages (redesign of routing, CRM and analytics).
   Recommendation: (b) for R1, (a) when someone asks to rename. Cost: (b) half a day; (a) two days;
   (c) weeks, not advised.

7. **Account page review view in R1 without Playbooks (minimum) (§4, §4a).**
   Mockup: Scout's recommendation and Brief (Overview, Approach, Value angle, Risks).
   Backend today: the release plan puts the R1 review view under "Playbooks (minimum)"
   (`HandoffPackageProvider`), which R1c status says is not built ("the next plan"). `/score`
   `summary` and `would_raise` are a rule-built partial stand-in.
   Options: (a) ship the review view in R1 with Recommendation and Brief as C9 empty states;
   (b) hold the account page until the playbooks minimum lands.
   Recommendation: (a). Cost: none in the backend.

8. **"Best match" AE badge (§6).**
   Mockup: a "Best match" badge with a reason on one AE card.
   Backend today: no matching logic in any module.
   Options: (a) drop it; (b) a rule (practice access matches the best offer's practice, fewest active
   accounts) computed in `GET /api/v1/assignable-sellers`.
   Recommendation: (b) if the rule is stated in the spec, else (a). Cost: (b) half a day.

9. **Paused source: hold or refuse (§11).**
   Mockup: "Anything it sends is held until you resume it."
   Backend today: a paused source is refused with 403 "This source is paused"
   (`intake/services/submit.ts:81`, and before any read in batch submit); an in-flight import stops as
   `failed`. Nothing is queued for later.
   Options: (a) keep refuse and change the toast to "{name} paused. Anything it sends is refused until
   you resume it."; (b) accept and park arrivals as `held`, release on resume.
   Recommendation: (a), the sender retries and nothing piles up unseen. Cost: copy only; (b) is a new
   arrival state, about three days.

10. **Per-source queue threshold (§11, §14).**
    Mockup: `Queue threshold` (Watch and above, Good fit and above, Act now and above), "kept but skip
    the review queue", batch item "Resolved: Below Watch, not queued".
    Backend today: no such concept in any module or spec.
    Options: (a) drop for R1; (b) `min_queue_tier` on `intake.source` plus a routing rule that sets a
    non-queue status (which one must be named) when the scored tier is below it.
    Recommendation: (a), revisit with trust in R3. Cost of (b): about two days across intake, routing
    and scoring order of events.

11. **Source owner (§11).**
    Mockup: every source has an Owner who "answers for what this source sends, and gets sent-back
    accounts"; owner select in Settings.
    Backend today: only `person` sources carry `user_id` (unique, not editable); an agent's owner is
    its parent person source; vendor, partner and CRM sources have none; nothing routes sent-back
    accounts to a person (feedback is recorded against the source).
    Options: (a) show owner only where derivable (person, agent's parent), no select; (b) add nullable
    `owner_user_id` on `intake.source`, patchable, used only for display and a notification later.
    Recommendation: (a) for R1. Cost of (b): one migration and PATCH validation, under a day, plus a
    notification feature that does not exist.

12. **"List or research sheet" source and the import's source (§12, §15).**
    Mockup: a "List or research sheet" source type, "File upload" as how it sends, a Source select on
    the import.
    Backend today: no `list` kind; imports are always credited to the importer's own person source
    (`senderOf`, `createImport`); `POST /api/v1/imports` takes only an optional `vendor_source_id`.
    Options: (a) drop the card and the select, credit the importer as today; (b) new kind `list`
    (chain under a person source) and `source_id` on `POST /api/v1/imports` for `sources:manage` holders.
    Recommendation: (b), lists are a real channel worth tracking. Cost: about two days in intake
    (kind, chain, cap rules in `caps.ts`, tests).

13. **Remove or archive a source (§11).**
    Mockup: `Remove source`, only when it has sent nothing.
    Backend today: only archive (`PATCH status:"archived"`), final, revokes keys, allowed whatever the
    source sent; archived sources stay in `GET /api/v1/sources`.
    Options: (a) relabel to "Archive source" and allow always; (b) keep "Remove", enforce 409 when the
    source has arrivals, add `has_sent`.
    Recommendation: (b), it matches the mockup and costs a guard and a field. Cost: under a day.

14. **Who creates API keys (§12, §11 Settings, §21c).**
    Mockup: §12 creates a key with the source (`sources:manage`); §21c lists and creates keys under
    `integrations:manage`.
    Backend today: `createApiKey` and `revokeApiKey` exist with no HTTP route; `keys:manage` is owner
    only; operators hold `sources:manage` but not `keys:manage`.
    Options: (a) one resource `/api/v1/api-keys` under `keys:manage`, and source-scoped
    `/api/v1/sources/{id}/keys` under `sources:manage` limited to keys bound to that source; (b)
    `keys:manage` only, operators cannot create a source's key.
    Recommendation: (a). Cost: same service, two thin route sets.

15. **Offer lifecycle: approve, unapprove, delete, practice archive (§19).**
    Mockup: Active, Draft, Retired, Delete (never matched); edits under `offers:manage`; practice
    delete blocked while it has any offer.
    Backend today: `approveOffer` is owner only (`memberRole === 'owner'`), so operators with
    `offers:manage` get 403; approval needs `typical_deal_cents`, `sales_cycle_days`, a target title or
    role, industries or size; no unapprove, no delete; practice archive blocks only on approved offers.
    Options: (a) approve under `offers:manage`, add `:unapprove` and guarded `DELETE`; (b) keep owner
    only and show Active only to owners.
    Recommendation: (a) for approve and unapprove, guarded delete; keep the practice rule (approved
    offers only) and change the copy. Cost: about a day.

16. **Offer content fields (§19).**
    Mockup: sections Summary, Ideal customer, Key offer, Why us, Why now; pricing model; length.
    Backend today: `promise`, `description`, structured buyer fields, `price_min_cents`,
    `price_max_cents`, `proof_points`.
    Options: (a) map Summary to `promise`, Ideal customer to `description`, add `key_offer`, `why_us`,
    `why_now`, `price_model`, `length_weeks`; (b) add a column per section.
    Recommendation: (a). Cost: one migration and schema changes, under a day.

17. **Viewer role and editable permission matrix (§21a).**
    Mockup: an editable roles and permissions matrix per workspace, a Viewer role.
    Backend today: roles `owner|leader|seller|operator` fixed in code (`ROLE_PERMISSIONS`); only
    per-member `extra_permissions`.
    Options: (a) read-only matrix (`GET /api/v1/roles`, `GET /api/v1/permissions`), no Viewer; (b) add Viewer
    to `ROLES` (text column, no migration) with read permissions, matrix still read-only; (c)
    `tenancy.role_permission` table and `PUT /api/v1/roles/{role}`, `permissionsFor` reads it.
    Recommendation: (b). Cost: (a) half a day; (b) plus half a day; (c) about three days and a cache
    story for the 60 s principal cache.

18. **Invites and member states (§21a).**
    Mockup: invite email, 7-day expiry, Resend, Copy invite link, Revoke, Suspended and Expired tabs.
    Backend today: an invite is a pre-created user plus `membership.status='invited'`; no token, no
    expiry, no email (no email code in tenancy); `tenancy.invite` table exists but is unused; statuses
    `invited|active|removed`; `user.disabled_at` is platform-wide.
    Options: (a) R1 invite = membership row, the "link" is the plain sign-in URL, no expiry, Revoke =
    remove; add `suspended`; (b) real invite tokens on the `invite` table with expiry and an email
    sender.
    Recommendation: (a) for R1, (b) when email sending exists. Cost: (a) about a day (suspended status
    through `members()`, `tenantsFor`, `checkSignIn`, `completeSignIn`); (b) about four days plus email.

19. **Per-workspace sign-in methods and allowed domains (§1, §21a).**
    Mockup: Microsoft and Google toggles, allowed domains, "{domain} is not an allowed domain".
    Backend today: Microsoft only (`socialProviders`), membership-only gate (`checkSignIn`), a global
    Entra tenant allow-list (`AZURE_AD_ALLOWED_TENANT_IDS`).
    Options: (a) leave as gaps (C9 empty), Microsoft only; (b) allowed domains per tenant checked at
    invite and sign-in; (c) plus Google.
    Recommendation: (a) for R1. Cost: (b) about two days; (c) adds an OAuth app and account linking.

20. **Sign-in and key call logging (§21a login history, §21c access log, §21g "every sign-in").**
    Mockup: login history with filters and export, 12-month retention; per-key access log of the last
    1,000 calls with errors and new IPs.
    Backend today: nothing records sign-ins (failures throw inside `databaseHooks`, success only sets
    `user.last_sign_in_at`); keys keep only `last_used_at`, `last_used_ip` (throttled to once a minute).
    Options: (a) gaps in R1; (b) `tenancy.sign_in_event` written from the auth hooks plus retention job;
    (c) plus `tenancy.api_key_call` written by `v1Route` for key principals, trimmed to 1,000 per key.
    Recommendation: (b) in R1 (security owners will ask), (c) later. Cost: (b) about two days; (c) about
    two days and a write per API call.

21. **Scoring weights model (§21f).**
    Mockup: four sliders (Fit, Buying intent, Revenue potential, Source trust) 0 to 60 in steps of 5
    summing to 100; one cutoff per tier; Nurture below.
    Backend today: `fit_weight` and `intent_weight` (0 to 1, normalised by their sum); five fit parts
    (industry 30, size 25, revenue 20, region 10, buyer 15) that must sum to 100; trust is a +/- points
    modifier capped by `trust_modifier_max` (default 5); revenue potential is shown, not added
    (`scoring/services/profile.ts`, `domain/combine.ts`, `domain/priority.ts`). Act now needs fit,
    intent and total thresholds plus a research or trigger signal (`domain/tiers.ts`).
    Options: (a) the screen follows the backend model (fit vs intent balance, fit parts summing to
    100, trust cap, three Act now thresholds, Good fit fit threshold, Not a fit below); (b) change the
    scoring model to the mockup's.
    Recommendation: (a). Cost: none in the backend except the tier-ordering check; (b) is a scoring
    redesign and a full rescore story.

22. **Rescore scope (§21f footnote).**
    Mockup: "Rescores accounts still in the review queue; accounts with a seller keep their tier."
    Backend today: `rescoreOnRulesChanged` (`scoring/consumers.ts`) rescores every account in the
    tenant; assigned accounts' tiers change.
    Options: (a) keep whole-tenant and change the footnote; (b) skip accounts with an open assignment.
    Recommendation: (a), a tier is a fact about the account, not the queue. Cost: copy only; (b) about a
    day.

23. **Tenant infrastructure sections and support access (§22).**
    Mockup: region, database, file storage, schema, backups, KMS, seats, test flag, subdomain host,
    Provisioning and Deleting states, migrations, restore, export, delete; support access granted by
    the owner for 24 h.
    Backend today: one database with RLS; `tenant.status active|suspended`; instant creation; platform
    admins have all permissions in every active tenant, always (flagged in audit).
    Options: (a) R1 ships list, create, suspend, resume, member count; the rest are C9 empty states
    tagged Platform; (b) build the per-tenant infrastructure.
    Recommendation: (a). Cost: none for the hidden parts; (b) is the Platform release.

24. **AI runs: scope, statuses, cap, retry (§23).**
    Mockup: cross-tenant list, statuses Succeeded, Failed, Retried, Running, a daily cap, Retry run;
    tenant page retired.
    Backend today: tenant-scoped `listRuns` under RLS, statuses `ok`, `invalid_output`, `error`,
    `refused_by_cap`, rows written at completion (no running), no link between runs (no retried),
    per-run cap only (`max_cost_cents_per_run`), input not stored (only `input_hash`), no retry.
    Options: (a) admin cross-tenant list with mapped statuses (Succeeded, Failed, Stopped by limit),
    no daily cap clause, no Retry; (b) plus a daily cap setting and retry by re-deriving input from the
    subject (`runTask(..., {fresh:true})`).
    Recommendation: (a), and keep a tenant `GET /api/v1/ai-runs` for owners. Cost: (a) about a day; (b)
    about three days.

25. **Playbook per offer and tier (§6, §7, §19, §20; R2).**
    Mockup: each offer picks a playbook per tier; steps by "Day {n}"; Stop when; send automatically.
    Backend spec then: templates scoped by practice or offer, `week_offset` steps, no tier mapping, no
    stop rule, no auto-send (`docs/spec/playbooks/`).
    Decided (a). Drafts only replaced auto-send: the user ruled on 2026-11-02 that nothing is sent
    automatically, so the "Send emails automatically" choice and the "Sends automatically" tag are
    gone. Spec rewritten and API built in R2c-1.
    Options: (a) add `offer_playbook(offer_id, tier, template_id)` and change the playbooks spec to
    days, stop rule and draft mode; (b) keep the backend spec and redraw the screen.
    Recommendation: (a), decided before the R2 playbooks plan. Cost: R2 scope, no R1 impact.

26. **Cost budgets and return on spend (§18; R3).**
    Mockup: monthly budgets per category, alert at 90%, pause paid pulls at 110%; categories Partner
    fees, Data vendors, Agents and hosting, Lists and events, AI usage; return uses each offer's price.
    Backend spec today: no budget model; ledger categories `vendor_credits, ai, ad_spend,
    integration_usage, hours, event, referral_fee, other`; journey stores actual `won_amount_cents`.
    Options: (a) `cost_budget(tenant, category, month, amount_cents)`, a fixed category map, alerts
    only, return from actual won amounts; (b) plus the 110% pause hooked into integrations `checkCap`
    (R1d).
    Recommendation: (a). Cost: R3 scope.

## tenancy

Includes auth and the HTTP layer. Files: `src/http/routes/v1/me/route.ts`, `src/http/routes/api/auth/[...all]/route.ts`,
`src/http/routes/api/dev/sign-in/route.ts`, `src/modules/tenancy/{auth.ts,services/*,domain/*,db/schema.ts}`,
`src/server/{action,page-context}.ts` (Next-only, to retire), `src/app/t/[tenant]/settings/members/page.tsx`,
`src/app/admin/tenants/page.tsx`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| Shell | `GET /api/v1/me` as it is | READY | `GET /api/v1/me` | Needs a tenant (header or last used). Returns `scopes`, not `permissions`. |
| Shell | Person fields: name, email, platform admin, role, support access | SMALL GAP | `GET /api/v1/me` | `SessionUser` has `name, email, platformAdmin`; role from `memberRole`; `principal.supportAccess`. |
| Shell | Workspace switcher with member counts | SMALL GAP | `GET /api/v1/me` `workspaces[]` | `tenantsFor(userId)` gives id, slug, name only; admins get all active tenants via `listTenants`. Role and member count need a count on `tenancy.membership` (`adminDb`). |
| Shell | `/admin` shell for a platform admin with no tenant | NEW ENDPOINT | `GET /api/v1/me` on `sessionRoute` | `tenant:null, scopes:[], platform_admin:true`, all active tenants. See Cross-cutting 1. |
| Shell | Permission-driven nav | SMALL GAP | `GET /api/v1/me` `scopes` | Spec names `costs:read`, `review:configure`, `integrations:manage` for keys do not match (Spec corrections). |
| Shell | Practice access display | SMALL GAP | `GET /api/v1/me` `data_limit` | Practice ids only; names from `GET /api/v1/practices` (`offers:read`, all roles). |
| Shell | Switch workspace, land on last used | NEW ENDPOINT | `PUT /api/v1/me/workspace` `{slug}` | `user.last_tenant_id` is read (`services/sign-in.ts:218`) but never written, so TEN-E2-S1-AC1 falls back to the first tenant. |
| Shell | Nav badges in one poll | NEW ENDPOINT | `GET /api/v1/me/counts` | `{review_queue:n\|null, new_assignments:n\|null, crm_sync:{state,last_sync_at}\|null}`, each null without its permission. Shell polls once every 30 s. Counts come from routing and crm. |
| Shell | Landing: first of Review queue, My accounts, All accounts | READY | from `GET /api/v1/me` `scopes` | Owner and leader hold both `review:act` and `assignments:respond`. |
| Shell | Grouped global search | NEW ENDPOINT | `GET /api/v1/search?q=&limit=` | Optional. `{accounts[], people[], batches[]}`, each group under its own permission and data limit; saves three calls per keystroke. |
| 1 | Start Microsoft sign-in | READY | `POST /auth/sign-in/social` `{provider:"microsoft", callbackURL, errorCallbackURL}` -> `{url}` | Only four paths pass `ALLOWED_PATH`. |
| 1 | Return path after sign-in | SMALL GAP | same | SPA sends a validated relative `callbackURL`. better-auth checks it against `trustedOrigins` (defaults to `baseURL`), fine for relative paths. |
| 1 | Error redirect | SMALL GAP | `errorCallbackURL:"/signin"` | `/error` is disabled, failures land on 404 today. Verify the `/signin?error=<code>` form; test non-member and disabled user. |
| 1 | Sign-in methods available, dev sign-in on | NEW ENDPOINT | `GET /auth/config` (public) -> `{microsoft, google:false, dev_signin}` | From `config.azureAd`, `config.authDevSignin` (read server side by `src/app/signin/page.tsx` today). |
| 1 | Dev sign-in user list | NEW ENDPOINT | `GET /dev/users` (404 unless `AUTH_DEV_SIGNIN`) -> `[{id,email,name,platform_admin}]` | `devSignInUsers()` exists, called only from `signin/page.tsx`. |
| 1 | Dev sign-in action | READY | `POST /dev/sign-in` `{userId}` -> `{user_id}` + cookie | 404 when off, 403 on gate refusal. Outside `/auth` and `/api/v1`; the proxy and the Hono server must carry it. |
| 1 | Session lookup, sign out | READY | `GET /auth/get-session`, `POST /auth/sign-out` | Use `GET /api/v1/me` to decide signed in (idle and age caps live in `sessionPrincipal`). |
| 1 | "{domain} is not an allowed domain" | LATER (unscheduled) | none | No per-workspace domain concept. Decision 19. |
| 1 | Continue with Google | LATER (unscheduled) | none | `socialProviders` has `microsoft` only. Decision 19. |
| all | CSRF for writes without a tenant | SMALL GAP | `assertSameSite` | Origin only for `sessionRoute` and `adminRoute`. Cross-cutting 2. |
| all | Same origin in Vite dev | SMALL GAP | config | `APP_PUBLIC_URL` must be the Vite origin. |
| 2 | Queue column choice per person | NEW ENDPOINT | `GET/PUT /api/v1/me/preferences` | `tenancy.user_preference(tenant_id, user_id, key, value jsonb)`; body `{"queue_columns":["offer","priority",...]}`. Fallback: localStorage. |
| 2, 8 | Owner filter options; names for user ids | NEW ENDPOINT | resolve names in each endpoint; `GET /api/v1/members/directory` for pickers | Cross-cutting 6. |
| 6 | Assignable AEs: name, initials, focus, active account count, HubSpot owner linked | NEW ENDPOINT | `GET /api/v1/assignable-sellers` (`assign:act`) | `tenancy.members(ctx,{permission:'assignments:respond'})` exists, no route. `{user_id, name, practice_ids, active_accounts, crm_owner_linked}`. Active count from open `routing.assignment` rows; owner link from `crmOwnerId` and `crm.owner` (`GET /api/v1/crm/owners` needs `members:manage`, leader lacks it). |
| 11, 12, 13 | Member picker and names (Owner select, "Owned by", "Sent by") | READY | `GET /api/v1/members/directory` (`sources:manage`, `imports:run`, `assign:act` or `members:read`) | `{data[{user_id, name}]}`, active members by name; no emails, roles or permissions. |
| 11 Settings | Key list with mask | READY | `GET /api/v1/sources/{id}/keys` (`sources:manage`) | This source's keys only: `name, prefix, mask, environment, scopes, created_at, last_used_at, revoked_at`; never the secret. |
| 11 Settings | Rotate key (new key shown once) | READY | `POST /api/v1/sources/{id}/keys/{key_id}:rotate` (`sources:manage`, people only, not idempotent) -> 201 `{id, prefix, secret, environment, created_at}` | Per key (Ruling 7): one transaction makes a key with the old one's name, scopes, data limit, environment and limits, then revokes the old one as `Rotated`. Audited `tenancy.api_key.rotated`. A key of another source is a 404. The old key fails within 60 s on other instances. |
| 11 Settings | Revoke without rotating | READY | `DELETE /api/v1/sources/{id}/keys/{key_id}` (`sources:manage`, people only) -> 204 | A key of another source is a 404. Audited `tenancy.api_key.revoked`. |
| 12 step 3 | Create a key when "Send through the API" is picked; sample request | READY | `POST /api/v1/sources` `create_key:true` (agent, partner) | The 201 adds `api_key{id, prefix, secret, environment, created_at}` once; that request is not idempotent-stored. A list refuses a key: 400 "A list gets its accounts from files, not the API.". |
| 21a | List members: name, email, role, status, practice access | SERVER ACTION ONLY | `GET /api/v1/members` (`members:read`) | `members(ctx)` + `memberAccess(ctx)`; `Member = {membershipId,userId,name,email,role,status,permissions}`. Leader holds `members:read`. |
| 21a | "You" marker | READY | client, compare with `GET /api/v1/me` `id` | |
| 21a | Last active | SMALL GAP | `GET /api/v1/members` `last_active_at` | From `user.last_sign_in_at` or `max(session.updated_at)`. |
| 21a | Signs in with | SMALL GAP | `GET /api/v1/members` `sign_in_method` | From `tenancy.account.provider_id`; invited users have no row yet. |
| 21a | Invite people (emails, role, practice access) | SERVER ACTION ONLY | `POST /api/v1/members` `{emails[], role, data_limit?}` -> per-address results | `addMember` one email at a time (`already-member`, `invalid-role`), then `changeMember` for practice access in the same transaction. No invite email is sent. Decision 18. |
| 21a | Change role | SERVER ACTION ONLY | `PATCH /api/v1/members/{id}` `{role}` | `changeMember`; 409 `last-owner`. Add a server-side refusal for changing your own role (the service blocks only the last owner). Audit `tenancy.member.changed`. |
| 21a | Practice access chips | SERVER ACTION ONLY | `PATCH /api/v1/members/{id}` `{data_limit:{kind:"practices",ids}}` | `DataLimitSchema` supports it; the old action offered only all and own_accounts. |
| 21a | CRM user id per member | SERVER ACTION ONLY | `PATCH /api/v1/members/{id}` `{crm_owner_ids}` | `setCrmOwnerIds`. Not in the mockup; R1c CRM needs it, keep a field. |
| 21a | Remove from workspace | SERVER ACTION ONLY | `DELETE /api/v1/members/{id}` | `removeMember`; routing's consumer withdraws open assignments. |
| 21a | Remove confirm "Their {n} open accounts" | SMALL GAP | `GET /api/v1/members` `open_account_count` | Count of open assignments from routing. |
| 21a | Sign out a member everywhere | NEW ENDPOINT | `POST /api/v1/members/{id}:sign-out-everywhere` | `/revoke-sessions` is disabled; use `auth.$context.internalAdapter.deleteSessions(userId)`. Sessions are platform-wide: the confirm must say all workspaces. |
| 21a | Roles and permissions matrix (read) | SMALL GAP | `GET /api/v1/roles` -> `[{role, permissions[]}]`, `GET /api/v1/permissions` -> `[{key,label,group}]` | `ROLE_PERMISSIONS`, `PERMISSIONS`, `permissionLabel` are code constants; groups are not in `permission-labels.ts`. |
| 21a | Matrix editable, Viewer role | READY | `GET /api/v1/roles` (`members:read`), `PUT /api/v1/roles/{role}` (`members:manage`, people only) | Decision 17, done 2026-11-01 (`docs/plans/2026-11-01-roles-and-permissions.md`): `tenancy.role_permission`, Owner locked (409 `role-locked`), no escalation (403 `permission-not-yours`, judged on fresh permissions), cache dropped on save. |
| 21a | Status tabs Suspended, Expired; Suspend, Reactivate | LATER (unscheduled) | `POST /api/v1/members/{id}:suspend`, `:reactivate` | `membership.status` is `invited\|active\|removed`; `sessionPrincipal` already requires `active`. Decision 18. |
| 21a | Invite expiry, Resend, Copy invite link, Revoke invite | LATER (unscheduled) | `:resend-invite`, `:invite-link`; revoke = `DELETE` while invited | `tenancy.invite` unused. Decision 18. |
| 21a | How people sign in, allowed domains | LATER (unscheduled) | `GET/PUT /api/v1/settings/sign-in` | Decision 19. |
| 21a | Login history | LATER (unscheduled) | `GET /api/v1/members/login-history` | Nothing records sign-ins. Decision 20. No geo-IP: show IP only. |
| 21c | List keys (name, source, scopes, mask, created by and at, last used, revoked) | NEW ENDPOINT | `GET /api/v1/api-keys?source_id=` (`keys:manage`) | Columns exist on `tenancy.api_key` (`name, prefix, scopes, source_id, created_by, created_at, last_used_at, last_used_ip, revoked_at, expires_at, environment`); join names. |
| 21c | Create key (name, source, preset) | NEW ENDPOINT | `POST /api/v1/api-keys` `{name, source_id, access:"send_and_status"\|"send_only"\|"read_only"}` -> 201 `{id,prefix,secret}` (`keys:manage`, people only) | Presets to scopes server side (C8): send and status = `arrivals:write, arrivals:read, status:read` (`GET /api/v1/arrivals/{id}` needs `arrivals:read`; `status:read` adds the owner name and `GET /api/v1/accounts/{id}/status`); send only = `arrivals:write`; read only = `accounts:read, status:read`. `arrivals:write` needs a source (`source-required`); grantor limits enforced (`scope-not-available`). |
| 21c | Revoke key | NEW ENDPOINT | `POST /api/v1/api-keys/{id}:revoke` | `revokeApiKey`; audit `tenancy.api_key.revoked`. |
| 21c | Errors "{n} of last {total}"; access log drawer | LATER (unscheduled) | `GET /api/v1/api-keys/{id}/calls` | No per-key call log. Decision 20. |
| 22 | List tenants: name, slug, status, currency, timezone | SERVER ACTION ONLY | `GET /api/v1/admin/tenants` (`adminRoute`) | `listTenants()` behind `adminContext()`. Statuses `active\|suspended`. |
| 22 | Tiles "n active · n suspended"; member count per tenant | SMALL GAP | `GET /api/v1/admin/tenants` `summary`, `member_count` | Server side (C8). |
| 22 | New tenant | READY | `POST /api/v1/admin/tenants` `{name, slug, owner_email, currency, timezone}` -> 201, the row with `workspace: {status: "provisioning"}` | D35: `createTenant` returns at once; a job makes the workspace database (from the template), migrates it, seeds its defaults (the `tenancy.tenant.created` consumers) and opens it (`active`). 409 `slug-taken`, owner invited. Poll `GET /api/v1/admin/tenants/{id}` for `workspace.status`. |
| 22 | Tenant drawer: owner, created | SMALL GAP | `GET /api/v1/admin/tenants/{id}` | `tenant.created_at`; owner via membership role owner. |
| 22 | Retry a failed workspace | READY | `POST /api/v1/admin/tenants/{id}:retry-provisioning` -> the row | D35: a workspace whose making failed shows `workspace: {status: "failed", failed_step, failed_error}`; this sends it through provisioning again (each step resumes). 409 `not-failed` otherwise. |
| 22 | Suspend, Resume tenant | SMALL GAP | `POST /api/v1/admin/tenants/{id}:suspend`, `:resume` | `tenant.status` is honoured (`sessionPrincipal`, `authenticateKey`) but no service sets it. Add `setTenantStatus` + `platformAudit`; drop cached principals. |
| 22 | Platform admins list, add, remove | NEW ENDPOINT | `GET/POST /api/v1/admin/platform-admins`, `DELETE /api/v1/admin/platform-admins/{user_id}` | `ensurePlatformAdmin(email)` is seed only: add audit, the `@taazaa.com` rule, refuse removing the last one or yourself. Entra sign-in already needs the home tenant (`mayLinkByEmail`). |
| 22 | Database, region, schema versions (migrations) | SMALL GAP | `tenancy.workspace_infra` (`database`, `region`, `schema_versions`) | D35 plan 1 records them; the Tenants screen fields need them on `GET /api/v1/admin/tenants`. `scout migrate` keeps `schema_versions`. |
| 22 | Seats, test flag, host, storage, backups, restore, rotate key, limits, export, delete | LATER (Platform) | none | Decision 23; D35 plans 2 to 4. |
| 22 | Support access request and end | LATER (Platform) | none | Admins always have access today. Decision 23. |
| 25 | Name, email, role, practice access, permissions | SMALL GAP | `GET /api/v1/me` + `GET /api/v1/permissions` | Old page used `describeAccess()` (server-side sentences). Return `access_summary[]` from it (C8). |
| 25 | Sign-in method | SMALL GAP | `GET /api/v1/me` `sign_in_method` | From `account.provider_id`, or "Developer sign-in". |
| 25 | Active sessions | NEW ENDPOINT | `GET /api/v1/me/sessions` -> `[{id,current,ip,user_agent,created_at,last_active_at}]` | `tenancy.session` has the columns; `/list-sessions` is disabled. Never return the token. |
| 25 | Sign out of every device | NEW ENDPOINT | `POST /api/v1/me/sessions:revoke-all` | internalAdapter; optionally keep the current one. |
| 25 | Sign out | READY | `POST /auth/sign-out` | |

### Proposed changes

1. `sessionRoute` and `adminRoute` wrappers next to `v1Route`; Origin-only CSRF for them.
2. `GET /api/v1/me` (any signed-in person, on `sessionRoute`): add `name, email, platform_admin, role,
   support_access, sign_in_method, access_summary[], workspaces[{id,slug,name,role,member_count}]`;
   `tenant:null` for an admin with no tenant.
3. `PUT /api/v1/me/workspace` `{slug}`: writes `user.last_tenant_id`.
4. `GET /api/v1/me/counts` -> `{review_queue, new_assignments, crm_sync:{state:"ok"|"failing"|"sample"|"off", last_sync_at}}`.
5. `GET/PUT /api/v1/me/preferences` with table `tenancy.user_preference`.
6. `GET /api/v1/me/sessions`, `POST /api/v1/me/sessions:revoke-all`.
7. `GET /auth/config` (public); `GET /dev/users` (dev only). SPA sends `callbackURL` and
   `errorCallbackURL`; document and test the error codes.
8. `GET /api/v1/search?q=&limit=` (optional).
9. `GET /api/v1/assignable-sellers` (`assign:act`): `[{user_id, name, practice_ids, active_accounts, crm_owner_linked}]`.
10. `GET /api/v1/members/directory` (`sources:manage`, `imports:run`, `assign:act` or `members:read`): `[{user_id,name}]`.
11. Members: `GET /api/v1/members` (`members:read`) with `last_active_at, sign_in_method, open_account_count, data_limit`;
    `POST /api/v1/members` `{emails[], role, data_limit?}` (`members:manage`); `PATCH /api/v1/members/{id}`
    `{role?, data_limit?, crm_owner_ids?}` with self-change refusal; `DELETE /api/v1/members/{id}`;
    `POST /api/v1/members/{id}:sign-out-everywhere`.
12. `GET /api/v1/roles`, `GET /api/v1/permissions` (`members:read`), with permission groups added to `permission-labels.ts`.
13. API keys: `GET /api/v1/api-keys?source_id=`, `POST /api/v1/api-keys`, `POST /api/v1/api-keys/{id}:revoke`
    (`keys:manage`); source-scoped `GET /api/v1/sources/{id}/keys`, `POST /api/v1/sources/{id}/keys`,
    `POST /api/v1/sources/{id}/keys:rotate`, `DELETE /api/v1/sources/{id}/keys/{key_id}` (`sources:manage`,
    keys bound to that source only). New `listApiKeys` service; mask from `prefix`. If "…last4" is
    wanted, add a `suffix` column at creation in a migration (4 characters).
14. Admin: `GET /api/v1/admin/tenants` with `summary{active,suspended}` and `member_count`;
    `GET /api/v1/admin/tenants/{id}`; `POST /api/v1/admin/tenants`; `POST /api/v1/admin/tenants/{id}:suspend`,
    `:resume` with new `setTenantStatus` and `platformAudit`; `GET/POST/DELETE /api/v1/admin/platform-admins`.
15. Pass `x-forwarded-for` from `v1Route` into the audit context (see platform, audit IP).

### Release

R1: the HTTP layer items (1, 2, 7), `/me` items (3, 4), assignable sellers, member directory,
members, roles read, API keys, admin tenants and platform admins, profile sessions. Later: editable
roles and Viewer, invite tokens and expiry, suspended members, sign-in methods and domains, login
history, key access log (Decisions 17 to 20), tenant infrastructure (Platform).

## routing

Files: `src/http/routes/v1/review-queue/**`, `src/http/routes/v1/accounts/[id]/{review-status,insights,status}/route.ts`,
`src/http/routes/v1/assignments/**`, `src/http/routes/v1/settings/review/route.ts`; services
`src/modules/routing/{defaults.ts,services/{queue,assign,review,settings,stage}.ts,domain/{stages,status-rules}.ts,consumers.ts}`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| Shell | Review queue badge | READY | `GET /api/v1/review-queue/count` -> `{count}` (`review:act`) | Poll every 30 s, or via `GET /api/v1/me/counts`. |
| 2 | Queue list, priority desc, cursor paging, filters tier, practice, offer, source, status, batch, flag, arrived since | READY | `GET /api/v1/review-queue?tier&practice_id&offer_id&source_id&status&batch_id&flag&arrived_since&cursor&limit` (`review:act`) | Sort fixed (priority desc, newest first). SPA params `practice`, `offer` map to `practice_id`, `offer_id`; `status` repeats or is comma separated. |
| 2 | Row fields: name, domain, tier, priority, best offer id, review status key and label, stage, owner id, arrived, insights, flags, CRM check | READY | same | `QueueRow` = `SearchRow` + `review_status_label`, `insights*`, `crm{exists, owner_name, lifecycle}`, `flags`. |
| 2 | Row fields missing: fit, intent, location, practice, source and "via", "In review by {name}", "Was {old}", warm intro | SMALL GAP | `GET /api/v1/review-queue` | Add `fit`, `intent` (on `account_summary`), `hq_city`, `hq_state`, `practice_id`, `sources[{id,name,via_name}]` (`source_ids` + `intake.sourceNames`), `status_changed_by_name`, `status_changed_at` (`routing.account_review`), `previous_tier` (last `scoring.score_change.from_tier`), `warm_intro{introducer_name, points}` (`account_score`). Offer and practice names join client side from `GET /api/v1/offers`, `GET /api/v1/practices`. |
| 2 | Notes count column | NEW ENDPOINT | `note_count` on the row | Needs the notes table (accounts). Decision 3. |
| 2 | Tier tab counts, filter option counts | SMALL GAP | `GET /api/v1/review-queue/facets?<same filters>` (`review:act`) | `{tier:{act_now,good_fit,watch,not_fit}, practice:{id:n}, offer:{id:n}, source:{id:n}, status:{key:n}}`, each facet counted with the other filters applied, like `countQueue`. Today `count` returns one number, so four to five calls per render. |
| 2 | "Oldest arrived {age} ago"; empty footnote "Last account reviewed {when}" | SMALL GAP | `GET /api/v1/review-queue/count` | Add `oldest_arrived_at` (min `created_at` of the counted set) and `last_reviewed_at` (max `routing.status_change.at` to a counts-as-reviewed status). |
| 2 | Review status list (labels, tone) for dots, filter and inline select | SMALL GAP | `GET /api/v1/settings/review` | Needs `settings:manage` (owner only); leaders and sellers cannot read it. Allow `review:act` or `assignments:respond` to read, or add `GET /api/v1/review-settings`. `getReviewSettings` returns `statuses[]` and `decline_reasons[]`. |
| 2 | Flags the spec lacks: `declined_by_seller` (seller, reason, when), `new_from`, `handoff_needs_decision`, `handoff_failed` | READY | `QueueRow.flags` | SPA needs chips for them. |
| 2 | Flag "{n} conflicts" | READY | `GET /api/v1/review-queue` `conflict_count` on the row; `flag=conflicts` | From `account_summary.open_conflict_count`, written with detect and resolve (R2a). |
| 2 | Flag "Enrichment requested" | READY (R2b-2) | `enrichment_requested`, `enrichment_requested_by` on the queue row | From `routing.enrichment_open`, fed by the enrichment request events. The peek shows "Enrichment requested by {label}". |
| 2 | Bulk assign (up to 50) | READY | `POST /api/v1/review-queue/bulk` `{account_ids, action:'assign', seller_user_id, notes, lead_offer_id, ownership_decision}` (`review:act` + `assign:act`) | `MAX_BULK` 50: "select all visible" with pages up to 200 must cap. `results[]` per account `{ok}` or `{ok:false,status,message}`; a `stop` preflight is a per-account 409 unless that account is kept: `ownership_decisions:{[account_id]:'keep'}` per account (or `ownership_decision` for all). Uses the stored CRM check (`fresh:false`). |
| 2, 6 | Bulk assign warning listing each affected account | READY | `POST /api/v1/review-queue/assign-preview` `{account_ids[1..50], seller_user_id}` (`assign:act`, people only) | `{data[{account_id, ok:true, preflight, approves_to, replaces} | {account_id, ok:false, status, message}]}` in the order asked; uses the stored check (`fresh:false`), each account in its own savepoint (Ruling 17). |
| 2, 5 | Bulk send back with one reason | SMALL GAP | `POST /api/v1/review-queue/bulk` `{action:'status', to, note, reason_key}` | Needs a `returns_to_source` status (none seeded); requires a note, not a reason. Decision 1. |
| 2 | Empty footnote "{n} sources are scheduled to send this week" | LATER (R1d) | none | Scheduled Apollo and Vibe pulls are R1d. Omit the sentence until then. |
| 2, 3 | 30 s poll and "{n} updates" bar | SMALL GAP | list and count | Add `updated_since` (`account_summary.updated_at >`) next to `arrived_since`. |
| 2, 4 | "Assigned by Dana a moment ago" when someone else decided | SMALL GAP | `GET /api/v1/accounts/{id}/review` `version` | No `if_version` on `PATCH review-status` or `:assign`, so last write wins (matches C13); the page can still compare `version` on refetch. |
| 3 | Inline select Review status | READY | `PATCH /api/v1/accounts/{id}/review-status` `{to, note, reason_key}` (`review:act`, people only) | Declined needs `reason_key` ("Other" needs a note); `returns_to_source` needs a note; reopening a declined account needs a note and lands on Needs review. Returns the snapshot. |
| 3 | Inline select Best offer | NEW ENDPOINT | `PUT /api/v1/accounts/{id}/lead-offer` `{offer_id\|null}` (`review:act`) | `lead_offer_override_id` exists, set today only by `:assign`. Approved offers only. Decision 5. |
| 3 | "Changed from {old}" per field; Changes list | NEW ENDPOINT | `GET /api/v1/accounts/{id}/changes?cursor` (`accounts:read`) | Union of `routing.status_change` (from, to, note, reason, by, at), `routing.stage_change`, assignment events, `scoring.score_change` and the first arrival: `[{at, kind, field, from, to, by_name, note}]`. |
| 4 | Header: status pill with who and when, stage, assignment, "Approved by {name} on {date}" | NEW ENDPOINT | `GET /api/v1/accounts/{id}/review` (`accounts:read`, data-limited) | No HTTP read of `account_review`. `GET /api/v1/accounts/{id}/status` returns the key, not the label, and `handoff`, `last_activity_at` only with `crm:push` (sellers lack it). Body: `{status{key,label,tone,changed_at,changed_by_name}, stage, stage_changed_at, stages[{stage,at}], insights{text,by_name,at}, flags, current_assignment{id, seller_user_id, seller_name, assigned_by_name, assigned_at, notes, status, accepted_how, responded_at}\|null, approved_by_name, approved_at, sources[{id,name,kind,owner_name}], version}`. |
| 4 | Stage tracker with dates, "Waiting on you", "Next" | NEW ENDPOINT | `stages[]` in `GET /api/v1/accounts/{id}/review` | Dates from `routing.stage_change`; fixed eight stages. Decision 6. |
| 4 | "{i} of {n}", Previous, Next | READY | client over the loaded queue list | Keep list and cursor in router state. |
| 4 | `Approve and assign`, `Send back` | READY | `POST /api/v1/accounts/{id}:assign`, `PATCH /api/v1/accounts/{id}/review-status` | See §5, §6. |
| 4 | `Reassign`; withdraw | READY | `POST /api/v1/accounts/{id}:assign` (replaces the open assignment), `POST /api/v1/assignments/{id}:withdraw` | `:assign-preview` returns `replaces`. |
| 4a | Leader insights (free text) | READY | `PUT /api/v1/accounts/{id}/insights` `{insights}` (`review:act`) | One block with author and time. Decision 3. |
| 4b | Assignment card: AE, "Accepted {when}" or "Waiting for {AE}", assigner's note | SMALL GAP | `current_assignment` in `GET /api/v1/accounts/{id}/review` | `GET /api/v1/accounts/{id}/assignments` needs `assign:act` (sellers lack it) and returns `assigned_by` as an id. `accepted_how` (seller, crm_activity, auto_timeout) is available. |
| 5 | Reason chips (required) and note | SMALL GAP | `PATCH review-status`, bulk | Decision 1: seed the status, add send-back reasons, accept `reason_key`. |
| 5 | Title "Send back to {source} ({owner})" | SMALL GAP | `sources[]` in `GET /api/v1/accounts/{id}/review` | `GET /api/v1/accounts/{id}/arrivals` and `GET /api/v1/sources` need `arrivals:read`; owner name needs a member lookup. |
| 5 | Toast, next account opens | READY | client | |
| 5, 21d | Send-back reasons editable | READY | `PUT /api/v1/settings/review` `{reasons}` (the editor), `PUT /api/v1/settings/review/reasons` | Decision 2, Ruling 19. Each reason has `note_required`; at least one live per list. |
| 6 | Assign (account page, peek, bulk) | READY | `POST /api/v1/accounts/{id}:assign` -> 202 `{seller_user_id, notes, lead_offer_id, ownership_decision}` (`assign:act`) | Approves in the same step (first non-declined counts-as-reviewed status) and starts the CRM handoff. Declined account: 409 "Reopen it before assigning." `notes` max 4,000. |
| 6 | Assign preview, CRM owner warning | READY | `POST /api/v1/accounts/{id}:assign-preview` `{seller_user_id}` (`assign:act`) | `{preflight{result:new\|assign\|stop\|blocked, message}, approves_to, replaces}`. `blocked` = AE has no HubSpot owner (no spec state). 503 `crm_unavailable` is a dialog state. |
| 6 | Warning detail: deal name, amount, last activity, current owner | READY | `:assign-preview` | `preflight{result, message, reason:open_deal|customer|owned_elsewhere|no_owner|null, current_owner_name, deal{name, amount_cents, currency, last_activity_at}|null}`; `deal` only for `open_deal`, from the stored top open deal. |
| 6 | "Scout adds {AE} as collaborator, leaves Rita owner" | SMALL GAP | `ownership_decision:'keep'` | `keep` pushes and does not change the owner (`crm/services/push.ts`, `keepCurrentOwner`); no collaborator code exists in crm. Reword (Spec corrections). |
| 6, 7 | Playbook cards, playbook name | READY (API R2c-1; UI R2c-2) | `GET /api/v1/accounts/{id}/playbook-suggestion` (`assign:act`), `playbook_id` on `:assign` and bulk assign, `playbook_name` on `GET /api/v1/assignments` | Absent `playbook_id` means the tier default, `null` means "No playbook". Pending rows show the playbook that will start. |
| 7 | New assignments list | SMALL GAP | `GET /api/v1/assignments?mine=true&status=pending` (`assignments:respond`) | Row has `assigned_by` as id. Add `assigned_by_name`, `offer_id`, `offer_name`. A page can be short with `next_cursor`: follow it. |
| 7 | Subtitle and nav badge count | SMALL GAP | `GET /api/v1/assignments` `total`, or `GET /api/v1/me/counts` | No count today. |
| 7 | Accept | READY | `POST /api/v1/assignments/{id}:accept` (`assignments:respond`) | 409 if already answered. Auto-accept after N working days (default 2) and on a CRM reply or meeting can change the list without the AE. |
| 7 | Decline with reason (required) and note | SMALL GAP | `POST /api/v1/assignments/{id}:decline` `{reason_key, note}` | Reason list from `GET /api/v1/settings/review` needs `settings:manage`: same read fix; filter `applies_to` assignment or both. Note required only for `other`. Sets `declined_by_seller`, stage back to `reviewed`. |
| 7 | Active table: account, stage, last HubSpot activity | SMALL GAP | `GET /api/v1/accounts?owner_user_id=me` | Neither assignments nor accounts list return stage plus last activity today. See accounts. |
| 7 | `POST /api/v1/accounts/{id}:seen` clears "New from" | READY | `assignments:respond` | Call when the AE opens the account (spec omits it). |
| 7 | "{n} next step due today", Next step, Due | READY (API R2c-1; UI R2c-2) | `next_step {title, due_date, overdue, due_today}` and `playbook_name` on `GET /api/v1/assignments` and `GET /api/v1/accounts`; `next_steps_due_today`, `next_steps_overdue` on `GET /api/v1/me/counts` | Only with `playbooks:read`; null otherwise or when there is no open step. |
| 9 | Stage counts now, per stage and exits | NEW ENDPOINT | `GET /api/v1/stages/summary` (`analytics:read`, data-limited) | Current stage on `account_review.stage` (copied to `account_summary.stage`). Serves Overview from R1 data. |
| 9 | Funnel bands: entered this period, "{x}% of {previous}" | NEW ENDPOINT | `GET /api/v1/stages/summary?from=&to=` | From `routing.stage_change` plus `account_review.created_at` for arrived (no `stage_change` row at arrival). `moveStage` writes only the destination: a jump must count skipped stages as passed. |
| 10, 11 | Reviewed, Assigned, Won per source | READY | `GET /api/v1/sources/stats` (see intake) | Cumulative by `FUNNEL` rank; declined and lost count in Sent and Reviewed only (Ruling 4). |
| 14, 15 | Batch's accounts waiting in the queue ("Go to review queue") | READY | `GET /api/v1/review-queue/count?batch_id=` (`review:act`) | `batch_id` filter capped at 1,000 accounts (larger is 400). Operators lack `review:act` by default; for them serve the count from the batch read. |
| 21d | List statuses (color, name, order) | READY | `GET /api/v1/settings/review` | `statuses[]{key, label, order, color, description, set_by, flag_after_hours, counts_as_reviewed, is_declined, is_initial, returns_to_source, is_final, required, archived, in_status_count, late_count}`, plus `colors[{value,label}]` for the picker. |
| 21d | "In it now" count per status | READY | `GET /api/v1/settings/review` `in_status_count`, `late_count` | Tenant-wide from `account_review`, for `settings:manage` only. |
| 21d | Review decline reasons (read) | READY | `GET /api/v1/settings/review` `decline_reasons[]{key, label, applies_to, note_required, archived}` | 10 seeded (`routing/defaults.ts`). |
| 21d | "{n} this quarter" per reason | READY | `used_this_quarter` in the reasons read | From `routing.status_change.reason_key` and `routing.assignment.decline_reason_key`, tenant timezone. |
| 21d | Add, rename, recolour, reorder, archive statuses | READY | `PUT /api/v1/settings/review` `{statuses}` (the editor), `PUT /api/v1/settings/review/statuses` | Archive, never delete; the statuses Scout needs are not archivable; archiving moves accounts to the first status. Decision 2, Ruling 19. |
| 21d | Decline reasons for AEs (edit) | READY | `PUT /api/v1/settings/review` `{reasons}` | Same table, `applies_to='assignment'`. |
| 21d | Restore defaults, Discard, Save | READY | `POST /api/v1/settings/review:reset`, `PUT /api/v1/settings/review` `{statuses?, reasons?, auto_accept_working_days?}` | One transaction; every part is checked first, so a bad part saves nothing; errors at `statuses.{i}.*`, `reasons.{i}.*`, `auto_accept_working_days`; audited per part (Ruling 19). Discard is client side. |
| 21d | "Flag after" hours and "{n} late" | READY | `flag_after_hours` on `review_status_def`, `late_count` in the read | 1 to 720 hours or never; final statuses are never flagged. Late = `status_changed_at` older than `flag_after_hours`. |
| 21d | Auto-accept days | READY | `PUT /api/v1/settings/review` `{auto_accept_working_days}` | 1 to 10 working days or off; on the screen. |
| 21e | List stages: name, meaning, moves-here-when, order, exits | READY | `GET /api/v1/stages` (`accounts:read` or `status:read`), `GET /api/v1/settings/stages` (`settings:manage`, with `defaults`) | Per workspace, done 2026-11-01 (`docs/plans/2026-11-01-pipeline-stages.md`, REV-E5). |
| 21e | Rename stages | READY | `PUT /api/v1/settings/stages` (`settings:manage`, people only) | History keeps the names it had (`from_name`, `to_name`). |
| 21e | Add, reorder, delete stages | READY | `PUT /api/v1/settings/stages` | Deleting moves accounts per REV-E5 (cause `stage_deleted`); triggers per stage. |
| 21e | HubSpot stage per stage | READY | `PUT /api/v1/settings/stages` `hubspot_stage` | A deal reaching a mapped HubSpot stage moves the account; stage-only deal changes publish `crm.deal.changed`. |
| 21e | Quarter target | READY (stored); shown in R3 | `PUT /api/v1/settings/stages` `quarter_target` | Overview pace markers use it in R3. |

### Proposed changes

1. `GET /api/v1/accounts/{id}/review` (`accounts:read`, data-limited): body as in the §4 row. New
   `routing.getReview` over `account_review`, `status_change`, `stage_change`, `assignment` and member names.
2. `GET /api/v1/accounts/{id}/changes?cursor` (`accounts:read`): `[{at, kind, field, from, to, by_name, note}]`.
3. `GET /api/v1/review-queue/facets` (`review:act`). `GET /api/v1/review-queue/count` adds `oldest_arrived_at`,
   `last_reviewed_at`. List and count accept `updated_since`.
4. `QueueRow` adds `fit, intent, hq_city, hq_state, practice_id, sources[], status_changed_by_name,
   status_changed_at, previous_tier, warm_intro, note_count`.
5. `GET /api/v1/settings/review` readable with `review:act` or `assignments:respond` (or a separate
   `GET /api/v1/review-settings`); add `description`, `in_status_count` per status and `used_this_quarter`
   per reason. `PUT` stays `settings:manage`.
6. `PUT /api/v1/accounts/{id}/lead-offer` `{offer_id|null}` (`review:act`), publishes the review snapshot.
7. Send back (Decision 1): seed a `returns_to_source` status that counts as reviewed; `applies_to` adds
   `send_back`; `note_required` column; `reason_key` checked in `statusChangeProblems` and stored.
8. `POST /api/v1/review-queue/assign-preview` `{account_ids[], seller_user_id}` (`assign:act`).
9. `POST /api/v1/accounts/{id}:assign-preview` adds `reason`, `current_owner_name`, `taken_from`, deal
   `{name, amount_cents, last_activity_at}`.
10. `GET /api/v1/assignments` adds `assigned_by_name`, `offer_id`, `offer_name`, `stage`,
    `last_activity_at`, `total`.
11. Optional `if_version` on `PATCH review-status` and `:assign` (409 on mismatch).
12. `GET /api/v1/stages` and `GET /api/v1/stages/summary?from=&to=` (`analytics:read`, data-limited):
    `{stages:[{key, label, kind:'funnel'|'exit', current, entered, pct_of_previous}], from, to}`, read in
    `routing/services/read.ts`.
13. `PUT /api/v1/settings/stages` (`settings:manage`): label and description per fixed key, `routing.stage_def`.
14. R2: `PUT /api/v1/settings/review/statuses`, `PUT /api/v1/settings/review/reasons` (or one atomic
    `PUT /api/v1/settings/review`), `POST /api/v1/settings/review/reset`; archived statuses' accounts move to the
    initial status. Later: `sla_hours` and a `late` count.

### Release

R1: items 1 to 12 (the review view, queue, assign and My accounts need them) and the read-only stages
list; item 13 only if Decision 6 picks labels. R2: status and reason editor (item 14). Later: SLA hours,
configurable stages, HubSpot stage map; R3 targets.

## accounts

Files: `src/http/routes/v1/accounts/**`, `src/http/routes/v1/people/**`; services
`src/modules/accounts/services/{search,summary}.ts`, `db/schema.ts` (`account_summary`).

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| Shell | Global search: accounts | READY | `GET /api/v1/accounts?q=` (`accounts:read`) | |
| Shell | Global search: people | NEW ENDPOINT | `GET /api/v1/people?q=` (`accounts:read`; contact fields with `people:read`) | Only `PATCH /api/v1/people/{id}` and `/api/v1/accounts/{id}/people` exist. |
| 4 | Header: name, domain, location, industry | READY | `GET /api/v1/accounts/{id}` (`accounts:read`, data-limited, follows merged ids) | `AccountView`: name, domain, website_url, industry, employees, revenue_cents, hq_*, description, practice_ids, excluded_reason_key, crm_status, people[], aliases[], signals[], merged_into. No account "kind" ("Public agency"). |
| 4 | Pills Practice and Best offer | SMALL GAP | `GET /api/v1/accounts/{id}` + `/score` | `practice_ids` only; best offer in `/score` `best_offer{id,name}`. Return `practice{id,name}` and `best_offer` on the account read, or put them in `GET /api/v1/accounts/{id}/review`. |
| 4 | "Not found or outside your data" | READY | 404 | Hidden and missing are both 404. |
| 4 | Error "Batch B-1042 is still matching facts" | SMALL GAP | none | An unresolved arrival has no account, so the page is a 404. Arrival state lives at `GET /api/v1/arrivals/{id}`. Drop the state (Spec corrections). |
| 4a | Why now: dated signals, newest first | READY | `GET /api/v1/accounts/{id}` `signals[]` | `title, detail, url, occurred_at, kind, type, source_chain`, `source_name` (nearest of vendor, agent, person) and `source_names{person,agent,vendor}`, no `arrivals:read` needed. Filter `occurred_at != null` for the two in the drawer (§3). |
| 4a | Account facts with source and date | READY | `GET /api/v1/accounts/{id}/facts[?field][&include=history]` (`accounts:read`) | `FactView`: key, value, status (current, candidate, superseded), source_chain, observed_at, url, note, pinned_by. Source names need `GET /api/v1/sources` (`arrivals:read`, sellers cannot): resolve names in the response. |
| 4a | Conflict badge, side by side, `Keep this one` | READY | `GET /api/v1/accounts/{id}/conflicts` (`accounts:read`), `POST /api/v1/conflicts/{id}:resolve` `{kept_fact_id, note?}` (`review:act`, people only) | Open and resolved in the last 30 days, each with `label`, `facts[]` (value, source names, observed_at), `kept_fact_id`, `resolved_by_name`, `resolution`, `explanation`; person contact conflicts need `people:read`. Resolve is 400 for a fact not in the conflict, 409 for a replaced value; on a resolved conflict it switches the kept value (R2a, ACC-E3). |
| 4a | Buying committee: people, titles, roles, notes | READY | `GET /api/v1/accounts/{id}/people` (`accounts:read`; contact fields need `people:read`) | `PersonView.roles[{key,origin}]`, `decision_note`, `is_primary`. Role labels need a lookup. |
| 4a | Role labels | READY | `roles[].label` on the account read and `GET /api/v1/accounts/{id}/people`; `GET /api/v1/buying-roles` (`accounts:read`) `{data[{key,label}]}`, active ones by sort | |
| 4a | `Add a person` | READY | `POST /api/v1/accounts/{id}/people` (`people:write`) | Inline arrival; returns `{arrival_id, person_id, already_known}`; roles in `role_keys`. Edit with `PATCH /api/v1/people/{id}`. |
| 4a | Committee gap rows, `Find` | READY (R2b-3) | `GET /api/v1/accounts/{id}/committee[?offer_id]` (`accounts:read`) | `{offer{id,name} or null, roles[{key,label,required,status,people[]}], summary{covered,required,text}, gaps[]}`; `Find` opens the Enrich dialog (§4c) with `initialRoles`. Confirm and edit: `PATCH /api/v1/people/{id}` `role_keys`, `decision_note`, `confirm_role_keys`; `PersonView.decision_note_by/at`, `roles[].set_by_name/set_at`. |
| 3, 4a | Notes list, `Add note` | NEW ENDPOINT | `GET/POST /api/v1/accounts/{id}/notes` (read `accounts:read`, write `review:act` or `accounts:write`) | `accounts.account_note(id, tenant_id, account_id, body, by_user_id, at)`; returns `{id, body, by_name, at}`; 4,000 characters; `note_count` on `account_summary`. Decision 3. |
| 4a | Where it came from: person, agent, vendor, batch, arrived | READY | `GET /api/v1/accounts/{id}/arrivals` (`arrivals:read`) | `ArrivalView`: source ids, `batch_id`, `received_at`. Sellers lack `arrivals:read`: use `sources[]` in `GET /api/v1/accounts/{id}/review`. |
| 4a | Practice inline select (peek §3) | SMALL GAP | `PUT /api/v1/accounts/{id}/practices` `{practice_ids[]}` | Exists but needs `accounts:write` (not `review:act`) and sets a list; the spec has one practice. The row's practice today is the best offer's. Allow `review:act` too. |
| 7 | Active table: stage, last activity, best offer | SMALL GAP | `GET /api/v1/accounts?owner_user_id=me` | Service supports `ownerUserId`; the route does not read it. Return `stage`, `last_activity_at`, `best_offer`. |
| 8 | List with `q`, tier, practice, offer, stage, source | READY | `GET /api/v1/accounts?q&tier&practice_id&offer_id&stage&source_id&domain&cursor&limit` (`accounts:read`, data-limited) | `SearchRow`: account_id, name, domain, tier, priority, best_offer_id, review_status_key, stage, owner_user_id, last_signal_at, excluded_reason_key, created_at. |
| 8 | Owner filter, "Unassigned" | SMALL GAP | `GET /api/v1/accounts` `owner_user_id` (accepts `me`), `unassigned=true` | Service supports both; route does not read them. |
| 8 | Sort by stage, then priority | SMALL GAP | `GET /api/v1/accounts` `sort=stage_priority` | No `sort` today. |
| 8 | Row: owner name, source, location, last activity, value | SMALL GAP | `GET /api/v1/accounts` | Add `owner_name`, `sources[]`, `hq_city`, `hq_state`, `last_activity_at`, `value{amount_cents, kind:open_deal\|won}` (`crm.deal`). Activity text: only kind and time are stored (`crm.activity.kind`). |
| 8 | Row: estimated value | READY | `GET /api/v1/accounts` `value{amount_cents, currency:'USD', kind:'estimated', deal_name:null}` | With no won or open deal: the best offer's `revenue_potential_cents` (scoring). The CSV value kind is "Estimated" (R2a). |
| 8 | Row: next step | LATER (R2) | none | |
| 8 | Stage tab counts incl. All and Other; "{won} won this year" | NEW ENDPOINT | `GET /api/v1/accounts/facets?<filters>` (`accounts:read`) | `{stage:{arrived:n,...}, owner:{}, practice:{}, source:{}, total, won_this_year}` via `countAccounts` grouped by `account_summary.stage`; won this year from `routing.stage_change` to `won` since the start of year in the tenant timezone, data-limited. |
| 8 | "Other" tab (sent back, not pursued, lost) | SMALL GAP | `GET /api/v1/accounts` multi `stage`, `review_status` | `stage` is single-valued; a sent-back account keeps stage `arrived`, so also filter `review_status` (service has `reviewStatusKeys`). |
| 8 | `Export CSV` | NEW ENDPOINT | `GET /api/v1/accounts/export?<filters>` (`accounts:read`) -> `text/csv` | Streams the same query under the data limit. Alternative: SPA pages (200 max) and builds it, which breaks C8 only for formatting. |
| 8 | Filter options: owner, practice, source | SMALL GAP | `GET /api/v1/practices` (READY), `GET /api/v1/sources` (`arrivals:read`), `GET /api/v1/members/directory` | Return option lists in `facets` to avoid the permission gaps. |
| 10, 11 | Per-source stage counts aggregate | READY | `stageCountsBySource(ctx, groups)` accounts service behind `GET /api/v1/sources/stats` | Distinct accounts per stage for a source and the sources under it, through `source_ids`, under `visibleAccounts`. |
| 11 | Accounts tab for a source: search, stage, tier, cursor | READY | `GET /api/v1/accounts?source_id=&q=&stage=&tier=&sort=` | Rows add `first_arrival{at, batch_id, batch_name, source_id, source_name}` when `source_id` is given: the earliest resolved arrival through the source or one below it, from intake `firstArrivals`. |
| 14 | Account name, priority, tier, stage, review status on batch items | READY | via `getSummaries` and `accountNames` | One call each per items page in `GET /api/v1/batches/{id}/items`. Accounts the principal cannot see keep name, priority, tier and stage null. |

### Proposed changes

1. `GET /api/v1/accounts`: accept `owner_user_id|me`, `unassigned`, repeated `review_status`, `stage`,
   `tier`, `sort=stage_priority`; return `total` per page (reuse `countAccounts`) and per row `fit,
   intent, hq_city, hq_state, practice_id, owner_name, best_offer_name, sources[], last_activity_at,
   value, note_count`, plus `first_arrival` when `source_id` is given.
2. `GET /api/v1/accounts/facets` (counts and option lists, `won_this_year`); `GET /api/v1/accounts/export` (CSV).
3. `GET/POST /api/v1/accounts/{id}/notes` with table `accounts.account_note` and `account_summary.note_count`
   (Decision 3).
4. `GET /api/v1/people?q=` for global search.
5. `GET /api/v1/buying-roles` or role labels inside `roles[]`.
6. `PUT /api/v1/accounts/{id}/practices` also allowed with `review:act`.
7. `stageCountsBySource(ctx)` service for `GET /api/v1/sources/stats`; `getSummaries` join for batch items.
8. Account read returns `practice{id,name}` and `best_offer{id,name}`; resolve source names in facts.

### Release

All R1 except committee gaps (R2); conflicts and estimated value came in R2a. Items 1, 2, 3 and 8 come with the
first plan (queue, account page, My accounts, All accounts); 4 with the shell; 7 with Sources and Batches.

## scoring

Files: `src/http/routes/v1/accounts/[id]/{score,matches}/**`, `src/http/routes/v1/scoring/profile/route.ts`
(+ `reset/route.ts`), `src/http/routes/v1/rescore/route.ts`; services
`src/modules/scoring/services/{explain,profile,defaults}.ts`, `domain/{combine,tiers,priority}.ts`, `consumers.ts`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 2 | Rescore banner "Priorities were recalculated ... {n} accounts changed tier", when, by | READY | `GET /api/v1/scoring/last-rescore` (`review:act`) | `{data:{version, changed_at, changed_by_name, summary, weights_text, tier_changed_count} | null}`; null when never changed by a person or over 7 days ago (Ruling 16). |
| 2 | "Was {old}" after a rescore | SMALL GAP | `previous_tier` on the queue row | Last `score_change.from_tier` (routing row). |
| 2, 3, 4a | Priority, fit, intent, tier | READY | `GET /api/v1/accounts/{id}/score[?offer_id]` (`accounts:read`) | `priority, tier, tier_reason, fit, intent, best_offer, lines[], other_offers[], missing[], summary, would_raise[], warm_intro_points, computed_at`. |
| 3 | "Scored {n} and placed in {tier}" | READY | `GET /api/v1/accounts/{id}/score/history?limit` (`accounts:read`) | `from_priority, to_priority, from_tier, to_tier, cause, cause_text, at`. |
| 3, 4a | Other offers' matches | READY | `GET /api/v1/accounts/{id}/matches` | `offer_match` rows, best first. |
| 3, 4a | Manual tier change, "Changed by {name}" | NEW ENDPOINT | `PUT /api/v1/accounts/{id}/tier` `{tier\|null, note}` | Only if Decision 4 picks the override; else drop from the spec. |
| 4a | Score strip notes | READY | `/score` `lines[]` (`label, points, max, text`) | Text is rule-built, not the mockup's wording. |
| 4a | "Act now tier starts at 75" | READY | `/score` `tiles[]` (`key, label, value, max, note`) | The priority tile note is "Act now needs a priority of {total}, fit {fit} and buying intent {intent}." from the tenant thresholds. |
| 4a | Source trust tile | READY | `/score` `tiles[]` `source_trust` | Value null, note "Not enough data yet" until R3. |
| 4a | "6 won of 41 sent" on the trust tile | LATER (R3) | none | Trust from outcomes is R3. |
| 4a | Warm intro line | READY | `/score` `warm_intro{warm_intro_id, introducer_name, relationship_key, relationship_label, points, full_points, confirmed, can_confirm}` or null | The live intake intro (the strongest on the account), not the stored score line. `points` is what counts (half until confirmed), `full_points` the whole; `can_confirm` is true for a person with `review:act` or the intro's own introducer while it is unconfirmed (R2, Claude's call, 2026-11-02). |
| 4a | `Confirm` a warm intro | READY | `POST /api/v1/warm-intros/{id}:confirm` (people only; `review:act` or the named introducer) | Returns `{warm_intro}` in the same shape as `/score`. 404 for an account the caller cannot see; 403 "Only a reviewer or {name}, who made the intro, can confirm it."; confirming twice changes nothing. Publishes `intake.warm_intro.confirmed`, and SCO rescores the account (R2, Claude's call, 2026-11-02). |
| 4a | Revenue potential tile | READY | `/score` `tiles[]` `revenue_potential` | From the four-weight model (SCO-E6); `revenue_potential_cents` and `revenue_band` are on `scoring.account_score`. |
| 21f | Read weights and cutoffs | READY | `GET /api/v1/scoring/profile` (`scoring:manage`) | `weights`, `tier_cutoffs` and `defaults` (SCO-E6, done 2026-11-01, `docs/plans/2026-11-01-scoring-four-weights.md`). |
| 21f | Sliders summing to 100, `Balance to 100` | READY | `PUT /api/v1/scoring/profile` | Four weights 0 to 60 in steps of 5 adding to 100 (SCO-E6); `Balance to 100` is client side. |
| 21f | Cutoffs per tier, ordering rule | READY | `PUT /api/v1/scoring/profile` | `tier_cutoffs` Act now, Good fit, Watch; Nurture below; Not a fit = excluded only (SCO-E6). |
| 21f | Save | READY | `PUT /api/v1/scoring/profile` (`scoring:manage`) | Partial patch; 202 with profile and `version`; errors name snake_case fields; audited. |
| 21f | `Save and rescore` | READY | automatic on save | `rescoreOnRulesChanged` rescores the whole tenant. `POST /api/v1/rescore` (`scoring:manage`, optional `practice_id` or `source_id`) -> 202 `{job_id}`. Decision 22. |
| 21f | `Restore defaults` | READY | `POST /api/v1/scoring/profile/reset` (`scoring:manage`) | 202. |
| 21f | `Discard` | READY | client | |
| 21i | Read the Warm intros tab | READY | `GET /api/v1/settings/warm-intros` (`scoring:manage`) | `relationships[{key, label, points, intro_count}]`, `rules[{id, introducer_user_id, introducer_email, introducer_name, relationship_key, points, intro_count}]`, `introducers[{user_id, email, name, intro_count}]` (members and people recorded intros came from, for the Pick a person select). R2, Claude's call, 2026-11-02. |
| 21i | Save | READY | `PUT /api/v1/settings/warm-intros` (`scoring:manage`, people only) | The whole config `{relationships:[{key, points}], rules:[{id?, introducer_user_id?, introducer_email?, introducer_name?, relationship_key, points}]}`; rules in the body replace the stored ones. Returns the tab plus `rescoring_account_count`. 400 uses `errors[]` with paths such as `rules[2].points`, and a duplicate introducer and relationship saves nothing. Reprices recorded intros and publishes `intake.warm_intro.repriced`. `PUT /settings/warm-intros/{key}` is removed. |
| 21f | "What changes": tier counts before and after, 8 sample accounts | READY | `POST /api/v1/scoring/profile:preview` (`scoring:manage`, no writes) | Same functions and floors as a rescore (SCO-E6). |
| 2, 21f | Rescore progress | READY | `GET /api/v1/scoring/rescores/latest` (`review:act` or `scoring:manage`); `POST /api/v1/rescore` returns `rescore_id` | `{data:{id, cause, total, done, started_at, finished_at, stalled} \| null}`, the tenant's latest run: a count, no account data. `stalled` after 15 minutes with no progress. Banner "Rescoring {total} accounts" and "{done} of {total} rescored" (R2a). |

### Proposed changes

1. `GET /api/v1/accounts/{id}/score` adds `trust`, `trust_source_name`, `trust_modifier`,
   `warm_introducer_name`, `warm_points`, `tier_thresholds` (any `accounts:read`).
2. `GET /api/v1/scoring/rescores/latest` (`review:act` or `scoring:manage`).
3. Tier ordering validation in `problems()` (`profile.ts`).
4. `POST /api/v1/scoring/profile:preview`: body is the PUT partial; response `{window_days:90,
   scored_accounts, tiers:{before:{act_now,good_fit,watch,not_fit}, after:{...}}, samples:[{account_id,
   name, fit, intent, trust_modifier, warm_points, priority_before, priority_after, tier_before,
   tier_after}] x 8}`, biggest tier movers first, as a scoring read over stored `offer_match` rows.
5. If Decision 4 picks an override: `PUT /api/v1/accounts/{id}/tier` `{tier|null, note}` with
   `tier_override` honoured by `applyScore`, audited.
6. R2: rescore job status. Done in R2a as item 2.

### Release

R1: items 1 to 3; item 4 if the screen keeps "What changes" in R1 (else R2 per the scoring spec);
item 5 only on Decision 4. R2: revenue potential (done with SCO-E6), rescore progress (done in R2a). R3: trust from outcomes.

## intake

Files: `src/http/routes/v1/{sources,batches,imports,arrivals,waiting,feedback}/**/route.ts`; services
`src/modules/intake/services/{sources,status,files,imports,waiting,qualified-leads,submit}.ts`,
`import/parse.ts`, `import/synonyms.ts`, `db/schema.ts`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| Shell | Global search: batches | READY | `GET /api/v1/batches?q=` (`arrivals:read`) | Over the batch name, its notes and its file names (`%` and `_` are characters). |
| 4a | Source names behind source chains | READY | `GET /api/v1/accounts/{id}/facts` `source_names{person,agent,vendor}` | Resolved in the route; no `arrivals:read` needed. |
| 10 | Tree rows: name, kind, status, parent, created, trust, last 30 days | READY | `GET /api/v1/sources` (`arrivals:read`) | DFS tree order with `parent_id`, `user_id`, `status`, `kind`, `trust`, `arrivals_last_30_days`. Offset paged (default 50, max 200): follow `next_cursor`. Archived sources included: hide or add `?status=`. Spec says `sources:manage` (Spec corrections). |
| 10 | Search, Type filter, option counts | READY | `GET /api/v1/sources?kind=&status=&q=` | `kind` repeats; `status` is `active,paused` by default or `archived`; `meta{counts_by_kind, kind_labels, can_add_crm}`. Kinds now include `list` (Decision 12). |
| 10, 11 | "How it sends" | READY | `method`, `method_label`, `active_key{id,prefix,last_used_at,created_at}\|null` on list and read | Ruling 6: `through_parent` (agent, scheduled pull), `file_upload` (list), `hubspot_sync` (crm), else `api_key` with a working key, `through_children` ("Through {child}" or "Runs {n} agents") when live sources sit under it, or `none` ("Not sending yet"). |
| 10, 11 | Sent, Reviewed, Assigned, Won per source and child | READY | `GET /api/v1/sources/stats` (`sources:manage`) | `{data[{source_id, sent, reviewed, assigned, won, reviewed_pct, assigned_pct, won_pct, by_stage[{key,label,count}], is_new}]}`. Sent counts accounts (Ruling 4), children rolled up, under `visibleAccounts`. |
| 10, 11 | "New" tag | READY | `is_new` in stats and on each source row | Fewer than 10 reviewed accounts (Ruling 4). |
| 10, 11 | Last sent | READY | `last_sent_at`, `has_sent` on list and read | Over every chain column of `intake.arrival`. |
| 10, 11 | Trust number, bar, band filter, legend, "Needs 10 reviewed" | LATER (R3) | `trust` already on the row | Constant 0.60 (`NEW_SOURCE_TRUST`) until R3; no "10 reviewed" rule. Show "Not enough data yet", hide the Trust filter (C9). |
| 11 | Load one source (header, breadcrumb, details) | READY | `GET /api/v1/sources/{id}` (`sources:manage`) | The list row plus `breadcrumb[{id,name}]` (root first), `daily_arrival_cap`, `initial_review_status_key`, `sync`. Removed, hidden and other tenants' sources are a 404; an archived one opens. |
| 11 | Pause, Resume | READY | `PATCH /api/v1/sources/{id}` `{status:"paused"\|"active"}` (`sources:manage`, people only) | Archived cannot come back (409). Paused sends are refused, not held (Decision 9). |
| 11 | Owner in header, Owner select | READY | `owner{user_id,name}\|null` on list and read; `PATCH` `owner_user_id: string\|null` | `intake.source.owner_user_id` (intake 0004, backfilled). Defaults per Ruling 3; must be a member (400). Audited `intake.source.owner_changed`. Display only. |
| 11 | Queue threshold | LATER (unscheduled) | `PATCH /api/v1/sources/{id}` `{min_queue_tier}` | No concept anywhere. Decision 10. |
| 11 | Remove source (only when it sent nothing) | READY | `DELETE /api/v1/sources/{id}` (`sources:manage`, people only) -> 204; `PATCH {status:"archived"}` | Remove sets `removed` (a 404 everywhere) and revokes keys; 409 `source-has-sent` when it has sent, 409 `source-has-children` (remove and archive) while sources under it are live. `can_remove`, `can_archive` on the row (Ruling 2). |
| 11 | Sync now (HubSpot source) | READY | `POST /api/v1/sources/{id}:sync` (`sources:manage`, people only) -> 202 `{queued:true}` | Queues `qualifiedLeadsPollJob`. Not crm: 400 "Only the HubSpot source syncs."; not connected: 409 "Connect HubSpot first". |
| 11 | Sync status: last synced, last error | READY | `sync{last_polled_at, last_error, connected}` on `GET /api/v1/sources/{id}` (crm only) | `last_polled_at` is the new `crm_lead_poll.polled_at` (intake 0004); `last_error` is the connection's. |
| 11 | Overview: Recent activity | READY | `GET /api/v1/feedback?source_id=` (`sources:manage` with `source_id`) | The source and the sources below it, visibility checked (404). Rows add `summary`, `reason_label`, `by_name` (from the new `source_feedback.by_user_id`) and `account_name`. |
| 11 | Runs or Pulls from: child sources with numbers | READY | `GET /api/v1/sources` rows with `parent_id = id`; numbers from stats | Numbers need the stats endpoint. |
| 11 | Batches tab for this source | READY | `GET /api/v1/batches?source_id=` | The source and the sources under it, on any chain column, with `total`. See §13. |
| 11 | Copy portal link | LATER (R4) | none | Partner portal is R4. |
| 11 | Cost per win, See in funnel, Trust breakdown | LATER (R3) | none | Analytics. |
| 12 | Create agent, vendor, partner source | READY | `POST /api/v1/sources` `{kind, name, parent_id?, user_id?, daily_arrival_cap?, initial_review_status_key?, settings?}` (`sources:manage`) | Agent needs a person parent ("An agent needs an owner. Pick the person who runs it."); scheduled_pull needs a vendor parent. Starting status list from routing. |
| 12 | "List or research sheet" type | READY | `POST /api/v1/sources` kind `list` | Needs a person `parent_id` ("A list needs an owner. Pick the person who uploads it."); takes the agent slot of the chain (Ruling 1). |
| 12 | "CRM" type, "Sync from HubSpot" | READY | `POST /api/v1/sources` `{kind:"crm"}` | A second crm source is 409 "This workspace already syncs from HubSpot."; `meta.can_add_crm` on `GET /api/v1/sources` (Ruling 5). |
| 12 | Duplicate name error | READY | `POST /api/v1/sources`, `PATCH` -> 409 `conflict` with `errors[{path:"name"}]` | Case-insensitive among sources that are not removed. An empty name is 400 at `name`. Person sources made for members may share a name. |
| 12 | "Used by" (vendor to agent) | LATER (R1d) | none | Only a `scheduled_pull` child under a vendor (R1d). |
| 13 | Batch list: id, name, run date, status, item count, counts | READY | `GET /api/v1/batches` (`arrivals:read`) | `BatchView`: `id, name, run_at, status ('processing'\|'completed'), completed_at, item_count, counts{resolved, rejected, new_accounts, already_known}, source_chain`. Keyset paged newest first; narrowed counts for account-only visibility. |
| 13 | Filters Status, Source, Sent by, Run date, search; total; option counts | READY | `GET /api/v1/batches?status_key=&source_id=&sent_by=&since=&q=` | `status_key` repeats (`complete`, `in_progress`, `needs_attention`, `failed`); `sent_by` is a user id (or a key id); `since` an ISO date. Adds `total` and `meta{counts_by_status, attention{count, issues[] (first 3)}}`; the counts use every filter but the status. Batches whose only import was discarded are left out (Ruling 11). |
| 13 | Status chips Complete, In progress, Needs attention, Failed; attention banner; progress line | READY | `status_key`, `status_label`, `issue`, `stages`, `progress_label`, `import{id,status,error}`, `retryable` on each row | Ruling 8. Rows waiting for a person keep the stored status `processing`, so "In progress" means rows still resolving or the import queued; a batch whose only open rows wait is "Needs attention". |
| 13, 14 | Sent by, notes, file name, subtitle | READY | `GET /api/v1/batches`, `GET /api/v1/batches/{id}` | `notes`, `sent_by{kind: user\|api_key\|system, id, name}`, `source{id,name,kind}` (the closest in the chain), `files[{id, file_name, size_bytes, content_type, sha256, created_at}]`. |
| 13 | `Retry {n} rows` | READY | `POST /api/v1/batches/{id}:retry` (`imports:run`, people only) -> 202 `{retried:n}` | Resends the rejected `daily_cap_reached` rows through `storeItems` as new arrivals of the batch (the cap applies again) and marks the old ones `superseded_by` (intake 0005); an import its paused source stopped is queued again from its cursor. 409 "Nothing in this batch can be retried."; audited `intake.batch.retried`. |
| 13 | `Download error report` | READY | `GET /api/v1/batches/{id}/rejections?format=csv` (`arrivals:read`) | `text/csv`, `{batch id}-rejected.csv`, columns `row,company,website,reason,detail`, plus `person,email,phone` only with `people:read`. Formula-like cells start with `'`. Visible rows only. |
| 13 | `Import a list` tab | READY | gated by `GET /api/v1/me` `scopes` (`imports:run`) | |
| 14 | Summary resolved, rejected, waiting | READY | `GET /api/v1/batches/{id}` (`arrivals:read`) | `stages{received, resolving, waiting, resolved, rejected}`, `counts_by_stage`, `rejections[]`. "Sent to review" is not exactly `resolved` (Spec corrections). |
| 14 | Download original file | READY | `GET /api/v1/batches/{id}/files/{file_id}` (`arrivals:read`) | The `id` from `files[]` (not the storage key). Stored content type (else `application/octet-stream`), `Content-Disposition: attachment` with a safe `filename` (and `filename*` when the name needs it), `nosniff`. Another batch's file is a 404. |
| 14 | Items table with tabs All, Waiting, Resolved, Rejected | READY | `GET /api/v1/batches/{id}/items?status=all\|waiting\|resolved\|rejected` + `total` | Items add `company_name`, `website`, `account_name`, `priority`, `tier`, `tier_label`, `review_status_label`, `stage`, `outcome`, `outcome_label` (Ruling 9), `waiting_on` and `duplicate_candidates[{account_id,name,domain}]` (visible ones only). Retried rows are left out. |
| 14 | Waiting row: website input and `Resolve` | READY | `POST /api/v1/arrivals/{id}:supply-website` `{website}` (`imports:run`, people only) | Also `:supply-company` (`{name, website?}` or `{sole_proprietor:true, person_name?}`) and `:choose` (`{same_as}` or `{new_company:true}`). Three waiting reasons; the mockup shows one. Waiting rows auto-reject after 30 days (`waitingExpire`). |
| 14 | Skip the waiting rows | READY | `POST /api/v1/batches/{id}:skip-waiting` (`imports:run`, people only) -> `{skipped:n}` | Not on the mockup; useful as a bulk action. |
| 14 | "Resolved: Below Watch, not queued" | LATER (unscheduled) | none | Needs the queue threshold (Decision 10). |
| 15 | Upload and create import | READY | `POST /api/v1/imports` multipart `file` (+ `sheet`, `vendor_source_id`) (`imports:run`) | 202 `{import_id, batch_id, status:'needs_confirm'\|'queued', layout, proposed_mapping, needs_confirm, headers, row_count, sha256}`. Multi-sheet workbook without `sheet` returns 200 `{status:'needs_sheet', sheets[]}`: add a sheet picker. Max 20 MB, 10,000 rows. Layouts `research`, `vibe` go straight to `queued`: the stepper skips to Resolve. |
| 15 | Source select and notes on upload | READY | `POST /api/v1/imports` fields `source_id`, `notes` (up to 1,000), `name` (up to 200) | Ruling 10: another source needs a person with `sources:manage` (403 "Only people who manage sources can credit another source."), and must be a visible, active person, partner or list source (400 at `source_id`; hidden 404; paused 403 as today). The chain, the saved mapping and the cap are the credited source's; the batch `principal` stays the actor. `POST /api/v1/batches` already takes `notes`. |
| 15 | Match columns: sample values, field list, Suggested, No match, Changed by you | READY | `POST /api/v1/imports` 202 and `GET /api/v1/imports/{id}` | Add `sample_rows` (first 5; contact cells blank without `people:read`), `targets[{key,label}]` ("Don't import" is `key: null`), `file{name, type: CSV\|Excel\|Markdown, size_bytes, sheet, ...}`, `uploaded_by{user_id,name}`, `source{id,name,kind}`, `notes`, `mapping_origin`, `suggested_count`. "Changed by you" is the client's diff. |
| 15 | Confirm mapping and start | READY | `POST /api/v1/imports/{id}:confirm` `{mapping:[{header, target, confidence?, reason?}]}` (`imports:run`) | 202 `{import_id, status:'queued'}`; 409 if not `needs_confirm`; 400 "Map a column to the company name, website or domain."; saves the mapping per source and header signature. |
| 15 | "{n} rows have no website", "Import {m} rows and hold {n}" | READY | `POST /api/v1/imports/{id}:preview` adds `without_website`, `go_ahead` | Companies with no domain or LinkedIn page under the mapping. |
| 15 | Resolve step progress, Done copy, waiting rows, Go to review queue | READY | `GET /api/v1/imports/{id}` (`imports:run`), poll every 2 s | `status` (`uploaded, needs_confirm, queued, imported, failed`), `stats{companies, created, attached, rejected, waiting{count, arrival_ids}, skipped[], error}`. Resolved = `created + attached`; rejected is not only duplicates. `imported` does not mean all rows resolved: poll `batch.status` too. Queue count via `GET /api/v1/review-queue/count?batch_id=`. |
| 15 | "Use a different file" | READY | `DELETE /api/v1/imports/{id}` (`imports:run`, people only) -> 204 | Ruling 11: only while `needs_confirm` (409 "This import has started, so it can't be discarded."); sets `cancelled`, deletes the stored file, audited `intake.import.discarded`. Again is a 204. |
| 15 | Errors: unreadable, no company column, over limit, unsupported type | READY | 400 problem+json from `POST /api/v1/imports`; 413 over 20 MB | `FileParseError` mapped to `validation` with plain text ("This file has more than 10,000 rows. Split it and import the parts."). Show the API title. |

### Proposed changes

1. `GET /api/v1/sources/{id}` (`sources:manage`): `{id, name, kind, status, parent{id,name,kind}|null,
   owner{user_id,name}|null, created_at, last_sent_at, has_sent, method, active_key{id,prefix,last_used_at}|null,
   children_count, daily_arrival_cap, initial_review_status_key, settings, sync{last_polled_at,last_error}?}`.
2. `GET /api/v1/sources`: per row `last_sent_at`, `has_sent`, `method`, `active_key`, `owner`; optional
   `?kind=&status=&q=`, `meta.counts_by_kind`; keep tree order.
3. `GET /api/v1/sources/stats` (`sources:manage`): `{data:[{source_id, sent, reviewed, assigned, won,
   by_stage{arrived, reviewed, assigned, engaged, opportunity, won, lost, declined}, is_new, last_sent_at}]}`
   from the accounts service, children rolled up through `source_ids`.
4. `PATCH /api/v1/sources/{id}`: 409 `conflict` on duplicate name (and on `POST`); `owner_user_id` and
   `min_queue_tier` only if Decisions 11 and 10 say so; archive guard per Decision 13.
5. `POST /api/v1/sources/{id}:sync` (`sources:manage`, people only) -> 202, enqueues `qualifiedLeadsPollJob`.
6. `POST /api/v1/sources` accepts `create_key:true` (agent, partner, list) and returns
   `{...source, api_key{id, secret, prefix}}` once (tenancy item 13). Kind `list` per Decision 12.
7. `GET /api/v1/batches`: query `status, source_id, sent_by, since, q`; rows add `notes, sent_by, source,
   stages, status_label, issue, import{id,status,error}, files[{id,file_name,size_bytes}], retryable`;
   response adds `total` and `meta.counts_by_status`.
8. `GET /api/v1/batches/{id}`: same fields plus file ids; `GET /api/v1/batches/{id}/files/{file_id}`;
   `GET /api/v1/batches/{id}/rejections?format=csv`; `POST /api/v1/batches/{id}:retry` (`imports:run`).
9. `GET /api/v1/batches/{id}/items?status=` with `company_name, website, priority, tier, review_status,
   stage, outcome, outcome_detail` and `total`.
10. `POST /api/v1/imports` accepts `source_id`, `notes`, `name`; returns `sample_rows`, `targets[{key,label}]`,
    `file{name,type,size,sheet}`, `uploaded_by`. `POST /api/v1/imports/{id}:preview` adds `without_website`.
    `DELETE /api/v1/imports/{id}` while `needs_confirm`. `POST /api/v1/batches` accepts `notes`.
11. `GET /api/v1/feedback?source_id=` (`sources:manage`).
12. `status_url` paths move to `/api/v1` with C1.

### Release

All R1 except trust (R3), cost per win and funnel links (R3), partner portal (R4), "Used by" (R1d),
and the queue threshold (unscheduled, Decision 10).

## crm

Files: `src/modules/crm/services/{push,read,leads,settings}.ts`, `src/modules/crm/adapters/hubspot/live.ts`,
`src/http/routes/v1/accounts/[id]/{handoffs,status}/route.ts`, `src/http/routes/v1/crm/[resource]/route.ts`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| Shell | CRM sync indicator | SMALL GAP | `crm_sync{state:"ok"\|"failing"\|"sample"\|"off", last_sync_at}` in `GET /api/v1/me/counts` | Only `GET /api/v1/settings/crm` (`settings:manage`) and `listConnections` (`integrations:manage`, server action) exist, both owner only, and nothing says "last sync". Data: integrations `connection.status`, `mode` and `platform.schedule.last_run_at` of the CRM poll jobs. Every role sees the header. |
| 2 | "In HubSpot" rows, handoff state chips, retry | SMALL GAP | `QueueRow.crm` + `flags.handoff`; retry `POST /api/v1/accounts/{id}:push` (`crm:push`) | Data READY. Default queue hides accounts with an open assignment, so In-HubSpot rows show only under a `status` filter. States `sending, in_crm, needs_decision, failed, cancelled` need chips. |
| 4 | Two HubSpot companies linked | READY | `GET /api/v1/accounts/{id}/handoffs` `conflict` | Not in the spec; the page needs a notice. |
| 4, 4b | `Open in HubSpot` | READY | `GET /api/v1/accounts/{id}/handoffs` `handoffs[].crm_url` | Null until the portal id is known. |
| 4a | "In HubSpot" check card: exists, owner, open deal name, amount, last activity | READY | `GET /api/v1/accounts/{id}/crm-check` (`accounts:read`) + `POST /api/v1/accounts/{id}:check-crm` (`accounts:read`, people only; 503 `crm_unavailable`) | `{exists, owner_name, lifecycle, open_deals, open_deal{name, amount_cents, currency, last_activity_at}, checked_at, hubspot_url}`, or `{exists: null, checked_at: null}` when never checked. The top open deal is stored on `crm.company_check`. |
| 4b | Outcome tiles: meetings, emails, opportunity | READY | `GET /api/v1/accounts/{id}/handoffs` | `follow_through.counts{emails, calls, meetings, deals, open_deals, tasks_done, tasks_total, overdue, last_activity_at}` and `deals[]{name, stage, status, amount_cents}`. |
| 4b | Replies "3 of 9" | READY | `follow_through.counts.replies` | Counts `reply` activity of the latest completed handoff. |
| 4b | Buyers engaged "2 of 4", "Next: Nov 18 with ...", committee engagement per person | LATER (R2) | none | Activity is per account; no next meeting stored. |
| 4b | HubSpot activity feed, "Synced {when}" | READY | `GET /api/v1/accounts/{id}/activity?cursor` (`accounts:read`) | `{data[{id, kind, at, summary}], next_cursor, synced_at}`, 25 a page; Scout rows (kind `scout`) from `crm.handoff`. |
| 6 | Deal detail in the owner warning | READY | `:assign-preview` `preflight.deal` | Stored top open deal (row above); see routing. |
| 6 | Seller without a HubSpot owner | NEW ENDPOINT | `crm_owner_linked` in `GET /api/v1/assignable-sellers` | Today a `blocked` preflight. `GET /api/v1/crm/owners` needs `members:manage`. |
| 6, 7 | Push failures as a row flag; handoff progress | READY | `QueueRow.flags.handoff`, `GET /api/v1/accounts/{id}/handoffs` (`handoffs[].status, attempts, last_error`) | Push is async (202, 6 attempts, retries from 30 s). |

### Proposed changes

1. `GET /api/v1/accounts/{id}/crm-check` and `POST /api/v1/accounts/{id}/crm-check:refresh` (`accounts:read`);
   store the top open deal (`name, amount_cents, currency, last_activity_at`) on `crm.company_check`.
2. `GET /api/v1/accounts/{id}/activity?cursor` (`accounts:read`).
3. `GET /api/v1/accounts/{id}/handoffs` adds `crm_url` and `follow_through.counts.replies`.
4. These reads need `accounts:read` only (today `GET /api/v1/accounts/{id}/status` needs `crm:push` for handoff fields).
5. A CRM sync state read for `GET /api/v1/me/counts` (crm owns the rule, integrations and platform give the inputs).

### Release

R1: all items. R2: per-person engagement and next meeting.

## offers

Files: `src/http/routes/v1/offers/**`, `src/http/routes/v1/practices/**`, `offers/schemas.ts`, `practices/schemas.ts`;
services `src/modules/offers/services/{offers,practices}.ts`; schema `src/modules/offers/db/schema.ts`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 2, 3, 8 | Offer names and filter options | READY | `GET /api/v1/offers[?practice_id&status]` (`offers:read`) | Without `offers:manage`, approved only whatever `status` asks. Cursor paged; cache and join in the SPA. |
| 2, 3, 8 | Practice names and filter options | READY | `GET /api/v1/practices` (`offers:read`) | Active only; offset cursor. |
| 3 | Best offer select options | READY | `GET /api/v1/offers?status=approved` | `lead_offer_id` rejects non-approved offers (400). |
| 6, 7 | "{offer} · {practice}" sub-line | READY | `GET /api/v1/offers/{id}` | Has `practice_id`; join `/practices`. |
| 19 | Practice tree: name, status | READY | `GET /api/v1/practices` | |
| 19 | Offer count per practice | READY | `GET /api/v1/practices` `offer_count` | Non-archived offers (C8), on the list, the read, create and patch. |
| 19 | Positioning | READY | `practice.description` | Label only. |
| 19 | "Led by {lead}", practice lead picker | READY | `POST/PATCH /api/v1/practices` `lead_user_id`; read `lead_name` | `offers.practice.lead_user_id` (offers 0002). A member, else 400 at `lead_user_id` "That person is not a member of this workspace."; null clears it. Picker from `GET /api/v1/members/directory`. |
| 19 | Read one practice (deep link) | READY | `GET /api/v1/practices/{id}` (`offers:read`) | With `lead_name` and `offer_count`; an archived practice opens; another tenant's is a 404. |
| 19 | Offers per practice with status | READY | `GET /api/v1/offers?practice_id=&status=` | `draft`, `approved`, `archived` map to Draft, Active, Retired. |
| 19 | Card: title, status, summary, price | READY | `GET /api/v1/offers` | Every offer response adds `price_model`, `length_weeks`, `price_label` (Ruling 13, in the workspace currency) and `status_label` (Active, Draft, Retired). |
| 19 | "{n} accounts matched · {n} won"; Accounts matched, Won, Win rate | READY | `GET /api/v1/offers/stats?practice_id=` (`offers:read`, data-limited) | `{data:[{offer_id, practice_id, matched, won, win_rate}]}`. Matched = current `scoring.offer_match` not `not_fit`; won = stage `won` with the offer as lead offer (the pick, else best); `win_rate` a whole percent, null at 0 matched. Answered by scoring through the `OfferUsage` port. Approved offers only without `offers:manage`. Attributed win rate is analytics (R3): label these "current". |
| 19 | Offer view: breadcrumb, title, status, "Updated {date}" | READY | `GET /api/v1/offers/{id}` | `updated_at`, `status`, `practice_id`, `case_studies`. A draft is 404 without `offers:manage`. |
| 19 | `See accounts for this offer` | READY | `GET /api/v1/accounts?offer_id=` | Filters on best offer. |
| 19 | Sections Summary, Ideal customer, Key offer, Why us, Why now | READY | `GET/PATCH /api/v1/offers/{id}` | Summary `promise`, Ideal customer `description`, plus `key_offer`, `why_us`, `why_now` (up to 4,000 characters). Content edits keep an approved offer approved. |
| 19 | Proof points | READY | `proof_points` (text[]) | |
| 19 | Create offer | READY | `POST /api/v1/offers` (`offers:manage`) | Requires `name`, `practice_id`, `promise`; slug auto; 201. |
| 19 | Edit offer | READY | `PATCH /api/v1/offers/{id}` (`offers:manage`) | Editing a buyer field on an approved offer drops it to draft with `warning` (show it). Archived: 409 `offer-archived`. |
| 19 | Status Active | READY | `POST /api/v1/offers/{id}:approve` (`offers:manage`, people only) | Needs `typical_deal_cents`, `sales_cycle_days`, a target title or role, industries or size, else 400 `offer-incomplete` with `errors[]`. Decision 15. |
| 19 | Status back to Draft | READY | `POST /api/v1/offers/{id}:unapprove` (`offers:manage`, people only) | Approved to draft, approver cleared, publishes `offers.offer.changed` (`affectsMatching`), so scoring rescores. A draft stays; retired is 409. |
| 19 | `Retire` | READY | `POST /api/v1/offers/{id}:archive` (`offers:manage`) | Idempotent; no un-retire. |
| 19 | `Delete offer` (never matched); Retire vs Delete choice | READY | `DELETE /api/v1/offers/{id}` (`offers:manage`, people only) -> 204 or 409 `offer-has-history`; choice from `can_delete` on `GET /api/v1/offers/{id}` | Never matched = no `offer_match`, no `score_change` naming it, no lead offer pick now or in `lead_offer_change` (the `OfferUsage` port, scoring and routing). Removes its signal rules and case-study links; audited `offers.offer.deleted`; an approved one also publishes `offers.offer.archived`. |
| 19 | `Duplicate` | READY | `GET` then `POST /api/v1/offers` | Client copies fields into a draft. |
| 19 | Create, edit practice | READY | `POST /api/v1/practices`, `PATCH /api/v1/practices/{id}` (`offers:manage`) | name, description, keywords, default playbook, brief template, sort. Lead missing (row above). |
| 19 | `Delete practice` ("Move or delete its offers first") | READY | `POST /api/v1/practices/{id}:archive` | Archive only; blocks only while approved offers exist: 409 `practice-has-offers` "Retire or move its active offers first.". Decision 15. |
| 19 | Initial message with Copy | READY (API R2c-1; UI R2c-2) | `GET /api/v1/offers/{id}/playbooks` `first_email {subject, body}` | Read-only: the first email step of the tier's playbook. The offer form drops the field. |
| 19 | Seller guide: talking points, objections, avoid | LATER (R2) | none | Tagged R2 in screens.md. |
| 19 | Playbook by tier, "{n} steps over {d} days", "{x}% book a meeting" | READY (API R2c-1; UI R2c-2); rate LATER (R3) | `GET /api/v1/offers/{id}/playbooks`, `PUT /api/v1/offers/{id}/playbooks/{tier}` (`offers:manage` or `playbooks:manage`) | `{tier, playbook {id, name, status, steps, days} or null, first_email}` for act_now, good_fit, watch. Decision 25. |

### Proposed changes

1. `GET /api/v1/offers/stats` (`offers:read`, data-limited): `{data:[{offer_id, practice_id, matched, won, win_rate}]}`.
2. `DELETE /api/v1/offers/{id}` (`offers:manage`): 204, or 409 `offer-has-history`.
3. `POST /api/v1/offers/{id}:unapprove` (`offers:manage`): approved to draft, clears approver, publishes
   `offers.offer.changed`.
4. `:approve` permission per Decision 15 (recommended `offers:manage`).
5. Offer fields `price_model` (`fixed|starting_at|per_month|custom`), `length_weeks`, `key_offer`,
   `why_us`, `why_now` in create, patch and read (Decision 16).
6. Practice `lead_user_id` in create and patch; read returns `lead_name`, `offer_count`; add
   `GET /api/v1/practices/{id}`.

### Release

R1: items 1 to 6. R2: seller guide, initial message, playbook by tier. R3: attributed win rate.

## integrations

Files: `src/app/t/[tenant]/settings/integrations/{page,actions}.tsx` (server side only); services in
`src/modules/integrations` (`providers.ts`, `listConnections`, `saveCredential`, `testConnection`,
`setMode`, `setDisabled`, `recentCalls`). Nothing under `/api/v1` serves integrations. Permission
`integrations:manage` (owner only by default).

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 21b | List services: mode, status, hint, last call, calls today | SERVER ACTION ONLY | `GET /api/v1/integrations` | `listConnections(ctx)`: `{provider, name, mode, status, hint?, last_tested_at?, last_test_result?, last_error?, calls_today, last_call_at?}` for all 15 providers in `PROVIDERS` (R4 ones included): filter by `release`. |
| 21b | Group and "used for" text | SMALL GAP | `group`, `used_for` on each row | `Provider.usedFor` exists but `ConnectionView` drops it; `group` from `interfaceOwner`. "Google Workspace" is not a provider; Microsoft sign-in is env config, not a tenant connection. |
| 21b | Summary "n of m working" with a sentence per issue | SMALL GAP | `summary` in the list response | From `status` and scrubbed `last_error` (`scrubError`). |
| 21b | Last call time | READY | `last_call_at` in the list | Once the list route exists. |
| 21b | Save credential, `Save and test` | SERVER ACTION ONLY | `PUT /api/v1/integrations/{provider}/credential` `{kind, value}` -> `{hint}` | `saveCredential`; audited; `validation`, `master-key-missing`. No "too short" rule (only empty). HubSpot has two kinds (`private_app_token`, `client_secret`): one field per kind. |
| 21b | Test connection with round-trip time and scopes | SMALL GAP | `POST /api/v1/integrations/{provider}:test` -> `{ok, message, missing_permissions?, facts?, duration_ms}` | `testConnection` returns `TestResult`; the duration is measured but only put on the `connection.tested` event. |
| 21b | Mode switch live or sample | SERVER ACTION ONLY | `PUT /api/v1/integrations/{provider}/mode` `{mode}` | `setMode`: 409 `test-first` (passing test in the last 10 min), `sample-data-only` (`config.forceMock`), `live-unavailable`. Show the titles. |
| 21b | Turn off or on | SERVER ACTION ONLY | `PUT /api/v1/integrations/{provider}/disabled` `{disabled}` | `setDisabled`. In the old page, not in the mockup: keep or drop. |
| 21b | Disconnect ("switched to sample data") | NEW ENDPOINT | `DELETE /api/v1/integrations/{provider}/credential` | No service: credentials are only replaced. Add `disconnect(ctx, provider)`: mark credential replaced, clear `credential_id`, mode `mock`, status `not_set_up`, audit, publish `connection.changed`. |
| 21b | "Connected by {name} on {date}" | SMALL GAP | `connected_by`, `connected_at` | `connection.created_by` (id) and `credential.created_at`; join the name. |
| 21b | Tiles calls today, errors today, response average | SMALL GAP | `GET /api/v1/integrations/{provider}` -> `usage{calls_today, errors_today, avg_ms}` | `call_log` has `outcome`, `duration_ms`, `at`; only `calls_today` is aggregated. |
| 21b | Last 50 calls with Errors only | SERVER ACTION ONLY | `GET /api/v1/integrations/{provider}/calls?outcome=&limit=50` | `recentCalls(ctx, provider, limit)` (max 200): `{id, at, operation, outcome, status_code, duration_ms, error_message}`. `operation` is e.g. `hubspot.test`, not method and path (redacted `request_summary` is not selected). Add the `outcome` filter. |
| 21b | "Calls today (n of cap/day)" | READY (R2b-1) | `calls_today_cap` on each list row | Set only for a daily calls limit (HubSpot); other rows show the count alone. |
| 21b | Usage limits: banner and Usage limit section | READY (R2b-1) | `cap` (or null) on each service: `{provider_key, unit, period, limit, used, reserved, level, resets_at, overage}` | Level `ok`, `warn`, `blocked`. Defaults are read in memory until first stored. |
| 21b | Save limit | READY (R2b-1) | `PUT /api/v1/integrations/{key}/cap` `{limit}` -> the cap (`integrations:manage`, people only) | Whole number of 1 or more, else 400 at `limit`; 404 for a service with no limit; audited `integrations.cap.set`. |
| 21b | `Allow until {date}` | READY (R2b-1) | `POST /api/v1/integrations/{key}/cap:allow-overage` -> the cap (`integrations:manage`, people only) | Audited `integrations.cap.overage`. Route file is `[key]/[cap]/route.ts`. |
| 21b | Apollo, Vibe live | READY for Apollo (R2b-2); LATER for Vibe | none | Apollo has a live adapter. Vibe is sample data only (enrichment Ruling 2), so going live keeps `live-unavailable`. |
| 21b | Company website row | READY (R2b-2) | `needs_credential: false` on the `website` service | No credential field; it goes live with no key. Test connection: "Ready to read company websites. No key is needed." |
| 21b | Google Workspace row | LATER (unscheduled) | none | No provider. |

### Proposed changes

1. `GET /api/v1/integrations` with `group`, `used_for`, `connected_by`, `connected_at`, `summary`;
   filter out providers not in a shipped release.
2. `GET /api/v1/integrations/{provider}` with `usage{calls_today, errors_today, avg_ms}`.
3. `PUT /api/v1/integrations/{provider}/credential`, `DELETE /api/v1/integrations/{provider}/credential`
   (new `disconnect` service).
4. `POST /api/v1/integrations/{provider}:test` returning `duration_ms`.
5. `PUT /api/v1/integrations/{provider}/mode`, `PUT /api/v1/integrations/{provider}/disabled`.
6. `GET /api/v1/integrations/{provider}/calls?outcome=&limit=`.
7. R1d: `calls_today_cap`.

All under `integrations:manage`, people only for writes.

### Release

R1: items 1 to 6. R1d: caps, Apollo and Vibe live. Later: Google Workspace.

## enrichment

Files: `src/modules/enrichment` (`services/requests.ts`, `services/run.ts`, `domain/*`), routes
`src/http/routes/v1/accounts/[id]/enrichment-requests`, `accounts/[id]/enrichment-estimate`,
`enrichment-requests` and `enrichment-requests/[id]`. Built in R2b-2 (plan
docs/plans/2026-11-03-r2b-2-enrichment.md); behaviour in enrichment/requests-and-approval.md.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 3, 4, 4c | `Enrich`: create a request | READY (R2b-2) | `POST /api/v1/accounts/{id}/enrichment-requests` `{kind, provider_key, roles?, person_ids?, reason?}` (`enrichment:request`) | 201 `approved` for a person with `enrichment:approve`, else 201 `flagged`; 200 `joined: true` for an open request of the same kind. 400 at `reason` "Say why this is worth the spend." when it would be flagged. |
| 4c | Estimate line | READY (R2b-2) | `GET /api/v1/accounts/{id}/enrichment-estimate?kind=&provider_key=&roles=a,b&person_ids=` (`enrichment:request`) | `{credits, cost_cents, currency, sample, text}`; show `text`. |
| 4c | Buying roles, people without an email | READY | `GET /api/v1/buying-roles`, `GET /api/v1/accounts/{id}` `people[]` | Roles with no person are checked to start with. |
| 4 | Enrichment notice under the card | READY (R2b-2) | `GET /api/v1/enrichment-requests?account_id=` | Each item has `kind_label`, `provider_name`, `status_text`; refresh every 10 s while one is `approved` or `running`. |
| 8a | Requests list, Waiting and All tabs | READY (R2b-2) | `GET /api/v1/enrichment-requests?status=flagged&cursor=` (`enrichment:request`) | `{data, next_cursor}`, newest first, within data limits; `limit` up to 200. An empty `?status=` is 400. |
| 8a | `Approve` | READY (R2b-2) | `POST /api/v1/enrichment-requests/{id}:approve` (`enrichment:approve`, people only) | 202 with the request; 403 "Only a person can approve spend." for a key; 409 "This request is already {status}." |
| 8a | `Decline` | READY (R2b-2) | `POST /api/v1/enrichment-requests/{id}:decline` `{reason}` (`enrichment:approve`, people only) | 400 "Say why you're declining."; records `enrichment_declined` feedback for the requesting source. |
| none | Cancel | READY (R2b-2), no button yet | `POST /api/v1/enrichment-requests/{id}:cancel` (`enrichment:approve`, or the requester) | From `flagged` or `approved`. |
| 4 | "Waiting on enrichment" status | LATER | none | Deferred (enrichment Ruling 14). |
| 21 | Prices per operation (`provider_price`) | LATER | none | Credits are code constants; money per credit is the connection's `cents_per_credit` setting (default 10). |

## ai-tasks

Files: `src/app/t/[tenant]/settings/ai/page.tsx` (tenant page, `settings:manage`); services
`listRuns`, `getRun`, `runTotalsThisMonth` over `ai.ai_run` (RLS); `src/lib/redact-text.ts`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 23 | Cross-tenant run list: run, status, task and account, tenant and model, tokens, cost, time, when | NEW ENDPOINT | `GET /api/v1/admin/ai-runs?status=&task=&tenant=&q=&cursor=` (`adminRoute`) | Only a tenant-scoped `listRuns(ctx,{task, status, mode, from, to, limit})` (limit max 1,000, no cursor). Needs an `adminDb` query, tenant name join, cursor. Row: `id, task, prompt_version, mode, model, status, input_tokens, output_tokens, cost_cents, duration_ms, created_at, input_ref{subject}`. |
| 23 | Status filter Succeeded, Failed, Retried, Running | SMALL GAP | map in the API | Backend `ok`, `invalid_output`, `error`, `refused_by_cap`; rows written at completion (no running), no retry link. Map ok = Succeeded, error and invalid_output = Failed, refused_by_cap = Stopped by limit. Decision 24. |
| 23 | Tiles runs today, failed % (target 3%), median time (slowest task), spend today | NEW ENDPOINT | `summary` in the list response | Aggregates over today (UTC). No daily AI cap (only `max_cost_cents_per_run` in `ai_setting`): drop "of the daily cap" or add a setting. |
| 23 | Banner "{n} failed in the last hour", Show them | NEW ENDPOINT | `summary.failed_last_hour` | |
| 23 | Search by run, account or task | NEW ENDPOINT | `q` | Account = `input_ref->subject->id`. |
| 23 | Tenant filter | NEW ENDPOINT | `tenant` + `GET /api/v1/admin/tenants` | |
| 23 | Expand: what Scout sent, what came back, error | SMALL GAP | `GET /api/v1/admin/ai-runs/{id}` | `getRun` exists (tenant). Input is not stored (only subject and `input_hash`), so "What Scout sent" shows subject and fingerprint. `output`, `error` stored. Redact server side (`redactPersonalText`). |
| 23 | Retry run | LATER (unscheduled) | `POST /api/v1/admin/ai-runs/{id}:retry` | No service; input not persisted; tasks are code-registered (`defineTask`). Decision 24. |
| 23 | Tenant owner view (old settings page) | SERVER ACTION ONLY | `GET /api/v1/ai-runs` (`settings:manage`) | Spec retires it with no replacement; a thin wrapper over `listRuns` and `runTotalsThisMonth`. Decision 24. |

### Proposed changes

1. `GET /api/v1/admin/ai-runs` (`adminRoute`) with `status` mapping, `task`, `tenant`, `q`, cursor, and
   `summary{runs_today, failed_pct, median_ms, slowest_task, spend_today_cents, failed_last_hour}`.
2. `GET /api/v1/admin/ai-runs/{id}` with redacted subject, output, error.
3. `GET /api/v1/ai-runs` (`settings:manage`) for tenant owners, if kept.
4. Later: daily cap setting, retry.

### Release

R1: items 1 to 3. Later: retry, daily cap.

## platform

Files: `src/platform/{dead-jobs,scheduler,health,relay,diagnostics,audit}.ts`;
`src/app/admin/system/page.tsx` and its actions (server side); `src/app/t/[tenant]/settings/audit` (old page).

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 21g | Audit log list: when, who, area, what happened, IP | SERVER ACTION ONLY | `GET /api/v1/audit?area=&actor_id=&q=&from=&to=&cursor=&limit=` (`audit:read`) | `listAudit(ctx,{actorId, apiKeyId, sourceId, subjectId, from, to, cursor, limit<=200})`; opaque base64 cursor (`invalid-cursor` 400). Row: `id, at, actor_kind, actor_id, source_id, api_key_id, support_access, action, subject_type, subject_id, correlation_id, ip, before, after`. Owner only (leader lacks `audit:read`). |
| 21g | "Who" as a name | SMALL GAP | join `tenancy.user.name`, `api_key.name` | Ids only today. |
| 21g | Area chip and filter | SMALL GAP | `area` derived from the `action` prefix | Actions are `module.entity.verb` (`tenancy.member.*`, `tenancy.api_key.*`, `integrations.*`, `accounts.exclusion_*`, `offers.*`, `crm.property_setup`, `intake.arrival.skip`). Tenant events go to `t_platform` and are invisible to a tenant owner. |
| 21g | "What happened" text and detail | SMALL GAP | server-side `summary` per action | Raw `before` and `after` JSON today (already redacted). |
| 21g | Search | SMALL GAP | `q` | Not in `listAudit`. |
| 21g | IP address | SMALL GAP | pass `x-forwarded-for` into the audit context | `audit.ip` is never filled (no caller passes `ip`). |
| 21g | Export CSV | NEW ENDPOINT | `GET /api/v1/audit?format=csv` | Streaming for large exports. |
| 21g | Sign-ins in the audit log | LATER (unscheduled) | none | Not recorded. Decision 20. |
| 21g | "Kept 2 years", immutable | LATER (unscheduled) | none | No retention job; immutability is by convention (no update or delete code), not DB grants. |
| 24 | Whole page data | SERVER ACTION ONLY | `GET /api/v1/admin/health` (`adminRoute`) | `systemHealth()` + `listDeadJobs({limit:100})`. `{relay_lag_ms, consumers[{name, pending, ack_pending}], consumers_available, dead_jobs, schedules[]}`. NATS calls time out at 2 s each; a 15 s poll is fine. |
| 24 | Relay lag tile | SERVER ACTION ONLY | `relay_lag_ms` | Old thresholds: over 5 s slow, over 30 s stuck. |
| 24 | Dead jobs tile | SERVER ACTION ONLY | `dead_jobs` | |
| 24 | Pending work per queue with oldest age | SMALL GAP | `queues[{name, pending, ack_pending, oldest_age_ms}]` | No age today: from JetStream consumer info or the oldest unsent `outbox` row. Names are NATS consumer names. `consumers_available=false` needs a UI state. |
| 24 | AI spend today tile | SMALL GAP | `ai_spend_today_cents` (sum over `ai_run` via `adminDb`) | No daily cap exists. |
| 24 | Dead jobs list: id, queue, tenant, when, error | SERVER ACTION ONLY | `dead_jobs[{id, tenant_id, tenant_name, name, last_error, attempts, dead_at}]` | `listDeadJobs`; errors scrubbed on write. Add tenant name; cursor past 100. |
| 24 | Retry dead job | SERVER ACTION ONLY | `POST /api/v1/admin/dead-jobs/{id}:retry` -> `{sent_id, name}` | `retryDeadJob`; 404 `not-found`; audited `platform.dead_job.retried`. |
| 24 | Discard dead job | SERVER ACTION ONLY | `POST /api/v1/admin/dead-jobs/{id}:discard` | `discardDeadJob`; audited. |
| 24 | Schedules: name, cadence, next run | SERVER ACTION ONLY | `schedules[{id, tenant_id, job_name, cron, timezone, enabled, next_run_at, last_run_at}]` | Humanise the cron server side (C8). |
| 24 | Schedule last result | SMALL GAP | `last_result` written by the job runner | No column today. |
| 24 | Pause, Resume schedule | SERVER ACTION ONLY | `POST /api/v1/admin/schedules/{id}:pause`, `:resume` | Resume recomputes next run. |
| 24 | Run now | SERVER ACTION ONLY | `POST /api/v1/admin/schedules/{id}:run-now` -> `{job_id}` | The action imports `@/entry/registry`; the new server must load job definitions too. |
| 24 | Send test event | SERVER ACTION ONLY | `POST /api/v1/admin/health:test-event` -> `{round_trip_ms}` | `sendPing` under `withTenant(PLATFORM_TENANT)`, polls `pingResult` up to 10 s. Alternative 202 `{id}` + `GET /api/v1/admin/health/test-event/{id}`. Covers outbox, relay, NATS, worker, db; not webhooks. |
| 24 | Refresh every 15 s | READY | client | Old page used 30 s. |

### Proposed changes

1. `GET /api/v1/admin/health` with `relay_lag_ms`, `queues[]` (with `oldest_age_ms`), `consumers_available`,
   `dead_jobs[]` (with `tenant_name`), `schedules[]` (with humanised cadence and `last_result`),
   `ai_spend_today_cents`.
2. `POST /api/v1/admin/dead-jobs/{id}:retry`, `:discard`.
3. `POST /api/v1/admin/schedules/{id}:pause`, `:resume`, `:run-now`.
4. `POST /api/v1/admin/health:test-event`.
5. `GET /api/v1/audit` (`audit:read`) with `area`, `q`, names, `summary`; `format=csv`; IP captured from
   `v1Route`.
6. Later: audit retention, sign-in events.

### Release

R1: items 1 to 5. Later: audit retention and sign-ins (Decision 20).

## playbooks

R1 module: the account brief and the handoff package (Playbooks minimum). Spec `docs/spec/playbooks/index.md` (PLB), `playbook-templates.md`
(PLB-E1, R2), `account-plans.md` (PLB-E2, R2), `outcomes-and-what-worked.md` (PLB-E6, R3). R2c-1 built the templates, offer
playbooks, plans and lists API (rows below); the screens are R2c-2, the account page, CRM tasks and stop rule R2c-3. Drafts only: nothing is sent
automatically (user, 2026-11-02). The R1 items are built: the brief endpoints below and `HandoffPackageProvider` (registered in `src/entry/compose.ts`).
Permissions `playbooks:read`, `playbooks:write`, `playbooks:manage` exist (leader, operator and owner
hold manage; sellers hold read and write).

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 4a | Scout's recommendation, Brief (Overview, Approach, Value angle, Risks, Edit); review record brief (§4b) | READY | `GET /api/v1/accounts/{id}/brief` (`playbooks:read`), `PUT /api/v1/accounts/{id}/brief/sections/{key}`, `POST /api/v1/accounts/{id}:draft-brief` (`playbooks:write`) | Each piece has `written_by` and `label`; sections `version` for `if_version`. Decision 7. |
| 6 | Playbook cards in the assign dialog | READY (API R2c-1; UI R2c-2) | `GET /api/v1/accounts/{id}/playbook-suggestion` (`assign:act`); `playbook_id` on `:assign` and bulk assign | `{playbook {id, name, steps, days} or null, reason offer_tier or none, offer, tier}`. Preselected; change it or pick "No playbook" (`playbook_id: null`). |
| 7 | Playbook name, next step, due | READY (API R2c-1; UI R2c-2) | `playbook_name`, `next_step` on `GET /api/v1/assignments`, `GET /api/v1/accounts`; counts on `GET /api/v1/me/counts` | See the row under screen 7 above. |
| 4 | Playbook on the account page: plan, steps, history, tick off | READY (API R2c-1; UI R2c-3) | `GET /api/v1/accounts/{id}/plan` (`playbooks:read`), `PATCH /api/v1/plans/{id}/steps/{step_id}`, `POST /api/v1/plans/{id}:pause`, `:resume`, `:complete`, `:abandon` (`playbooks:write`) | Plan has `playbook {id, name, version}`, `newer_version`, `day`, `days`, `steps[]`, `history[]`. Customising a plan, CRM tasks and the stop rule are R2c-3. |
| 20 | List: name, description, status | READY (API R2c-1; UI R2c-2) | `GET /api/v1/playbooks` | `status` draft, active or archived; also `stop_when`, `version`. No scope or motion. |
| 20 | "{n} steps over {d} days", channel mix | READY (API R2c-1; UI R2c-2) | `GET /api/v1/playbooks` `steps` (count), `days`, `channels` (count per channel) | Steps have `day` and `channel` (email, linkedin, call, meeting, task). Decision 25. |
| 20 | Runs on, tier chips, Assign dialog, "Replaces {x}" | READY (API R2c-1; UI R2c-2) | `runs_on [{offer_id, tier}]` on the list; `PUT /api/v1/offers/{id}/playbooks/{tier}` | `offer_playbook(offer_id, tier, template_id)`. An archived template is refused (400 "That playbook isn't available."). Decision 25. |
| 20 | Running, Finished, Replied, Booked, Won, reply rate, meeting rate | Running READY (R2c-1); the rest LATER (R3) | `running` on the list | Running is the count of active plans; the rest needs outcomes (PLB-E6). |
| 20 | Steps: day, channel, title, detail, who | READY (API R2c-1; UI R2c-2) | `GET /api/v1/playbooks/{id}` (`?version=`) | `owner_role` (seller, leader, operator) is "who". |
| 20 | Tags "Draft ready for AE", "HubSpot task" | READY (API R2c-1; UI R2c-2) | step `channel` and `crm_task` | "Sends automatically" is gone: drafts only (Decision 25 note). |
| 20 | Rules: starts, stops, pauses | READY (API R2c-1; UI R2c-2); stop rule enforced R2c-3 | `stop_when` (`reply_or_meeting`, `meeting`, `never`) | Starts when accepted. Pauses when the accepted assignment is withdrawn. Stored in R2c-1, acted on in R2c-3. |
| 20 | Create, edit, reorder steps | READY (API R2c-1; UI R2c-2) | `POST /api/v1/playbooks`, `PATCH /api/v1/playbooks/{id}` (`playbooks:manage`) | Template `version` bumps on a step change to an active template; plans keep theirs (matches the screen). |
| 20 | Duplicate, Retire, Delete | READY (API R2c-1; UI R2c-2) | `POST /api/v1/playbooks/{id}:duplicate`, `:archive`, `DELETE /api/v1/playbooks/{id}` | Delete is refused (409 "This playbook has run on accounts. Retire it instead.") once a plan used it or an offer maps it. |

### Proposed changes

1. R1: `HandoffPackageProvider` per the release plan (feeds the brief and the handoff).
2. R2 plan (built in R2c-1): `offer_playbook(offer_id, tier, template_id)` and
   `PUT /api/v1/offers/{id}/playbooks/{tier}`; list fields `steps, days, channels, runs_on, running`;
   `stop_when`; day granularity; `POST /api/v1/playbooks/{id}:duplicate`, `:archive`. No draft or
   auto-send field: drafts only.
3. R3: Running and rates; C9 empty states until then.

### Release

R1: `HandoffPackageProvider` only. R2: the module and the §20 screen. R3: outcomes and rates.

## analytics (not built)

No module code, no routes. Spec `docs/spec/analytics/`: funnel, costs, source performance, flywheel R3;
weekly scorecard R4 (account rows R3). Fixed API (`index.md`): `GET /api/v1/analytics/funnel?by=source|practice|offer&from&to`,
`GET /api/v1/costs?from&to&source_id` (`analytics:read`), `POST /api/v1/costs` (`costs:write`). Proposed in
that spec: `POST /api/v1/costs/{id}:void`, `GET /api/v1/analytics/sources/{id}/performance`,
`GET /api/v1/analytics/flywheel`, `GET /api/v1/analytics/scorecard`.

| Screen § | Need | Status | Endpoint / proposed | Notes |
|---|---|---|---|---|
| 9 | "{count} of {target}", pace, "Where we should be today" | LATER (R3) | none | Needs `analytics.scorecard_target`. Show counts only (routing `GET /api/v1/stages/summary`). |
| 9 | Value at Opportunity and Won; Pipeline value, Won value tiles | LATER (R3) | none | Deal `amount_cents` is in crm tables, not exposed; won value is on the journey. |
| 9 | Sent to Won, Days to win | LATER (R3) | none | `stage_change` could give median arrived-to-won earlier; optional extra on the stages summary. |
| 9 | KPI tiles, scorecard tabs by seller, offer, practice; detail drawer | LATER (R3) | `GET /api/v1/analytics/scorecard`, `GET /api/v1/analytics/metrics/{key}` | By seller needs assignments (routing), meetings (`crm.activity`; `campaigns.meeting.held` is R4), steps on time (playbooks R2). The drawer is not in the analytics spec. |
| 11 | Cost per win per source | LATER (R3) | funnel by source | |
| 16 | Per-source stage counts, "{x}% from previous · {cost} per account" | LATER (R3) | `GET /api/v1/analytics/funnel?by=source` | `analytics.account_journey` + `source_touch` from `routing.stage.changed` (recorded since R1; replay covers history). |
| 16 | Filters practice, offer, batch, period | LATER (R3) | add `practice_id`, `offer_id`, `batch_id` | The journey has `practice_id`, `offer_id`, `first_batch_id`. Period presets are client date math. |
| 16 | Tiles sent, won, spend, cost per won and target | LATER (R3) | funnel `totals` | Needs `totals` and a `target_cost_per_won_cents` setting (none in the spec). |
| 16 | Cost colour, "Not enough data", "No wins yet", win-rate bar | LATER (R3) | funnel row `status` | `min_sample` exists only on `scorecard_target`. |
| 17 | Stage table, tiles, rank "i of n", previous and next, insight, batches, won accounts | LATER (R3) | `GET /api/v1/analytics/sources/{id}/performance` | Spec returns funnel, declines, trust trend. Missing: all-sources baseline, rank, prev and next ids, insight text ("Too early to judge." under 10 sent), batch list, won accounts (name, offer, value). |
| 17 | `Open source page`, batch click | READY | `GET /api/v1/sources/{id}` (proposed in intake), `GET /api/v1/batches/{id}` | Navigation only. |
| 18 | Tiles spend, cost per account sent, cost per won, return on spend | LATER (R3) | `GET /api/v1/costs` | Return from offer price vs actual `won_amount_cents`: Decision 26. |
| 18 | "Where the money goes" by category | LATER (R3) | `GET /api/v1/costs` with a stable category list | Ledger categories differ from the screen's. Decision 26. |
| 18 | Monthly spend vs budget; budgets used, left, over; edit and save | LATER (R3) | `GET/PUT /api/v1/costs/budgets` (read `analytics:read`, write `costs:write` or owner) | No budget model. 90% alert and 110% pause need alerting and integrations `checkCap` (R1d). Decision 26. |
| 18 | Cost by source table | LATER (R3) | `GET /api/v1/costs?group_by=source` | One grouped response, no browser math (C8). |

### Proposed changes

1. Funnel: `practice_id`, `offer_id`, `batch_id` filters; `totals`, per-row cost, colour `status`, `target`.
2. Source performance: baseline, rank, prev and next, insight, batches, won accounts.
3. Costs: `group_by`, category map, `GET/PUT /api/v1/costs/budgets`, return on spend, alert and pause rules
   (Decision 26).
4. Scorecard and `GET /api/v1/analytics/metrics/{key}` for the drawer.
5. Permission names: use `analytics:read` and `costs:write` (Spec corrections).

### Release

All R3 (scorecard R4 apart from account rows). Overview stage counts ship in R1 from routing.

## Spec corrections

Facts in `index.md` and `screens.md` that are wrong given the backend and should change whatever the
decisions above say.

1. **Shell table, Results.** `costs:read` does not exist. Fix: Costs shown with `analytics:read`; §18
   "Who" `analytics:read`, budgets `costs:write` (held by owner, leader, operator) or owner only per
   Decision 26. Drop "`analytics:read` and `costs:read` are proposed": `analytics:read` exists and every
   role holds it (`COMMON`), so sellers see Overview, data-limited. **Applied.**
2. **§21d, §21e "Who" `review:configure`.** Does not exist. Fix: `settings:manage` (owner only by default). **Applied.**
3. **§21c "Who" `integrations:manage`.** API keys are `keys:manage` (owner only). Fix the §21c tag, and
   say §12 and §11 key actions run under `sources:manage` for that source's keys (Decision 14). **Applied.**
4. **Shell table, Offers and Playbooks.** Offers is shown with `offers:manage` but §19 says
   `offers:read`; leaders hold only `offers:read` and would lose the nav item. Playbooks is shown with
   `playbooks:manage` but §20 says `playbooks:read`. Fix both rows to the read permission. **Applied.**
5. **Shell table, Sources; §10, §11 "Who".** `GET /api/v1/sources` needs `arrivals:read`, not
   `sources:manage`; default roles hold both, a custom grant may not. Fix: "`sources:manage` and
   `arrivals:read`". **Applied.**
6. **§21a "Who" `members:manage`.** The list needs `members:read` (leader has it); edits need
   `members:manage`. Fix the tag. **Applied.**
7. **W6 "Operators see the Review queue".** The default operator has no `review:act` (it is grantable
   as an extra permission, `permissions.ts`), nor `assign:act`. Fix: "Operators granted `review:act`
   see the Review queue", or add `review:act` to the operator defaults (one line) and say so. **Applied.**
8. **Tier "Nurture" (§2, §21f).** Backend tiers are `act_now, good_fit, watch, not_fit`; `not_fit` also
   covers excluded and hard-miss accounts. Fix: "Not a fit", shown only when it has accounts. **Applied** (per Decision 21: "Not a fit" in today's model, "Nurture" after the scoring redesign; names from the API).
9. **Review status names (§2, §4).** Default statuses are Unvetted (initial), Needs review, Reviewed,
   Declined. "Ready for review" (the default filter in §2) is not one; "In HubSpot" is the handoff
   state, not a status; "Waiting on enrichment" is R2; "In review by {name}" is who set the current
   status (C13), not a status of its own. Fix the pill list and the default filter to real keys (or the
   seed renames of Decision 2). **Applied** (per Decision 2: names from the API, seeds renamed to the mockup's words).
10. **C5 "The backend validates a reason".** It validates a note for send back and a reason only for
    declines. Fix the rationale (and the rule itself per Decision 1). **Applied** (per Decision 1).
11. **"Act now tier starts at 75" (§4a) and one cutoff per tier (§21f).** Act now is three thresholds
    (fit 60, intent 35, total 60 by default) plus a research or trigger signal; Good fit is a fit
    threshold; below `not_fit_below` (40) is Not a fit. Fix the copy. **Applied** (per Decision 21: today's thresholds as the API words them; one cutoff per tier after the redesign).
12. **Five scores "/ 100" (§4a).** Only priority, fit and intent are scores. Revenue potential is an
    amount or band (R2); source trust is 0..1 and moves priority by at most 5 points. Fix the strip. **Applied** (per Decision 21).
13. **Import limit (§15).** "Up to 5,000 rows" and "over 5,000 rows" are wrong: `MAX_FILE_ROWS` is
    10,000 (`intake/import/parse.ts`), max 20 MB (413 above). Fix to 10,000 rows and 20 MB, show the
    API's error title, add the sheet picker step for multi-sheet workbooks, and note that `research`
    and `vibe` layouts skip Match and Confirm. **Applied.**
14. **Key mask (§11).** Keys are `scout_live_<32 base62>` or `scout_test_<32>`; no `sk_`; only the
    prefix (`scout_live_` plus 8 characters) is stored, no last 4. Fix: "scout_live_AbCd1234…". **Applied.**
15. **Assign toast "now in HubSpot" (§6, index.md Copy).** `:assign` returns 202; the push runs after
    with up to 6 attempts and can end `needs_decision` or `failed`. Fix: "Assigned to {AE}. Sending
    {account} to HubSpot." with the handoff state on the row and page. **Applied.**
16. **Accept toast "is yours in HubSpot" (§7).** Accept does not push; the push started at assign. Fix:
    "Accepted. {account} is in your accounts." and show the handoff state if it is not `in_crm`. **Applied.**
17. **"Scout adds {AE} as collaborator, leaves Rita owner" (§6).** `ownership_decision:'keep'` pushes
    and leaves the owner; no collaborator is added (no collaborator code in `crm`). Fix: "Scout sends
    the account and leaves Rita as owner." **Applied.**
18. **Assign dialog states (§6).** Add `blocked` (the AE has no HubSpot owner; link the member's CRM
    user id) and the 503 `crm_unavailable` state. **Applied.**
19. **Auto-accept (§4b, §7).** A pending assignment is accepted after N working days (default 2) or by
    a CRM reply or meeting (`accepted_how`). Add "Accepted automatically" copy; the New list can change
    without the AE. **Applied.**
20. **Queue default view (§2).** It holds only accounts with no open assignment (plus seller-declined
    ones). A newly assigned account leaves at once; "In HubSpot rows dimmed" and "In review by" rows
    show only under a status filter. Fix the description. **Applied.**
21. **Bulk limit (§2).** 50 accounts per bulk call; "select all visible" must cap at 50 and say so. **Applied.**
22. **Flags the spec lacks (§2, §4).** `declined_by_seller` (seller, reason, when), `new_from`,
    `handoff_needs_decision`, `handoff_failed`, and the "two HubSpot companies linked" conflict. Add chips
    and copy. **Applied.**
23. **`POST /api/v1/accounts/{id}:seen` (§7).** Missing: call it when the AE opens an account to clear "New
    from". **Applied.**
24. **Account page error "Batch B-1042 is still matching facts" (§4).** An unresolved arrival has no
    account, so the page is a 404. Drop the state. **Applied.**
25. **Account "kind" ("Public agency", §4).** Not a field; use `industry`. **Applied.**
26. **HubSpot sync description (§12).** "Pull companies with no owner, created in the last 30 days" is
    wrong. It polls contacts matching the tenant's qualified-lead rule (default `lifecyclestage =
    marketingqualifiedlead`) and submits each contact's company from the seeded `hubspot_qualified`
    source; the first poll looks back 30 days; only that source is polled. **Applied.**
27. **Batch item copy (§14).** "Rejected: Duplicate of an account already in review" is wrong: only
    `duplicate_in_batch` is rejected; a known company resolves as `attached` and keeps its review state;
    several candidates wait as `possible_duplicate`. **Applied.**
28. **Waiting reasons (§14, §15).** Three, not one: `needs_website`, `needs_company`,
    `possible_duplicate`, each with its own row UI (`:supply-website`, `:supply-company`, `:choose`).
    Waiting rows are auto-rejected after 30 days. **Applied.**
29. **"Resolved ... sent to review" (§14, §15).** A resolved arrival is not always queued (already
    assigned or declined accounts also resolve). Fix to "resolved"; give the queue count from
    `GET /api/v1/review-queue/count?batch_id=` where the viewer has `review:act`. **Applied.**
30. **Batch statuses (§13).** Stored statuses are `processing` and `completed`; Failed is the import's
    status; there is no per-row "error". State that the API derives the chip and the progress line. **Applied.**
31. **Trust (§10, §11).** Every source is 0.60 until R3 and there is no "Needs 10 reviewed" rule. Fix:
    "Not enough data yet" for all, Trust filter and legend hidden until R3. **Applied.**
32. **Slug rule (§22).** Backend `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`: dashes allowed, up to 40
    characters. Fix the spec's "3 to 24 letters or numbers". **Applied.**
33. **Tenant host (§22).** `.scout.taazaa.com` per tenant contradicts W7 (path-based tenant). Fix to
    `scout.taazaa.ai/t/<slug>`. **Applied.**
34. **Tenant creation (§22).** Creation is one synchronous transaction; the provisioning checklist is
    done at once and the 2 s polling in C14 does not apply. **Applied.** Superseded by D35: the
    workspace's database is made by a job after the tenant row, so the screen polls
    `workspace.status` (`provisioning` → `active`, or `failed` with Retry).
35. **Admin role (§21a matrix).** Platform admin is a user flag (W8) with every permission in every
    active tenant, always; it is not a role in a workspace matrix. Fix the matrix. **Applied.**
36. **System health (§24).** "Relay, queue and webhook all answered": the ping does not touch webhooks.
    Fix: "Relay, queue and worker all answered." **Applied.**
37. **AI runs statuses (§23).** Succeeded, Failed, Stopped by limit; no Running or Retried. **Applied.**
38. **Integrations (§21b).** Microsoft sign-in is environment config, not a tenant connection; "Google
    Workspace" is not a provider; "Last 50 calls" shows the operation name (e.g. `hubspot.test`), not
    method and path. **Applied.**
39. **Offer approval (§19).** Active needs deal size, sales cycle, a target title or role, and
    industries or size; the form must show the `errors[]` list from 400 `offer-incomplete`. Practice
    archive blocks only on approved offers. **Applied.**
40. **Rescore progress (§21f).** No progress in R1 (R2); the toast is "Rescoring started". **Applied.**
41. **Playbook steps (§20).** The playbooks spec is week-based (`week_offset`) with no tier mapping, stop
    rule or auto-send; align the screen or the playbooks spec before the R2 plan (Decision 25). **Applied** (per Decision 25: the screen stays, the playbooks spec changes).
42. **Dev sign-in path (index.md Backend changes).** `/api/dev/sign-in` sits outside `/api/auth` and
    `/api/v1`; list it so the proxy and the Hono server carry it. **Applied.**
43. **Landing tenant (index.md Shell).** "Last used tenant" needs `PUT /api/v1/me/workspace`;
    `user.last_tenant_id` is never written today. **Applied.**

## Open questions

Settled 2026-10-31. Item 8 follows the user's W6 answer; the rest are Claude's calls, marked so the
user can overturn them.

1. **Seed status names.** (Call) Unvetted becomes "Ready for review", Needs review becomes "In review"
   (set by a reviewer, shown as "In review by {name}", C13), Reviewed becomes "Approved", Declined
   becomes "Not pursued", plus the new "Sent back to source". "Waiting on enrichment" arrives with R2.
   "In HubSpot" is the handoff state chip, not a review status.
2. **Manual tier note.** (Call) Optional. The select saves on change; the change log records who and
   when.
3. **Lowest tier after the scoring redesign.** Answered (2026-11-01, SCO-E6): Nurture below the Watch cutoff; excluded accounts stay Not a fit.
4. **Revenue potential before R2.** Answered (2026-11-01, SCO-E6): computed now from the offer's deal size and company size.
5. **Scoring settings before the redesign.** Decided by the user (2026-10-31): the Scoring weights tab stays hidden until the scoring redesign lands.
6. **Remove source.** (Call) Remove is a soft delete: the source is archived and hidden from lists and
   pickers, its history kept. A source that has sent shows `Archive source` instead, which keeps it
   visible as archived.
7. **Best match with no cover.** (Call) No badge, as screens.md says.
8. **Operator default.** Decided by W6: `review:act` is added to the operator role's defaults.
9. **Sign-ins in the audit log.** (Call) Yes: sign-ins appear in Audit log under the Sign-in area as
   well as in Members > Login history, as the mockup says ("every sign-in").
10. **Login history location.** (Call) IP and "New IP" in R1; a geo-IP lookup can come later.
11. **Stage targets.** (Call) The target field ships with the pipeline stages plan, since the mockup
    edits it there; the pace and progress that use it come with R3 analytics.
12. **Budget permission.** (Call) `costs:write`, as screens.md says.
13. **Tenant owners' AI runs.** (Call) Settings > AI runs (`settings:manage`, screens.md §21h) shows
    the workspace's runs from `GET /api/v1/ai-runs` and `/api/v1/ai-runs/{id}`; the admin list stays cross-tenant.


The user approved the spec on 2026-10-31. Nothing in this section is open.
