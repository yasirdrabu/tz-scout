# API and MCP conventions (decision D8)

The public API and the MCP server are two faces of the same module services. The web app (`web-ui/`)
calls the same `/api/v1` API from the browser with its session cookie, on the same origin (web-ui W2). Endpoint and tool lists live in each module's index; the
surfaces as a whole are specified in [public-api/](../public-api/index.md) and [mcp/](../mcp/index.md).

## REST `/api/v1`

- Base URL `https://scout.taazaa.ai/api/v1`. JSON only. Versioned in the path; breaking changes go to
  `/api/v2`, which runs alongside `/api/v1` for at least six months. The API moved from `/v1` with no
  alias for the old path (web-ui C1); sign-in is at `/api/auth`, the health checks at `/healthz` and
  `/readyz`. An unknown path under `/api` is a problem+json 404; a known path with a method it does not
  serve is a 405 with `Allow`.
- OpenAPI 3.1 at `/api/v1/openapi.json`, generated from the Zod contracts. Human docs at `/developers`.
- Resource style: plural nouns (`/api/v1/accounts`, `/api/v1/arrivals`, `/api/v1/batches`), sub-resources for
  ownership (`/api/v1/accounts/{id}/people`), and verbs only for actions that are not plain updates
  (`POST /api/v1/accounts/{id}:assign`).
- **Auth:** `Authorization: Bearer <token>`. Tokens are API keys (`scout_live_…`, `scout_test_…`) or
  OAuth 2.1 access tokens. Both resolve to a principal with a tenant, scopes and data limits.
- **Scopes** (permission) and **data limits** (which rows) are separate; both are checked. Scope
  names: `<resource>:<action>`, e.g. `arrivals:write`, `accounts:read`, `enrichment:request`,
  `status:read`, `webhooks:manage`. Data limits: `own_source` (only what this source sent), a list of
  source ids, practices, or `all`. Full list in `tenancy-and-access/roles-and-data-scopes.md`.
- **Async by default:** commands that start work return `202 Accepted` with the created resource id
  and a `status_url`. Callers poll the status or subscribe to webhooks. Reads are synchronous.
- **Idempotency:** every `POST` accepts `Idempotency-Key`; the same key and body within 24 hours
  returns the original response. Batch items also accept a caller `external_ref`.
- **Pagination:** cursor based: `?limit=50&cursor=…`, response `{ data: [], next_cursor }`.
- **Errors:** RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, and for
  validation errors an `errors[]` array of `{ path, message }`.
- **Rate limits:** per key, default 600 requests a minute and 500 arrivals a day per source (D8,
  configurable per key). Headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429
  with `Retry-After` when exceeded.
- **Audit:** every write records the principal, key id, source id, IP and correlation id.

## Outgoing webhooks

- A tenant or an agent's key (with `webhooks:manage`) registers endpoints and the event types it
  wants, limited by its data limits.
- Deliveries are signed: `Scout-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` with the
  endpoint's secret. Body is the event envelope (see events-and-async.md).
- Retries with backoff for 24 hours; endpoints that fail for 3 days are disabled and the owner is told.

## MCP

- **Hosted:** Streamable HTTP at `https://scout.taazaa.ai/mcp`. Clients (Claude, ChatGPT, others)
  connect by URL and sign in with OAuth 2.1 (dynamic client registration allowed per tenant setting);
  the grant carries the same scopes and data limits as an API key.
- **Local:** `npx @taazaa/scout-mcp` (stdio), configured with an API key; it calls `/api/v1`.
- **Tools are agent-shaped, not endpoint mirrors.** Each tool has a clear verb-first name, a
  one-paragraph description written for a model, Zod input and output, and returns short,
  explainable results with ids the agent can use next. The tool list lives in `mcp/agent-tools.md`.
- Tool calls go through the same services, scopes, data limits, rate limits and audit as the API.
