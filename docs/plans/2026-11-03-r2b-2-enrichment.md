# R2b-2: enrichment requests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can enrich an account from the account page or the queue peek, after seeing an estimate. Leaders and owners run it at once. A seller's request, or an agent's, waits in an approval queue. Results land on the account through intake, with the provider as their source. Every outside call goes through the integrations gateway and its usage limits.

**Architecture:** A new `enrichment` module owns the `request` table, its statuses, the estimate, the run job and provider adapters:
- **Apollo:** live, ported from v1, plus a sample-data (mock) side.
- **Vibe:** sample data only, using v1's mapping.
- **Website:** a page fetcher plus the `read_website` AI task.

The run calls each provider operation through `gateway.call` with up-front credits. That way usage limits reserve, refuse and settle. A `blocked_by_cap` refusal makes the job wait. The run submits what it found as one inline, targeted arrival from the provider's vendor source.

Other modules change as follows:
- **Routing** keeps a small table of accounts with open requests, fed by enrichment events, for the queue chip.
- **Intake** gains single-source feedback, plus `email_status` and `seniority` on arrival people.
- **Integrations** gains a credential-less `website` provider and a way to mark a connection failing immediately.

The web UI gains an Enrich dialog, an enrichment notice on the account page, and an Enrichment requests screen.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest, React 19 + TanStack Router/Query, msw, Playwright.

**Spec:**
- `docs/spec/enrichment/index.md`
- `requests-and-approval.md` (ENR-E1)
- `credits-costs-and-caps.md` (ENR-E3, caps part)
- `results-and-failures.md` (ENR-E4)
- `providers-and-saved-searches.md` (ENR-E2-S1 providers only)
- `docs/spec/web-ui/screens.md` §2, §3, §4
- `docs/spec/mcp/agent-tools.md` (`flag_for_enrichment`)

Code map: `docs/plans/2026-11-03-r2b-2-enrichment.map.md`. Read its section 1 checklist and section 16 pitfalls before any task.

## Rulings (user answers 2026-11-03 marked; the rest are Claude's calls; Task 9 writes them into the specs)

1. **(User) Who runs what.**
   - A person with `enrichment:approve` (owners and leaders) who starts a request creates it `approved`, and it runs.
   - A person with only `enrichment:request` (sellers, operators) creates it `flagged`. It waits for approval.
   - An API key or OAuth grant always creates `flagged`.
   - Approve and decline are people only, with the 403 detail "Only a person can approve spend."
2. **(User) Vibe is sample data only.** The Vibe adapter registers only a mock side. It is built on v1's pure mapping from `reference/v1/src/integrations/prospects/vibe.ts` and `vibeExport.ts`, carried into `src/modules/enrichment/adapters/vibe/mapping.ts` with its v1 tests. Setting Vibe live keeps INT's existing 409 "This service can't run live yet." A live adapter is a follow-up, once there is a key and confirmed endpoints.
3. **(User) Website read is in.**
   - **Provider:** a new `website` provider (`name: 'Company website'`, `usedFor: 'Reads company websites'`, `interfaceOwner: 'enrichment'`, release R2). It needs no credential.
   - **Live adapter:** fetches the home page and up to 4 same-host linked pages whose path or link text matches `about|services|industries|contact`. It respects `robots.txt` (`User-agent: *` and `Scout` groups, `Disallow` prefixes), takes at most 30 seconds in total and 2 MB per page, and sends user agent `TaazaaScout/1.0 (+https://scout.taazaa.ai/bot)`.
   - **Mock adapter:** returns two fixed sample pages for any domain.
   - **Reading:** the pages go to AI task `read_website`. Its output is `{description, industry_guess, size_clues[], technologies[], facts:[{key, value, url}]}`, with every item citing a page URL. The task has `rules`: the title and meta description, technologies from a fixed fingerprint list in the HTML, and no industry guess. With Claude on mock, or at its limit, the rules output is used and labelled "Read by rules". A website read uses 0 credits; its Claude cost goes through `anthropic` as today.
