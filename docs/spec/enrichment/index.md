# ENR: Enrichment

Module code ENR · Schema `enrichment` · Releases R1 to R3

## Purpose

Enrichment spends credits or AI tokens to learn more about an account: firmographics, the people for
a buying role, a revealed email, what the company's website says, fresh signals. It also runs saved
searches (scheduled pulls) that find new accounts. Agents can only flag a need; a person approves any
spend (D7). Every result goes back through intake as an arrival, so it gets the same provenance,
duplicate checks, conflicts and trust as anything else.

## What it owns

| Table | Key fields | Notes |
|---|---|---|
| `request` | `id` (`enr_`), `tenant_id`, `account_id?`, `kind`, `params`, `provider_key`, `connection_id`, `requested_by` (principal), `requesting_source_id`, `reason`, `estimate {credits, cost_cents, ai_tokens}`, `status`, `decided_by`, `decided_at`, `decline_reason`, `started_at`, `finished_at`, `result {arrival_ids[], credits_used, cost_cents, found}`, `error` | One enrichment |
| `saved_search` | `id` (`srch_`), `tenant_id`, `name`, `provider_key`, `connection_id`, `offer_id?`, `practice_id?`, `filters`, `max_companies`, `max_credits_per_run`, `schedule` (`off`, `daily`, `weekly`), `source_id` (its `scheduled_pull` source), `status`, `created_by` | Today's `ProspectSearch` |
| `search_run` | `id`, `saved_search_id`, `batch_id`, `started_at`, `finished_at`, `found`, `new`, `credits_used`, `status`, `error` | One run |
| `provider_price` | `tenant_id`, `provider_key`, `operation`, `credits` | Credits per operation, for estimates. Money per credit lives on the INT connection |

Usage and money are recorded by INT's gateway, not here (ENR-E3).

New id prefixes: `enr_` (request), `srch_` (saved search).

## Depends on

- **SRC** (synchronous): `submitArrival` (results, as targeted arrivals or batches), `registerSource`
  (one `scheduled_pull` source per saved search, under the provider's vendor source).
- **ACC** (synchronous, read): `getAccount`, `getCommittee` for request parameters.
- **INT** (synchronous): `checkCap` for connection and key credit caps; `gateway.call` for every
  provider call (rate limits, call log, usage, `integrations.usage.recorded`); connection health.
- **AI** (synchronous): task `read_website`.
- **Events consumed:** `enrichment.request.approved` (starts the run job).

## Epics

| Epic | File | Release |
|---|---|---|
| ENR-E1 Requests and approval | [requests-and-approval.md](requests-and-approval.md) | R2 (D33) |
| ENR-E2 Providers and saved searches | [providers-and-saved-searches.md](providers-and-saved-searches.md) | R1 |
| ENR-E3 Credits, costs and caps | [credits-costs-and-caps.md](credits-costs-and-caps.md) | R1 (caps), R3 (cost reporting) |
| ENR-E4 Results and failures | [results-and-failures.md](results-and-failures.md) | R1 |

## Events published

| Event | `data` |
|---|---|
| `enrichment.request.flagged` | `requestId`, `accountId`, `kind`, `requestedBy`, `requestingSourceId?`, `reason`, `estimate` |
| `enrichment.request.approved` | `requestId`, `accountId`, `kind`, `providerKey`, `decidedBy` |
| `enrichment.request.declined` | `requestId`, `accountId`, `decidedBy`, `reason` |
| `enrichment.request.completed` | `requestId`, `accountId`, `kind`, `providerKey`, `arrivalIds[]`, `found`, `creditsUsed`, `costCents`, `currency`, `requestedBy`, `requestingSourceId?` |
| `enrichment.request.failed` | `requestId`, `accountId`, `providerKey`, `errorKind`, `message`, `creditsUsed`, `costCents` |
| `enrichment.search.completed` | `savedSearchId`, `searchRunId`, `batchId`, `found`, `new`, `creditsUsed`, `costCents`, `currency`, `partial` |

Credits and cost on these events are for display and webhooks. ANL builds cost lines from INT's
`integrations.usage.recorded` only, so nothing is counted twice.

## API endpoints

As fixed in [public-api/index.md](../public-api/index.md):

| Method and path | Scope | Notes |
|---|---|---|
| `POST /v1/accounts/{id}/enrichment-requests` | `enrichment:request` | Always creates a `flagged` request from a key; a person approves |
| `GET /v1/enrichment-requests?status=&cursor=` | `enrichment:request` | Within data limits; each item has status, estimate and result |
| `POST /v1/enrichment-requests/{id}:approve` | `enrichment:approve` (people only) | Async; starts the run |
| `POST /v1/enrichment-requests/{id}:decline` | `enrichment:approve` (people only) | `reason` required |

Saved searches are managed in the web app only in this version.

## MCP tools

`flag_for_enrichment`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md) (behaviour in
ENR-E1).

## AI tasks

`read_website` (ENR-E2): reads fetched pages and returns description, industry guess, size
clues and technologies, each citing the page URL it came from.

## Open questions

1. Auto-approve under a small amount (for example, one email reveal for an assigned account's owner)?
   Not in this version (D7); revisit after R3 with real spend data.
2. Should an agent be able to run its own Apollo account through Scout (its own credentials)? Not in
   this version; agents send what they found as arrivals.
