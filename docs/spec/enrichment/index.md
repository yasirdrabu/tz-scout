# ENR: Enrichment

Module code ENR · Schema `enrichment` · Releases R1 to R3

R2b-2 shipped requests and approval (ENR-E1), the request side of ENR-E3 and ENR-E4, and the provider
adapters of ENR-E2-S1 (plan docs/plans/2026-11-03-r2b-2-enrichment.md). Rulings 1 to 3 are the user's
answers of 2026-11-03; Rulings 4 to 14 and the build rulings are Claude's calls, 2026-11-03. Each epic
file lists the rulings that touch it under "R2b-2 rulings"; where they differ from that file's Rules,
the rulings win. Saved searches (ENR-E2-S2) are not built yet.

## Purpose

Enrichment spends credits or AI tokens to learn more about an account: firmographics, the people for
a buying role, a revealed email, what the company's website says, fresh signals. It also runs saved
searches (scheduled pulls) that find new accounts. Agents can only flag a need; a person approves any
spend (D7). Every result goes back through intake as an arrival, so it gets the same provenance,
duplicate checks, conflicts and trust as anything else.

## What it owns

| Table | Key fields | Notes |
|---|---|---|
| `request` | `id` (`enr_`), `tenant_id`, `account_id` (not null in R2b-2), `kind`, `params {roles?, person_ids?}`, `provider_key`, `connection_id`, `connection_mode` (`mock`, `live`; set at run), `requested_by` (principal: a user id, or `key:<id>`), `requested_by_label` ("Dana Ruiz", "Yasir's agent"), `requesting_source_id`, `reason`, `watchers text[]` (principals who joined, Ruling 6), `estimate {credits, cost_cents, ai_tokens?}`, `status`, `waiting_reason`, `decided_by`, `decided_by_label`, `decided_at`, `decline_reason` (or `expired`), `started_at`, `finished_at`, `result {arrival_ids[], credits_used, cost_cents, found, message?, read_by?}`, `error {kind, message}` | One enrichment. Statuses and kinds are text checks (requests-and-approval.md Ruling 7). Indexes `(tenant_id, status, created_at)` and `(tenant_id, account_id)` |
| `saved_search` | `id` (`srch_`), `tenant_id`, `name`, `provider_key`, `connection_id`, `offer_id?`, `practice_id?`, `filters`, `max_companies`, `max_credits_per_run`, `schedule` (`off`, `daily`, `weekly`), `source_id` (its `scheduled_pull` source), `status`, `created_by` | Today's `ProspectSearch` |
| `search_run` | `id`, `saved_search_id`, `batch_id`, `started_at`, `finished_at`, `found`, `new`, `credits_used`, `status`, `error` | One run |
| `provider_price` | `tenant_id`, `provider_key`, `operation`, `credits` | Credits per operation, for estimates. Money per credit lives on the INT connection. **Not built in R2b-2** (Ruling 4): credits per operation are code constants, and its Settings screen is deferred |

Usage and money are recorded by INT's gateway, not here (ENR-E3).

New id prefixes: `enr_` (request), `srch_` (saved search).

## Depends on

