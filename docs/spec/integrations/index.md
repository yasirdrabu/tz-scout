# INT: Integrations

Module code INT · Schema `integrations` · Releases R0 (skeleton, mock/live), R1 (credentials UI,
test, call log, caps), phase 2 (one-click OAuth)

## Purpose

Let each tenant connect its own outside services from the app, keep their credentials safe, see every
call made on their behalf, and stop runaway usage. Every call to an outside service from any module
goes through this module's gateway, so call logging, rate limits and caps live in one place.

## Owns

| Table | Key fields |
|---|---|
| `connection` | `id` (`con_`), `tenant_id`, `provider` (see providers.md), `name`, `mode` (mock, live), `status` (not_set_up, connected, failing, disabled), `settings` (json, non-secret: portal id, region, base URL), `credential_id`, `last_tested_at`, `last_test_result`, `last_error`, `created_by` |
| `credential` | `id`, `tenant_id`, `connection_id`, `kind` (api_key, private_app_token, oauth_tokens, client_secret), `ciphertext`, `iv`, `auth_tag`, `wrapped_data_key`, `key_version`, `hint` (last 4 chars), `expires_at`, `rotated_at` |
| `call_log` | `id`, `tenant_id`, `connection_id`, `provider`, `operation` (e.g. `hubspot.company.upsert`), `module`, `principal_id` (user, key or system), `api_key_id`, `correlation_id`, `request_summary` (json, secrets and personal data redacted), `status_code`, `outcome` (ok, error, rate_limited, blocked_by_cap), `duration_ms`, `units` (credits, tokens, records), `cost_cents`, `error_message`, `at` |
| `usage_cap` | `id`, `tenant_id`, `scope` (connection or api_key), `scope_id`, `unit` (credits, tokens, calls, records, cost_cents), `period` (day, month), `limit`, `warn_at` (decimal, default 0.8), `block_at` (decimal, default 1.0) |
| `usage_counter` | `tenant_id`, `cap_id`, `period_start`, `used`, `warned_at`, `blocked_at` |

Call log rows are kept 180 days, then summarised into daily usage rows.

## Depends on

- TEN for principals and API key caps.
- Nothing else. Other modules depend on INT.

## Epics

| Epic | File | Release |
|---|---|---|
| INT-E1 Connections and mock or live | [connection-management.md](connection-management.md) | R0 (skeleton), R1 (UI) |
| INT-E2 Encrypted credentials | [encrypted-credentials.md](encrypted-credentials.md) | R1 |
| INT-E3 Test connection and call log | [test-and-call-log.md](test-and-call-log.md) | R1 |
| INT-E4 Usage caps | [usage-caps.md](usage-caps.md) | R1 |
| INT-E5 Adapter contract and providers | [adapter-contract-and-providers.md](adapter-contract-and-providers.md) | R0, providers by release |
| INT-E6 One-click OAuth connections | [one-click-oauth.md](one-click-oauth.md) | Phase 2 |

## Public interface (for other modules)

- `gateway.call(ctx, provider, operation, fn, { units?, costCents?, apiKeyId? })`: checks the
  connection is live and not blocked, checks caps (reserving the expected units), runs `fn` with a
  decrypted client, logs the call, records actual units and cost, publishes threshold events.
- `adapterFor(ctx, provider) → Adapter` returns the mock or live implementation for this tenant.
- `connectionStatus(ctx, provider) → { mode, status, lastError }`.
- `checkCap(ctx, { apiKeyId?, provider, unit, amount }) → { allowed, remaining, warn }` (used by
  intake for daily arrival caps and by enrichment before spending).

## Events

| Event | Data |
|---|---|
| `integrations.connection.changed` | `connectionId`, `provider`, `mode`, `status`, `changedBy` |
| `integrations.connection.tested` | `connectionId`, `provider`, `ok`, `message`, `durationMs` |
| `integrations.usage.threshold_reached` | `capId`, `scope`, `scopeId`, `provider?`, `unit`, `used`, `limit`, `level` (warn, block) |
| `integrations.usage.recorded` | `provider`, `operation`, `module`, `units`, `unit`, `costCents`, `apiKeyId?`, `sourceId?`, `correlationId` (emitted for every call with a cost; ANL builds automatic cost lines from it) |

Consumes `tenancy.api_key.created` (create default caps for the key) and `tenancy.api_key.revoked`
(close its counters). Handles `jobs.history.republish` by re-publishing `integrations.usage.recorded`
from the call log with `replay: true` (events-and-async.md).

## API endpoints

| Method and path | Scope |
|---|---|
| `GET /v1/integrations` | `integrations:manage` |
| `GET /v1/integrations/{provider}/calls?from&to&outcome&apiKeyId` | `integrations:manage` |
| `GET /v1/usage?period=month` | `integrations:manage` or `keys:manage` |

Credentials are set only in the web app, never through the API.

## MCP tools

None.

## Open questions

- Should a tenant be able to share a Taazaa-owned vendor account (e.g. Apollo) with a client tenant,
  billed back? Not in this version (D20: strictly separate).
