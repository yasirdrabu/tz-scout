# API: Public API

Module code API · No schema of its own (owns `webhook_endpoint` and `webhook_delivery` in schema
`platform`, see outgoing-webhooks.md) · Releases R1 (core), R3 (outgoing webhooks)

## Purpose

One documented, versioned REST surface over every module, for agents, vendors, partners and internal
automation. Each module owns its endpoints (handlers live in `src/modules/<m>/http/`); this module
owns the rules they all follow, the shared plumbing (auth, errors, idempotency, rate limits,
pagination, OpenAPI), outgoing webhooks, the developer page and the sandbox.

The conventions summary is in [architecture/api-and-mcp-conventions.md](../architecture/api-and-mcp-conventions.md);
this module is the full spec.

## Depends on

TEN (principal, scopes, data limits), INT (caps), every module's public interface.

## Epics

| Epic | File | Release |
|---|---|---|
| API-E1 API foundations | [api-foundations.md](api-foundations.md) | R1 |
| API-E2 Async work and batches | [async-and-batches.md](async-and-batches.md) | R1 |
| API-E3 Outgoing webhooks | [outgoing-webhooks.md](outgoing-webhooks.md) | R3 |
| API-E4 Developer docs page | [developer-docs.md](developer-docs.md) | R1 |
| API-E5 Sandbox and test keys | [sandbox-and-test-keys.md](sandbox-and-test-keys.md) | R1 |

## Endpoints

All under `https://scout.taazaa.ai/v1`. "Owner" is the module that implements the handler. Async means
`202 Accepted` with a `status_url`.

### Who am I

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /me` | any | TEN | Principal, tenant, scopes, data limit, source, caps and usage today |

### Sources, arrivals, batches, imports

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /sources` | `arrivals:read` | SRC | Sources visible to the principal (its own and children) |
| `POST /sources` | `sources:manage` | SRC | Create a person, agent or vendor source |
| `POST /arrivals` | `arrivals:write` | SRC | One account; async |
| `GET /arrivals/{id}` | `arrivals:read` | SRC | Status: received, resolving, resolved, rejected; `account_id` once resolved |
| `GET /arrivals?batch_id&status&since&cursor` | `arrivals:read` | SRC | |
| `POST /batches` | `arrivals:write` | SRC | Up to 1,000 accounts plus batch notes; async |
| `POST /batches/{id}/files` | `arrivals:write` | SRC | Attach a file (up to 25 MB) to a batch |
| `GET /batches/{id}` | `arrivals:read` | SRC | Counts by status and by stage |
| `GET /batches/{id}/items?cursor` | `arrivals:read` | SRC | Per-item status with `external_ref` |
| `POST /imports` | `imports:run` | SRC | Upload CSV, Excel or Markdown; async; returns a proposed column mapping |
| `GET /imports/{id}` | `imports:run` | SRC | |
| `POST /imports/{id}:confirm` | `imports:run` | SRC | Confirm or edit the mapping; starts the import |
| `GET /feedback?since&cursor` | `arrivals:read` | SRC | Feedback to the principal's own source only: conflicts lost, review and seller declines, with reason and note (SRC-E1-S4) |