4. **Kinds, operations and credits.** These are code constants in `domain/prices.ts`. The `provider_price` table and its Settings screen are deferred, and the spec records the divergence.

   | Kind | Apollo operations | Credits | Estimate |
   |---|---|---|---|
   | `company_firmographics` | `organizations/enrich` | 1 | 1 |
   | `people_for_roles` | `mixed_people/api_search` (0), then `people/match` per person | 1 per person found | roles × 3 |
   | `email_reveal` | `people/match` per named person | 1 | number of people |
   | `signals_refresh` | `organizations/{id}/job_postings` + `news_articles/search` | 1 + 1 | 2 |
   | `website_read` | `website.read` | 0 | 0 credits; Claude worst case in cents |

   Vibe uses the same kinds and credits in sample data.
5. **Money on estimates.** Money is `credits × cents_per_credit`. `cents_per_credit` comes from the connection's settings when set; otherwise the defaults are apollo 10 and vibe 10. Currency comes from `tenantSummary`.
   - Copy: "Up to {n} credits, about {money}", or "Up to 1 credit, about $0.10".
   - With 0 credits: "Free. Claude usage up to {money}" (website).
   - On mock, append " · Sample".
6. **Duplicates.** A second request of the same kind for the same account, while one is `flagged`, `approved` or `running`, joins it. The requester's principal id is added to `watchers`, and the API returns the open request with 200 and `joined: true`. If the joiner may approve and the open request is `flagged`, joining also approves it.
7. **Statuses.** `flagged` → `approved` | `declined` | `cancelled`. Then `approved` → `running` | `cancelled`, and `running` → `completed` | `partial` | `failed`. `partial` is a completed run that stopped early and kept what it found. `waiting_reason` (text, null) is set while an approved request waits on a usage limit, and cleared when it runs.
   - **Cancel:** `:cancel` is allowed from `flagged` or `approved`. It needs `enrichment:approve`, or the requester themselves.
   - **Expiry:** a request `flagged` for 14 days becomes `cancelled` with `decline_reason: 'expired'`. The job is `enrichment.request.expire` and runs daily at `0 4 * * *` UTC. Its schedule is upserted (idempotently) whenever a request is created, so existing workspaces need no back-fill.
8. **The run.** Approving enqueues job `enrichment.request.run {requestId}` in the same transaction, and publishes `enrichment.request.approved`. The job:
   1. **Checks limits.** It calls `checkCap(estimate)`. When blocked, it writes `waiting_reason` "Waiting for budget: {Provider} monthly limit reached" in its own committed transaction (`withTenant`), then throws the `blocked_by_cap` error, and the worker waits. When the limit allows, it clears `waiting_reason` and sets `running` and `started_at`, both committed.
   2. **Calls the provider.** It runs the kind's operations, one `gateway.call(ctx, provider, op, fn, {module: 'enrichment', unit: 'credits', units: <worst case for this call>, measure: (r) => ({units: r.creditsUsed}), requestSummary: {requestId, accountId}})` per operation.
   3. **Submits the results.** It sends one `submitArrival(sendingCtx, body, {channel: 'enrichment', inline: true, vendorSourceId})` with:
      - `target_account_id`;
      - `account.external_ref = requestId`, so a retry is a duplicate;
      - `account.notes = "Requested by {requester name}"`;
      - `sendingCtx = {...ctx, actor: {kind: 'system', id: 'enrichment'}, access: {sourceId: vendor.id, dataLimit: {kind: 'all'}}}`.

      The vendor source is found by `settings.key`. `website` is ensured lazily through a new intake `ensureVendorSource`.
   4. **Finishes.** It sets `completed` with `result {arrival_ids, credits_used, cost_cents, found}`, where found = people + signals + facts added. With nothing found, the message reads "{Provider} found no one for {role labels}" for people kinds, or "{Provider} found nothing new" otherwise. Then it publishes `enrichment.request.completed`.