- **SRC** (synchronous): `submitArrival` (results, as targeted arrivals or batches), `registerSource`
  (one `scheduled_pull` source per saved search, under the provider's vendor source). Added in R2b-2:
  `ensureVendorSource` (the provider's vendor source, made on first use), `readSource` and
  `checkArrivalCap` (the run's check before any paid call), `findArrivalByRef` (a redelivery's earlier
  arrival) and `recordSourceFeedback` (feedback for one source).
- **ACC** (synchronous, read): `getAccount`, `getSummaries`, `listBuyingRoles` for request parameters
  and the run.
- **OFF** (synchronous, read): `getOffer`, for the lead offer's target titles (`people_for_roles`).
- **INT** (synchronous): `checkCap` for the provider's limit; `gateway.call` for every provider call
  (rate limits, call log, usage); `connectionStatus`; `markConnectionFailing` on an `auth` failure
  (R2b-2).
- **AI** (synchronous): task `read_website`.
- **PLT** (synchronous): `ensureSchedule`, for the per-tenant expiry schedule.
- **Events consumed:** none. Approving enqueues `enrichment.request.run` in the same transaction
  (Ruling 8), so the run does not wait on the `approved` event.

## Epics

| Epic | File | Release |
|---|---|---|
| ENR-E1 Requests and approval | [requests-and-approval.md](requests-and-approval.md) | R2 (D33); shipped in R2b-2 |
| ENR-E2 Providers and saved searches | [providers-and-saved-searches.md](providers-and-saved-searches.md) | R1; providers shipped in R2b-2, saved searches not yet |
| ENR-E3 Credits, costs and caps | [credits-costs-and-caps.md](credits-costs-and-caps.md) | R1 (caps), R3 (cost reporting); request caps shipped in R2b-2 |
| ENR-E4 Results and failures | [results-and-failures.md](results-and-failures.md) | R1; request results shipped in R2b-2 |

## Events published

| Event | `data` |
|---|---|
| `enrichment.request.flagged` | `requestId`, `accountId`, `kind`, `requestedBy`, `requestedByLabel`, `requestingSourceId?`, `reason`, `estimate {credits, costCents}` |
| `enrichment.request.approved` | `requestId`, `accountId`, `kind`, `providerKey`, `decidedBy`, `requestedByLabel` |
| `enrichment.request.declined` | `requestId`, `accountId`, `decidedBy`, `reason` |
| `enrichment.request.cancelled` | `requestId`, `accountId`, `reason` (`expired` after 14 days flagged). New in R2b-2 (Ruling 11) |
| `enrichment.request.completed` | `requestId`, `accountId`, `kind`, `providerKey`, `arrivalIds[]`, `found`, `creditsUsed`, `costCents`, `currency`, `requestedBy`, `requestingSourceId?` |
| `enrichment.request.failed` | `requestId`, `accountId`, `providerKey`, `errorKind`, `message`, `creditsUsed`, `costCents` |
| `enrichment.search.completed` | `savedSearchId`, `searchRunId`, `batchId`, `found`, `new`, `creditsUsed`, `costCents`, `currency`, `partial` |

`requestedByLabel` on `flagged` and `approved` goes beyond the first design: routing's queue chip needs
it (R2b-2). `completed` is also published for a `partial` run. Routing consumes every request event
for the queue chip (requests-and-approval.md Ruling 11).

Credits and cost on these events are for display and webhooks. ANL builds cost lines from INT's
`integrations.usage.recorded` only, so nothing is counted twice.

## API endpoints

As fixed in [public-api/index.md](../public-api/index.md), with the R2b-2 additions:

| Method and path | Scope | Notes |
|---|---|---|
| `POST /api/v1/accounts/{id}/enrichment-requests` | `enrichment:request` | Body `{kind, provider_key, roles?, person_ids?, reason?}`. Always creates a `flagged` request from a key; a person approves. 201, or 200 with `joined: true` (Ruling 6) |
| `GET /api/v1/accounts/{id}/enrichment-estimate?kind=&provider_key=&roles=&person_ids=` | `enrichment:request` | `{credits, cost_cents, currency, sample, text}` (R2b-2) |
| `GET /api/v1/enrichment-requests?status=&account_id=&cursor=` | `enrichment:request` | Within data limits; each item has status, estimate and result. `{data, next_cursor}` |
| `POST /api/v1/enrichment-requests/{id}:approve` | `enrichment:approve` (people only) | Async; starts the run. 202 with the request |
| `POST /api/v1/enrichment-requests/{id}:decline` | `enrichment:approve` (people only) | `reason` required |
| `POST /api/v1/enrichment-requests/{id}:cancel` | `enrichment:approve`, or the requester | From `flagged` or `approved` (R2b-2) |

The request JSON and the error copy are in [requests-and-approval.md](requests-and-approval.md).
Saved searches are managed in the web app only in this version.

## MCP tools

`flag_for_enrichment`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md) (behaviour in
ENR-E1). No MCP server exists yet (Ruling 13), so in R2b-2 an agent flags through the REST route
above; the tool is built with the server.

## Jobs

| Job | Notes |
|---|---|
| `enrichment.request.run` | Runs one approved request (Ruling 8). Delivered up to 5 times, timeout 120 seconds, retries wait 30 seconds, 2 minutes, 10 minutes, then an hour. A usage-limit wait does not use up a try |
| `enrichment.request.expire` | Daily at 04:00 UTC, one schedule per tenant: cancels requests flagged for 14 days. The schedule is ensured whenever a request is created (`ensureSchedule`, which never changes an existing schedule's cron), so existing workspaces need no back-fill |

## AI tasks

`read_website` (ENR-E2): reads fetched pages and returns description, industry guess, size
clues and technologies, each citing the page URL it came from.

## Open questions

1. Auto-approve under a small amount (for example, one email reveal for an assigned account's owner)?
   Not in this version (D7); revisit after R3 with real spend data.
2. Should an agent be able to run its own Apollo account through Scout (its own credentials)? Not in
   this version; agents send what they found as arrivals.
3. **Account merges (follow-up from R2b-2).** When two accounts merge, requests keep the merged
   account's id, and routing's `enrichment_open` rows are not moved to the survivor, so the queue chip
   can be lost or stay on the merged account. Both should handle `accounts.account.merged`.
4. **Pruning closed chip rows (follow-up from R2b-2).** Routing keeps closed `enrichment_open` rows as
   tombstones (`closed_at`), so a late `flagged` or `approved` event cannot reopen the chip. Nothing
   prunes them yet, and the account index is not partial on open rows; add both together.
