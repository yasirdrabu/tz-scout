# INT-E5 Adapter contract and providers

Release R0 (contract and mocks), providers as listed

## Adapter contract

Carried from v1 and still binding: every outside service sits behind an interface with a `mock` and a
`live` implementation, and Scout runs end to end on mocks with seed data.

- The **interface** belongs to the module that uses the capability (CRM interface in `crm-sync`,
  prospect search in `enrichment`, AI completion in `ai-tasks`). INT owns the gateway, credentials,
  logging and caps, and the shared provider list.
- Live implementations get their client only through `gateway.call`; they never read env vars or the
  database for credentials.
- Every adapter implements `test()` and declares, per operation, its unit (calls, credits, tokens,
  records) and a cost function (cents per unit, or computed from the response).
- Every response is validated with Zod before use; a response that fails validation is an error with
  the provider's raw shape logged (redacted).
- Mocks return realistic, deterministic data seeded by input (same input, same output) and may add a
  delay to simulate slow providers. Mocks never call the network.
- Adapters retry only idempotent reads themselves (2 retries, jittered). Writes are retried by the job
  system, which is why every write uses provider idempotency or an upsert by our id.
- Provider rate limits (429, `Retry-After`) become `rate_limited` outcomes; the job is retried after
  the indicated time.

## Providers

| Provider | Key | Interface owner | Credential (phase 1) | Release |
|---|---|---|---|---|
| HubSpot | `hubspot` | crm-sync | Private app token + portal id; optional `webhook_client_secret` (kind `client_secret`) for hand-configured webhook signatures (D28) | R1 |
| Apollo | `apollo` | enrichment, sources-and-intake (pulls) | API key | R1 |
| Vibe Prospecting | `vibe` | enrichment, sources-and-intake (pulls) | API key (D34) | R1 |
| Claude (Anthropic) | `anthropic` | ai-tasks | API key | R1 |
| Microsoft Entra ID | `microsoft` | tenancy-and-access | Client id, secret, tenant id (platform-level for sign-in) | R0 |
| Email sending | `email` | platform (notifications), campaigns | SMTP or provider API key | R1 |
| Salesforce | `salesforce` | crm-sync | Connected app (client credentials) | R4 |
| Microsoft Dynamics 365 | `dynamics` | crm-sync | Entra app with Dataverse permission | R4 |
| Dayko Kindle | `dayko_kindle` | crm-sync | API key or service token (to be confirmed with Dayko) | R4 |
| Meta ads | `meta` | campaigns | System user token | R4 |
| LinkedIn ads | `linkedin` | campaigns | OAuth token | R4 |
| Google Ads | `google_ads` | campaigns | OAuth token + developer token | R4 |
| Booking | `booking` | campaigns | API key | R4 |
| SMS | `sms` | campaigns | API key | R4 |
| Company data | `company_data` | enrichment | API key (vendor to be chosen) | R2 |

Microsoft sign-in is configured per platform (env vars), not per tenant, in this version.

## Stories

### INT-E5-S1 Mock everything
As a developer, I want every provider to have a mock, so that Scout runs on a laptop with no keys.
- INT-E5-S1-AC1 With no credentials and `SCOUT_FORCE_MOCK=true`, the R1 end-to-end test (agent submits,
  score, assign, push to CRM) passes.

### INT-E5-S2 One gateway
As an owner, I want every outside call to show in the call log, so that nothing happens off the
record.
- INT-E5-S2-AC1 A boundary lint rule fails the build if code outside `src/modules/*/adapters/*/live`
  imports a provider SDK, and if a live adapter is constructed outside `gateway.call`.