9. **Errors.** `domain/errors.ts` classifies them as follows. Partial results are always submitted before the final status.

   | Kind | Detected by | Handling |
   |---|---|---|
   | `cap_reached` | `isCapWait(e)` | Before any result: rethrow, so the job waits. After some results: submit them, mark `partial` with message "Stopped at the {Provider} monthly limit." |
   | `auth` | status 401 | Fail now. Call the new INT `markConnectionFailing(ctx, provider, message)`. Message "{Provider} rejected the key. An owner needs to update it in Integrations." |
   | `out_of_credits` | `/insufficient credits/i` or Apollo's credits error | Submit what was found, mark `partial`, message "{Provider} is out of credits." |
   | `rate_limited` | `RateLimitedError` or 429 | Rethrow for the job backoff. Every try counts; the spec's "3 free tries" is a recorded divergence. |
   | `timeout` | abort or timeout | Rethrow for the job backoff. |
   | `bad_request` | 400 or 422 | Fail with the provider's message, no retry. |
   | `unknown` | anything else | Rethrow. After the last try the job dead-letters. The request stays `running` with message "Something went wrong. Try again."; dead-job handling is PLT's. |

   A failure sets `failed` with `error {kind, message}` and publishes `enrichment.request.failed`. Failing is "write state and return normally", never a throw.
10. **Feedback.**
    - **Decline:** a decline of a request with a `requesting_source_id` records `enrichment_declined` feedback for that one source, through a new intake `recordSourceFeedback`.
    - **Expiry:** an expiry records the new kind `enrichment_expired`, labelled "Enrichment request expired".
    - **No arrival yet:** when the source has no resolved arrival for the account, `recordSourceFeedback` stores the row with a null `arrival_id`. The migration makes the column nullable.
11. **Queue chip.** Routing gets table `routing.enrichment_open (tenant_id, account_id, request_id, requested_by_label, PK tenant+request)`.
    - A routing consumer inserts a row on `flagged` or `approved`, and deletes it on `declined`, `completed`, `failed` or a cancel. Cancel is its own event, `enrichment.request.cancelled {requestId, accountId, reason}`.
    - `QueueRow.enrichmentRequested` = a row exists for the account.
    - The chip text stays "Enrichment requested". The peek shows "Enrichment requested by {label}". The "Waiting on enrichment" review status is deferred.
12. **Arrival people** gain optional `email_status` (`verified|guessed|unavailable|bounced`, the accounts fact values) and `seniority` (string ≤ 40). Intake writes them as the person facts `email_status` and `seniority`, with the arrival's provenance.
13. **No MCP server exists**, so `flag_for_enrichment` ships as the REST route only. The mapping from `what` to a kind is recorded in the spec for when the server is built; no code is written for it now.
14. **Deferred:**
    - saved searches (ENR-E2-S2);
    - `provider_price` and its Settings screen;
    - `integrations.usage.recorded` and ANL cost lines (R3a), so ENR-E3-S1-AC2 waits for R3a;
    - API-key enrichment credit limits (keys never spend; they only flag);
    - "Find" on committee gaps (R2b-3 wires it to this dialog);
    - the "Waiting on enrichment" review status;
    - owner email notices.

## Global Constraints

- **Request table** `enrichment.request`. Its columns match the spec index table plus `watchers text[] default '{}'`, `waiting_reason text`, `connection_mode text` (`mock|live`, set at run) and `requested_by_label text` (e.g. "Dana Ruiz", "Yasir's agent").
  - Statuses are a text check over Ruling 7. Kinds are a text check over Ruling 4.
  - Indexes: `(tenant_id, status, created_at)` and `(tenant_id, account_id)`.
  - Id prefix `enr`. Migration `0000_requests.sql` with RLS, and every place in map section 1's checklist.
- **Events** (`contracts/events.ts`, payloads as in the spec index): `enrichment.request.flagged`, `.approved`, `.declined`, `.cancelled` (new), `.completed`, `.failed`.
- **Jobs:**
  - `enrichment.request.run` (`maxDeliver: 5`, `timeoutMs: 120_000`, backoff `[30s, 2m, 10m, 1h]`);
  - `enrichment.request.expire`.