### Accounts, people, facts, signals

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /accounts?q&domain&tier&practice_id&offer_id&stage&source_id&cursor` | `accounts:read` | ACC | Within data limit |
| `GET /accounts/{id}` | `accounts:read` | ACC | Facts (current values), signals, scores summary, stage |
| `PATCH /accounts/{id}` | `accounts:write` | ACC | |
| `GET /accounts/{id}/people` | `accounts:read` | ACC | Contact fields need `people:read` |
| `POST /accounts/{id}/people` | `people:write` | ACC | |
| `PATCH /people/{id}` | `people:write` | ACC | |
| `POST /accounts/{id}/signals` | `signals:write` | ACC | |
| `GET /accounts/{id}/facts?field` | `accounts:read` | ACC | All values with provenance |
| `GET /accounts/{id}/conflicts` | `accounts:read` | ACC | |
| `POST /conflicts/{id}:resolve` | `review:act` | ACC | |

### Scores, review, assignment, status

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /accounts/{id}/score` | `accounts:read` | SCO | Priority, fit, intent, tier, best offer, factor breakdown and reasons |
| `GET /accounts/{id}/matches` | `accounts:read` | SCO | Every offer match for the account |
| `GET /accounts/{id}/score/history` | `accounts:read` | SCO | Score changes with causes |
| `GET /scoring/profile`, `PUT /scoring/profile` | `scoring:manage` | SCO | Weights and thresholds; PUT is async (rescoring) |
| `POST /rescore` | `scoring:manage` | SCO | Async, whole tenant or a filter |
| `PUT /accounts/{id}/insights` | `review:act` | REV | Leader insights |
| `POST /assignments/{id}:withdraw` | `assign:act` | REV | Withdraw or reassign |
| `GET /settings/review`, `PUT /settings/review` | `settings:manage` | REV | Statuses, initial status rules, decline reasons |
| `GET /accounts/{id}/status` | `status:read` | REV | Stage, review status, owner name, last activity date (the agent follow-up call) |
| `PATCH /accounts/{id}/review-status` | `review:act` | REV | |
| `POST /accounts/{id}:assign` | `assign:act` | REV | |
| `POST /assignments/{id}:accept` | `assignments:respond` | REV | |
| `POST /assignments/{id}:decline` | `assignments:respond` | REV | Reason key required |
| `GET /review-queue?status&cursor` | `review:act` | REV | |

### Enrichment

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `POST /accounts/{id}/enrichment-requests` | `enrichment:request` | ENR | Flag only; a person approves |
| `GET /enrichment-requests?status&cursor` | `enrichment:request` | ENR | |
| `POST /enrichment-requests/{id}:approve` | `enrichment:approve` | ENR | Async |
| `POST /enrichment-requests/{id}:decline` | `enrichment:approve` | ENR | |

### Offers, playbooks, CRM

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /practices` | `offers:read` | OFF | |
| `GET /offers?practice_id&status` | `offers:read` | OFF | Approved offers only unless `offers:manage` |
| `GET /offers/{id}` | `offers:read` | OFF | One offer with case studies and signal rules |
| `POST /offers`, `PATCH /offers/{id}` | `offers:manage` | OFF | Create, edit |
| `POST /offers/{id}:approve`, `POST /offers/{id}:archive` | `offers:manage` | OFF | Approve also requires the owner role |
| `PUT /offers/{id}/signal-rules` | `scoring:manage` | OFF | Replace an offer's signal rules |
| `GET /case-studies` | `offers:read` | OFF | Agents see only buyer-visible case studies |
| `GET /accounts/{id}/brief` | `playbooks:read` | PLB | Brief sections with citations |
| `PATCH /accounts/{id}/brief/sections/{key}` | `playbooks:write` | PLB | Edit a section |
| `GET /accounts/{id}/plan` | `playbooks:read` | PLB | Account plan and steps |
| `PATCH /plans/{id}/steps/{step_id}` | `playbooks:write` | PLB | Update a step (status, owner, due, note) |
| `GET /playbooks`, `GET /playbooks/{id}` | `playbooks:read` | PLB | Templates |
| `POST /playbooks`, `PATCH /playbooks/{id}` | `playbooks:manage` | PLB | Create and edit templates; accept or reject proposals |
| `POST /accounts/{id}/outcomes` | `playbooks:write` | PLB | Reply, meeting, opportunity, won, lost |
| `POST /accounts/{id}:push` | `crm:push` | CRM | Async; re-push to the CRM |
| `GET /accounts/{id}/handoffs` | `accounts:read` | CRM | CRM ids and links |

### Analytics and costs

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /analytics/funnel?by=source\|practice\|offer&from&to&format=csv` | `analytics:read` | ANL | Counts and conversion per stage; `format=csv` for export; further filters in analytics/index.md |
| `GET /analytics/sources/{id}/performance` | `analytics:read` | ANL | One source's funnel, decline reasons, trust trend (backs `get_source_performance`; an agent may read its own source without `analytics:read`) |
| `GET /analytics/flywheel?from&to` | `analytics:read` | ANL | Quarterly trend numbers |
| `GET /analytics/scorecard?weeks` | `analytics:read` | ANL | Weekly scorecard with targets and colours |
| `GET /costs?from&to&source_id` | `analytics:read` | ANL | |
| `POST /costs` | `costs:write` | ANL | Manual cost line |
| `POST /costs/{id}:void` | `costs:write` | ANL | Void a cost line with a reason (lines are never deleted) |