- **Routes:**
  - `POST /api/v1/accounts/{id}/enrichment-requests` creates a request. Body `{kind, provider_key, roles?: string[], person_ids?: string[], reason?: string ≤ 500}`; `reason` is required when the result would be `flagged`, with error "Say why this is worth the spend." Needs `enrichment:request`. Returns 201, or 200 when joined.
  - `GET /api/v1/accounts/{id}/enrichment-estimate?kind=&provider_key=&roles=a,b&person_ids=` returns `{credits, cost_cents, currency, sample: boolean, text}`. Needs `enrichment:request`.
  - `GET /api/v1/enrichment-requests?status=&account_id=&cursor=` returns `{data, next_cursor}`, within data limits. Needs `enrichment:request`.
  - `POST /api/v1/enrichment-requests/{id}:approve` (`enrichment:approve`, people only) returns 202 with the request.
  - `POST /api/v1/enrichment-requests/{id}:decline` (`enrichment:approve`, people only) takes `{reason}` (required, error "Say why you're declining.").
  - `POST /api/v1/enrichment-requests/{id}:cancel` (Ruling 7).

  Request JSON: `{id, account_id, account_name, kind, kind_label, provider_key, provider_name, status, status_text, requested_by_label, reason, estimate {credits, cost_cents, text}, created_at, decided_by_label, decided_at, decline_reason, result, error, waiting_reason, sample}`.
- **Kind labels:**

  | Kind | Label |
  |---|---|
  | `company_firmographics` | Company facts |
  | `people_for_roles` | People for buying roles |
  | `email_reveal` | Reveal emails |
  | `website_read` | Read the website |
  | `signals_refresh` | Fresh signals |
- **`status_text`:**

  | Status | Text |
  |---|---|
  | `flagged` | "Waiting for approval" |
  | `approved` | "Starting", or `waiting_reason` when set |
  | `running` | "Running" |
  | `completed` | "Found {n}", or the nothing-found message |
  | `partial` | "Found {n}. {message}" |
  | `failed` | `error.message` |
  | `declined` | "Declined: {reason}" |
  | `cancelled` | "Cancelled", or "Expired after 14 days" |
- **Enrich dialog copy (new screens.md §4b):**
  - Title "Enrich {account}". Field "What to find" lists the kind labels. Field "Provider": Apollo and Vibe Prospecting, or Company website for "Read the website".
  - For people kinds, "Buying roles" is a checkbox list from `GET /buying-roles`; it defaults to the roles with no person yet.
  - For "Reveal emails", "People" is a checkbox list of the account's people without an email.
  - The estimate line comes from the API.
  - When the request would be flagged, a "Why is this worth it?" textarea (required).
  - Button: `Run enrichment` for an approver, `Ask for approval` otherwise.
  - Toasts: "Enrichment started for {name}. New signals appear in about 2 minutes." (existing copy), or "Sent for approval. A leader will see it in Enrichment requests."
  - Joined: "Already requested. You'll see the results here too."
- **Account page notice under the card:** one line per open or recent (last 7 days) request: "{kind label} from {provider}: {status_text}". It refreshes every 10 seconds while any request is `approved` or `running`.
- **Enrichment requests screen (new screens.md §22):**
  - Route `/t/:tenant/enrichment`. Nav item "Enrichment" in the Work group, rule `{any: ['enrichment:approve', 'enrichment:request']}`.
  - Tabs "Waiting for approval" (status `flagged`) and "All".
  - Table columns: Account (link), What, Provider, Requested by, Reason, Estimate, Age ("3 days") or Status.
  - Approve and Decline only with `enrichment:approve`. Decline opens a dialog with "Why decline?" (required).
  - Toasts: "Approved. Enrichment started for {account}." and "Declined. {requester} will see your reason."
  - Empty: "Nothing waiting. Requests from sellers and agents show here for a leader to approve."
- **Peek drawer:** the `Enrich` button opens the same dialog.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A run that hits the Apollo monthly limit after finding some people.** The people found are kept as an arrival, the status is `partial` with the limit message, and no second arrival appears on redelivery. Test in Task 4.
2. **The same request redelivered after a crash mid-run** (job retried after the arrival was submitted). There is no duplicate arrival, thanks to `external_ref`, and the request completes once. Test in Task 4.
3. **A seller and an owner request the same kind for the same account.** One request exists; the owner's join approves it, and the seller is a watcher. Test in Task 2.
4. **An agent's key tries to approve.** 403 "Only a person can approve spend."; an agent sees only requests for accounts its source sent. Test in Task 6.
5. **A website whose `robots.txt` disallows `/about`.** That page is skipped, and the home page is still read. A site that times out fails as `timeout` and retries. Test in Task 3.

---

### Task 1: Module skeleton, request table, pure domain

**Files:**
- Create:
  - `src/modules/enrichment/{index.ts, db/schema.ts, db/migrations/0000_requests.sql (+meta), contracts/{events.ts, jobs.ts, types.ts}}`
  - `domain/{kinds.ts, prices.ts, estimate.ts, status.ts, errors.ts}`
  - `drizzle/enrichment.config.ts`
- Modify: every item of map section 1's checklist (`migrate.ts`, both bootstrap SQL files, Dockerfile, `db-router.ts`, `rls-catalog.test.ts`, `migrate.test.ts`, `entry/registry.ts`, `platform/ids.ts`, `seed.ts` `DEV_KEY_SCOPES` + `enrichment:request`)
- Test: `tests/unit/enrichment/{estimate, status, errors}.test.ts`, `tests/integration/enrichment/schema.test.ts`

**Interfaces (produces):**
- `KINDS`, `kindLabel(kind)`, `operationsFor(provider, kind)`.
- `estimate({provider, kind, roles, personIds, centsPerCredit, aiWorstCents}): {credits, costCents}`.
- `estimateText(est, currency, sample): string` (Ruling 5).
- `canTransition(from, to)`, `statusText(request)` (Global Constraints).
- `classifyError(e, providerName): {kind, message, retry: boolean}` (Ruling 9).
- Event defs `requestFlagged`, `requestApproved`, `requestDeclined`, `requestCancelled`, `requestCompleted`, `requestFailed`.
- Job defs `runRequestJob`, `expireRequestsJob`.

- [ ] **Step 1: Failing unit tests.**
  - The estimate for `people_for_roles` with 2 roles is 6 credits. With 10 cents a credit and USD, the text reads "Up to 6 credits, about $0.60". On mock it gets " · Sample". For website it reads "Free. Claude usage up to $0.05".
  - Each transition in Ruling 7 is allowed, and `completed → running` is refused.
  - `classifyError` maps a 401, a 429 `RateLimitedError`, `/insufficient credits/`, an `AbortError`, a 422 and a `blocked_by_cap` ScoutError per Ruling 9.
- [ ] **Step 2: Failing schema test.** RLS is enabled on `enrichment.request`, and a tenant can't read another tenant's row. Copy `tests/integration/playbooks/schema.test.ts`'s pattern, but run it in the full integration project, since that file fails when run alone on main.
- [ ] **Step 3: Implement.** Generate the migration with drizzle-kit, then append the RLS SQL.
- [ ] **Step 4: Run** `npx vitest run tests/unit/enrichment tests/integration/enrichment tests/integration/platform/migrate.test.ts tests/integration/platform/rls-catalog.test.ts tests/unit/entry-registry.test.ts`.
- [ ] **Step 5: Commit** `feat(enrichment): request table and domain`.

### Task 2: Request services, expiry, feedback

**Files:**
- Create: `src/modules/enrichment/services/{requests.ts, expire.ts}`, `jobs.ts` (the expire handler only), `defaults.ts`
- Modify: `src/modules/intake/{services/feedback.ts, contracts/events.ts, db/schema.ts, index.ts}` (new migration for a nullable `arrival_id` + `recordSourceFeedback` + kind `enrichment_expired`), `src/http/routes/v1/feedback/route.ts` (label), `src/entry/worker.ts`
- Test: `tests/integration/enrichment/requests.test.ts`, `expire.test.ts`, `tests/integration/intake/source-feedback.test.ts`

**Interfaces (produces, exported from `@/modules/enrichment`):**
- `createRequest(ctx, principal, accountId, {kind, providerKey, roles?, personIds?, reason?}): Promise<{request: RequestView, joined: boolean}>`. It returns 404 for an account the principal can't see, 400 for a role key or person id that doesn't belong, and follows Rulings 1 and 6.
- `approveRequest(ctx, principal, id)`, `declineRequest(ctx, principal, id, reason)`, `cancelRequest(ctx, principal, id)`. Each validates the transition (409 "This request is already {status_text}.") and publishes its event. Approve also enqueues `runRequestJob`.
- `listRequests(ctx, {status?, accountId?, cursor, limit})` (keyset, filtered by visible accounts), `getRequest(ctx, id)`.
- `estimateFor(ctx, accountId, input): Promise<{credits, costCents, currency, sample, text}>`.
- `expireFlagged(ctx, now)`.
- Intake: `recordSourceFeedback(ctx, {sourceId, accountId, kind, note, causeEventId})`, unique per (source, kind, causeEventId), and `ensureVendorSource(ctx, key, name)`.