### Inbound webhooks (not key-authenticated)

| Method and path | Auth | Owner | Notes |
|---|---|---|---|
| `POST /inbound/hubspot/{connectionId}` | HubSpot request signature (v3) checked against the connection's optional `webhook_client_secret`, verified once; `401` when no secret is set | SRC | Optional: subscriptions are set up by hand in HubSpot; polling is the primary path (D28). Qualified-lead lifecycle changes become arrivals; deal and engagement events are passed to CRM's `handleCrmWebhook` |
| `POST /inbound/forms/{sourceId}` | per-form token (`x-scout-form-token`) | SRC | Web form submissions become arrivals (R2) |
| `POST /inbound/booking/{connectionId}` | booking provider signature | CMP | Booking provider events (R4) |
| `POST /api/webhooks/form/{tenantSlug}` | v1 shared secret | SRC | v1 alias so existing forms keep working. It stays live until every live form has moved to a per-form token (Admin shows forms still using it); it is not removed on a fixed release date (spec's call, D31) |

### How agent writes reach accounts

`POST /accounts/{id}/people`, `POST /accounts/{id}/signals` (and the MCP tools `add_person`,
`add_signal`) and enrichment results all enter through SRC as targeted arrivals
(`target_account_id`), so every value keeps its provenance and passes the same checks. People and
signal writes run with `inline: true`: the arrival resolves inside the call and the response returns
the new `person_id` or `signal_id` (201), not a 202.

### Campaigns (R4)

| Method and path | Scope | Owner | Notes |
|---|---|---|---|
| `GET /message-tests`, `GET /message-tests/{id}` | `campaigns:read` | CMP | Tests with statements and verdicts |
| `GET /statements/library?segment_id` | `campaigns:read` | CMP | Winning statements |
| `GET /meetings?account_id` | `accounts:read` | CMP | Meetings for an account |

### Webhooks, keys and members

| Method and path | Scope | Owner |
|---|---|---|
| `GET /webhook-endpoints`, `POST /webhook-endpoints`, `PATCH /webhook-endpoints/{id}`, `DELETE /webhook-endpoints/{id}` | `webhooks:manage` | API |
| `POST /webhook-endpoints/{id}:test` | `webhooks:manage` | API |
| `GET /webhook-endpoints/{id}/deliveries?cursor` | `webhooks:manage` | API |
| `GET /api-keys`, `POST /api-keys`, `POST /api-keys/{id}:rotate`, `POST /api-keys/{id}:revoke` | `keys:manage` | TEN |
| `GET /members` | `members:read` | TEN |
| `GET /integrations`, `GET /integrations/{provider}/calls`, `GET /usage` | `integrations:manage` | INT |

Field naming in JSON is `snake_case`. Ids are the prefixed ULIDs from data-conventions.md.

## Events

Publishes nothing of its own except webhook delivery bookkeeping (`platform` tables, no events).
Consumes the public event types listed in outgoing-webhooks.md.

## MCP tools

None; the MCP server is a sibling surface (see mcp/).

## Open questions

- Should list endpoints also support a filter language (`?filter=tier eq "act_now"`)? Spec's call: no;
  named query parameters only in `/v1`.