- [ ] **Step 1: Failing tests.**
  - An owner creates `approved` and the run job is enqueued. A seller creates `flagged`, and with no reason gets the 400 copy. A key creates `flagged`.
  - Duplicate join (Review Focus 3).
  - Decline records `enrichment_declined` for the requesting source only, not for other sources in the chain. An agent's request with no arrival still records the feedback.
  - Expiry cancels only flagged requests 14 or more days old, sets reason `expired`, records `enrichment_expired`, and publishes `cancelled`.
  - The expiry schedule is upserted on create.
  - The estimate uses the connection's `cents_per_credit` when set, and is `sample: true` on mock.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/enrichment tests/integration/intake`. **Step 4: Commit** `feat(enrichment): requests, approval and expiry`.

### Task 3: Provider adapters and the website reader

**Files:**
- Create:
  - `src/modules/enrichment/contracts/adapter.ts` (`EnrichmentAdapter`)
  - `adapters/apollo/{live.ts, mock.ts, register.ts}`
  - `adapters/vibe/{mapping.ts, mock.ts, register.ts}`
  - `adapters/website/{live.ts, mock.ts, robots.ts, register.ts}`
  - `tasks/read-website.ts`, `tasks/prompts/read_website.v1.0.ts`
- Modify:
  - `src/modules/integrations/providers.ts` (`website` provider, `needsCredential: false`)
  - `gateway.ts` (go live on mode live with no credential when `needsCredential` is false)
  - `services/connections.ts` (`markConnectionFailing`)
  - `index.ts`
  - `src/entry/compose.ts`
- Test: `tests/unit/enrichment/{apollo-live, vibe-mapping, robots, website-live, read-website-rules}.test.ts`, `tests/integration/enrichment/adapters.test.ts`

**Interfaces:**
- `EnrichmentAdapter extends Adapter` with:
  - `companyEnrich({domain}) → Paid<CompanyFacts>`;
  - `peopleSearch({domain, titles, max}) → Paid<Person[]>`;
  - `revealEmail({person}) → Paid<Person>`;
  - `jobPostings({domain, orgId?}) → Paid<Signal[]>`;
  - `news({domain}) → Paid<Signal[]>`;
  - `readSite({domain}) → {pages: {url, title, text, html}[]}`;
  - `Paid<T> = {value: T, creditsUsed: number}`.

  Each adapter implements the operations its provider has; the others throw `bad_request` "{Provider} can't do that."
- **Values are arrival-shaped:**
  - `CompanyFacts` holds `arrival.v1` `account` fields.
  - `Person` is an `arrival.v1` person, with `email_status` and `seniority` (Ruling 12).
  - `Signal` is an `arrival.v1` signal.
- **Apollo live:** ports v1 `apollo.ts`. It uses `LiveCredentials.value` as `x-api-key`, never env. 401 throws status 401; 403 throws with v1's master-key message; 429 throws `RateLimitedError`; `insufficient credits` throws `out_of_credits`. Each response is zod-parsed. `test()` calls `organizations/enrich?domain=apollo.io`.
- **Apollo mock:** port v1 `mock.ts`. It is deterministic per domain and reports credits as Apollo would. It also injects failures for tests via `setMockFailure(kind | null)`, like the HubSpot mock.
- **Website live:** follows Ruling 3. **Website mock:** two pages.
- **`read_website` task:** `TaskDef` with `rules` and `mock` (the mock returns the rules output).

- [ ] **Step 1: Failing unit tests.**
  - Apollo live against stubbed `fetch` with v1's fixtures from `reference/v1/tests/unit/apollo.test.ts`, plus the error mapping.
  - Vibe mapping passes v1's `vibe.test.ts` and `vibeExport.test.ts` cases.
  - Robots: `Disallow: /about` blocks `/about/team` but not `/`. The website live adapter skips disallowed pages and stops at 30 seconds with fake timers (Review Focus 5).
  - Rules extraction gets the title, the meta description and the WordPress or HubSpot fingerprint, each with its URL.
- [ ] **Step 2: Failing integration test.**
  - `gateway.call(ctx, 'apollo', 'organizations.enrich', ...)` in mock mode returns the sample company, and settles 1 credit against the apollo limit.
  - `website` on mode live, with no credential, goes live with a stubbed fetch.
  - `markConnectionFailing` sets status `failing` and `last_error`.
- [ ] **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/unit/enrichment tests/integration/enrichment tests/integration/integrations`. **Step 5: Commit** `feat(enrichment): Apollo, Vibe and website adapters`.

### Task 4: The run job

**Files:**
- Create: `src/modules/enrichment/services/run.ts`
- Modify: `jobs.ts` (run handler), `src/modules/intake/contracts/arrival.ts` and the person writer (Ruling 12), `src/entry/worker.ts`
- Test: `tests/integration/enrichment/run.test.ts`, intake arrival tests for the new person fields

- [ ] **Step 1: Failing tests** (mock adapters, driven with `runOutbox`):
  - An owner's `people_for_roles` request for `technical_buyer` completes. The new people show the Apollo source and `email_status` from the provider, and `result.credits_used` equals the apollo period's `used` increase (ENR-E3-S1-AC1).
  - A firmographics value that disagrees with an existing fact opens a conflict (ENR-E4-S1-AC2).
  - Nothing found gives "Apollo found no one for Technical buyer", `found: 0`.
  - An estimate over the limit: no adapter call is made, `waiting_reason` is set and survives the rolled-back job, and the run completes after the limit is raised (ENR-E3-S2-AC1).
  - A limit hit mid-run (Review Focus 1).
  - Redelivery (Review Focus 2).
  - `auth` fails at once, marks the connection failing, and sets the message.
  - `out_of_credits` after 2 people gives `partial` with 2 people kept.
  - `bad_request` fails with no retry.
  - `rate_limited` is retried.
  - `website_read` on mock adds a description fact with a URL, and the request reads "Read by rules" in `result`.
  - `completed` and `failed` events are published with the spec payloads.
- [ ] **Step 2: Implement** per Rulings 8 and 9. **Step 3: Run** `npx vitest run tests/integration/enrichment tests/integration/intake`. **Step 4: Commit** `feat(enrichment): run approved requests`.

### Task 5: Queue chip

**Files:**
- Modify: `src/modules/routing/{db/schema.ts, db/migrations/<next>.sql, consumers.ts, services/queue.ts}`, `src/entry/worker.ts`
- Test: `tests/integration/routing/enrichment-chip.test.ts`

- [ ] **Step 1: Failing test.** A flagged request makes the queue row's `enrichmentRequested` true, with `enrichmentRequestedBy` "Yasir's agent". Declining clears it. Two open kinds count as one chip, and the chip clears only when both close.
- [ ] **Step 2: Implement** (Ruling 11; routing imports only `@/modules/enrichment/contracts/events`). **Step 3: Run** `npx vitest run tests/integration/routing`. **Step 4: Commit** `feat(routing): enrichment requested chip`.

### Task 6: HTTP

**Files:**
- Create:
  - `src/http/routes/v1/accounts/[id]/enrichment-requests/route.ts`
  - `accounts/[id]/enrichment-estimate/route.ts`
  - `enrichment-requests/route.ts`
  - `enrichment-requests/[id]/route.ts` (`byAction` approve, decline, cancel)
- Modify: `src/http/routes.ts` (specific before `:id`), the queue route (`enrichment_requested_by`)
- Test: `tests/integration/v1/enrichment-requests.test.ts`, plus rows in `route-access.test.ts` and `people-only.test.ts`

- [ ] **Step 1: Failing tests.**
  - Owner create gives 201 `approved`. Seller create gives 201 `flagged`. Create with no reason as a seller gives 400 with the copy. A join gives 200 `joined: true`.
  - The estimate's `text` matches Ruling 5.
  - Key approve gives 403 "Only a person can approve spend." (ENR-E1-S2-AC2). A seller approving gives 403.
  - Decline with no reason gives 400 "Say why you're declining."
  - The list is filtered by data limits for an agent key (Review Focus 4). The cursor pages.
  - An unknown id gives 404. A wrong transition gives 409 with the copy.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/v1 tests/unit/http`. **Step 4: Commit** `feat(http): enrichment requests`.

### Task 7: Web UI — Enrich dialog, account notice, peek

**Files:**
- Create: `web-ui/src/features/enrichment/{api.ts, EnrichDialog.tsx, AccountEnrichment.tsx, words.ts}` plus tests
- Modify:
  - `features/account/{AccountHeader.tsx, AccountPage.tsx}`;
  - `account-page.test.tsx`, where the "no Enrich button" assertion becomes "Enrich shows with `enrichment:request`";
  - `features/review/{PeekDrawer.tsx, parts.tsx}`, adding the "requested by" text in the peek.

- [ ] **Step 1: Failing tests.**
  - An approver sees `Run enrichment` and the estimate line from msw. Confirming posts and shows the started toast.
  - A seller sees the "Why is this worth it?" field and `Ask for approval`. An empty reason blocks the send with "Say why this is worth the spend." Sending shows the approval toast.
  - The joined toast.
  - Buying roles default to roles with no person.
  - Changing the kind or roles refetches the estimate.
  - The notice lines and their status texts; polling stops once no request is open.
  - No Enrich button without `enrichment:request`.
  - The peek's Enrich opens the dialog.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/enrichment src/features/account src/features/review`. **Step 4: Commit** `feat(web-ui): Enrich dialog`.

### Task 8: Web UI — Enrichment requests screen

**Files:**
- Create: `web-ui/src/features/enrichment/{RequestsScreen.tsx, DeclineDialog.tsx}` plus tests
- Modify: `routes/workspace.tsx`, `router.tsx`, `app/nav.ts`, `nav.test.ts`

- [ ] **Step 1: Failing tests.**
  - The Waiting tab lists flagged requests with every column. Approve posts `:approve` (use `exactly()` for the colon path) and shows the toast. Decline requires a reason, then posts.
  - A seller sees the list without Approve or Decline.
  - The empty copy.
  - The All tab shows status texts.
  - Nav shows "Enrichment" for a seller and an owner, and not for a viewer.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run`, the full web-ui suite. **Step 4: Commit** `feat(web-ui): Enrichment requests screen`.

### Task 9: Specs, end-to-end, full suites

**Files:**
- Modify:
  - `docs/spec/enrichment/{index.md, requests-and-approval.md, credits-costs-and-caps.md, results-and-failures.md, providers-and-saved-searches.md}`: Rulings 1-14, R2b-2 shipped, divergences (no `provider_price` table, Vibe sample only, `rate_limited` counts tries, ENR-E3-S1-AC2 waits for R3a, the `cancelled` event);
  - `docs/spec/architecture/event-catalog.md`;
  - `docs/spec/web-ui/screens.md` (new §4b Enrich dialog and §22 Enrichment requests; §2 and §3 chip and peek);
  - `docs/spec/web-ui/api-gaps.md` (enrichment rows READY);
  - `docs/spec/mcp/agent-tools.md` (REST only until the server exists);
  - `docs/spec/integrations/adapter-contract-and-providers.md` (`website`, `needsCredential`, `markConnectionFailing`).
- Create: `tests/e2e/enrichment.spec.ts`

- [ ] **Step 1: E2E** (mock providers). As a seller, open an account, then Enrich, People for buying roles, Technical buyer. Fill in a reason and click `Ask for approval`; the toast shows.

  As the owner, open Enrichment. The request is listed. Approve it; the toast shows. Then open the account: the notice reaches "Found {n}" within 30 seconds, and a new person appears in the buying committee.

  Use an e2e-only account, and leave the tenant's limits untouched.
- [ ] **Step 2: Full suites.** Run each of these:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test:unit`
  - `npm run test:int`
  - `cd web-ui && npm test`
  - `npm run e2e`

  All must be green, except `playbooks/schema.test.ts`, a known failure on main.
- [ ] **Step 3: Commit** `docs(spec): R2b-2 enrichment` and `test(e2e): enrichment requests`.
