# SRC: Sources and intake

Module code SRC · Schema `intake` · Releases R1 to R3

## Purpose

Every account Scout knows about enters through this module, whoever sent it and however: an agent
over MCP, a vendor over the API, a CSV, a HubSpot lead that marketing qualified, a web form, a
scheduled Apollo pull, or an enrichment result. Intake stores what was sent exactly as received,
knows who sent it (person, agent, vendor), turns it into an account through one resolve pipeline, and
keeps score of how good each source's accounts turn out to be.

One path for everything (D3): there is no back door that skips intake, because provenance, duplicate
checks, caps and trust only work if every arrival goes through here. That includes enrichment results
(ENR submits them as targeted arrivals) and agents adding a person or a signal to an existing account.

## What it owns

| Table | Key fields | Notes |
|---|---|---|
| `source` | `id` (`src_`), `tenant_id`, `kind`, `name`, `parent_id`, `user_id`, `status`, `initial_review_status_key`, `daily_arrival_cap`, `trust`, `trust_updated_at`, `settings` | The registry. See [source-registry-and-trust.md](source-registry-and-trust.md) |
| `source_trust_history` | `source_id`, `computed_at`, `trust`, `sample_size`, `inputs` | One row per nightly compute or event-driven change |
| `arrival` | `id` (`arr_`), `tenant_id`, `batch_id`, `person_source_id`, `agent_source_id`, `vendor_source_id`, `principal`, `received_at`, `contract_version`, `payload` (JSON, immutable), `payload_hash`, `external_ref`, `target_account_id`, `status` (`received`, `resolving`, `resolved`, `rejected`), `waiting_on`, `reject_reason`, `account_id`, `resolution` (`created`, `attached`), `duplicate_candidates`, `warm_intro_id`, `resolved_at` | Stored exactly as received (D13) |
| `batch` | `id` (`bat_`), `tenant_id`, source chain ids, `principal`, `name`, `run_at`, `notes`, `criteria`, `metadata`, `item_count`, `counts`, `status` (`processing`, `completed`), `completed_at` | One-off arrivals have no batch |
| `batch_file` | `batch_id`, `file_name`, `content_type`, `size_bytes`, `storage_key`, `sha256` | Up to 10 per batch |
| `file_import` | `id` (`imp_`), `tenant_id`, `batch_id`, `source_id`, `file_name`, `layout`, `headers`, `row_count`, `mapping`, `mapping_origin`, `status`, `stats` | A CSV, Excel or Markdown upload |
| `column_mapping` | `id` (`map_`), `tenant_id`, `source_id`, `header_signature`, `mapping`, `created_by`, `last_used_at` | Saved mappings, reused automatically |
| `warm_intro` | `id` (`wi_`), `arrival_id`, `account_id`, `introducer_user_id`, `introducer_name`, `introducer_email`, `relationship_text`, `relationship_key`, `note`, `points`, `confirmed`, `confirmed_by` | One per arrival that declares an intro |
| `warm_intro_rule` | `tenant_id`, `introducer_user_id` or `introducer_email`, `relationship_key`, `points` | Points per introducer and relationship |
| `arrival_outcome` | `arrival_id`, `account_id`, source chain ids, `max_stage`, `declined`, `conflicts_lost`, `updated_at` | Read model for trust, built from events |
| `source_feedback` | `id`, `source_id`, `arrival_id`, `account_id`, `kind`, `note`, `created_at` | What a source is told about its arrivals |

New id prefixes this module introduces: `imp_` (file import), `map_` (column mapping), `wi_` (warm
intro).

## Depends on

- **ACC** (synchronous): `findMatches`, `upsertFromArrival`, `checkExclusion`. ACC does the account,
  person, fact and signal writes; intake decides which account an arrival belongs to.
- **CRM** (synchronous): `fetchQualifiedLead(connectionId, objectId)` to read the HubSpot contact and
  company behind a qualified-lead webhook.
- **AI** (synchronous): tasks `csv_column_mapping` (SRC-E4) and `arrival_normalise` (free-text
  industry and warm-intro relationship to keys when the rules don't match; SRC-E3, SRC-E5).
- **INT** (synchronous): `checkCap` for each source's daily arrival cap.
- **TEN**: principals, scopes and data limits; every key or grant with `arrivals:write` carries a
  `source_id`.
- **Events consumed** (trust, feedback and status replies to agents): `accounts.conflict.resolved`,
  `accounts.account.merged`, `routing.status.changed` (send-back and decline notes),
  `routing.stage.changed`, `routing.assignment.accepted`, `routing.assignment.declined`,
  `crm.deal.changed`, `playbooks.outcome.recorded`.
- **Jobs handled for other modules:** `jobs.history.republish` (re-publish stored batch and arrival
  events with `replay: true`, see events-and-async.md).

## Public interface

| Call | Used by | Does |
|---|---|---|
| `submitArrival(ctx, arrival, { inline? })` | ENR, API and MCP handlers (including `add_person`, `add_signal`) | Stores and resolves an arrival. `inline: true` (targeted arrivals only) resolves inside the call and returns the created or matched person or signal ids. ACC never calls it. |
| `submitBatch(ctx, batch, items)` | ENR, API, MCP | |
| `registerSource(ctx, source)` | ENR | Creates a `scheduled_pull` or `vendor` source |
| `sourcesForAccount(ctx, accountId)` | ANL | Sources whose arrivals resolved to the account |
| `getTrust(ctx, sourceIds)` | SCO | Effective trust as a decimal 0 to 1 over the given person, agent and vendor sources (new sources 0.60) |

**Implements for other modules (inverted interfaces, spec's call, D29):** `SourceValidator` defined by
TEN (`exists(ctx, sourceId)`, used when a key or grant is created) and `SourceInfoProvider` defined by
ACC (`getTrust(ctx, sourceIds)`, `sourcesForAccount(ctx, accountId)`, used to pick current fact values).
The composition root registers SRC's implementations, so neither TEN nor ACC imports SRC.
| `getWarmIntro(ctx, accountId)` | SCO, PLB | The strongest warm intro on the account: introducer (user id or name), relationship key, points 0 to 20, confirmed; or none |
| `accountForArrival(ctx, arrivalId)` | REV (`get_account_status`), API, MCP | The arrival's account id once resolved, its status and `waiting_on` otherwise |

An account is **sent by** a source if any of that source's arrivals resolved to it. This is the
definition behind the `own_source` data limit.

## Epics

| Epic | File | Release |
|---|---|---|
| SRC-E1 Source registry and trust | [source-registry-and-trust.md](source-registry-and-trust.md) | R1 (registry, caps), R3 (trust) |
| SRC-E2 Arrivals and batches | [arrivals-and-batches.md](arrivals-and-batches.md) | R1 |
| SRC-E3 Resolve pipeline and duplicate checks | [resolve-pipeline-and-duplicates.md](resolve-pipeline-and-duplicates.md) | R1 |
| SRC-E4 File import and column mapping | [file-import-and-column-mapping.md](file-import-and-column-mapping.md) | R1 |
| SRC-E5 Warm intros | [warm-intros.md](warm-intros.md) | R1 (basic), R2 (confirm, rules screen) |
| SRC-E6 Inbound webhooks: qualified leads and web forms | [inbound-webhooks.md](inbound-webhooks.md) | R1 (HubSpot), R2 (forms) |

## Events published

| Event | `data` |
|---|---|
| `intake.batch.created` | `batchId`, `sourceChain {personSourceId, agentSourceId, vendorSourceId}`, `name`, `runAt`, `itemCount` |
| `intake.arrival.received` | `arrivalId`, `batchId?`, `sourceChain`, `targetAccountId?`, `externalRef?` |
| `intake.arrival.waiting` | `arrivalId`, `batchId?`, `waitingOn` (`needs_website`, `needs_company`, `possible_duplicate`), `candidates?` |
| `intake.arrival.resolved` | `arrivalId`, `batchId?`, `accountId`, `resolution` (`created`, `attached`), `sourceChain`, `isFirstFromSource`, `initialReviewStatusKey`, `effectiveTrust`, `warmIntro? {warmIntroId, relationshipKey, points, confirmed}`, `practiceHint?`, `offerHint?` |
| `intake.arrival.rejected` | `arrivalId`, `batchId?`, `reason` (`invalid`, `excluded`, `daily_cap_reached`, `duplicate_in_batch`), `detail`, `accountId?` (set for `excluded`) |
| `intake.batch.completed` | `batchId`, `counts {resolved, rejected, newAccounts, alreadyKnown}`, `reportedCost? {credits, costCents, currency}` |
| `intake.source.trust_changed` | `sourceId`, `level` (`person`, `agent`, `vendor`), `from`, `to`, `sampleSize`, `cause` (`outcomes`, `conflict_lost`, `warm_intro_points`) |
| `intake.warm_intro.confirmed` | `warmIntroId`, `arrivalId`, `accountId`, `points`, `confirmedBy` |
| `intake.feedback.recorded` | `sourceId`, `arrivalId`, `accountId`, `kind` (`conflict_lost`, `declined_at_review`, `declined_by_seller`, `enrichment_declined`), `note` |

## API endpoints

As fixed in [public-api/index.md](../public-api/index.md):

| Method and path | Scope | Notes |
|---|---|---|
| `GET /v1/sources` | `arrivals:read` | Sources visible to the principal (its own and children), with trust |
| `POST /v1/sources` | `sources:manage` | Create a person, agent or vendor source |
| `POST /v1/arrivals` | `arrivals:write` | One account. `202` with `arrival_id`, `status_url` |
| `GET /v1/arrivals/{id}` | `arrivals:read` | Status, `waiting_on`, reason, account id, stage, feedback |
| `GET /v1/arrivals?batch_id=&status=&since=&cursor=` | `arrivals:read` | Within the principal's data limit |
| `POST /v1/batches` | `arrivals:write` | Batch fields plus 1 to 1,000 items |
| `POST /v1/batches/{id}/files` | `arrivals:write` | Up to 25 MB per file, 10 per batch |
| `GET /v1/batches/{id}` | `arrivals:read` | Counts by status and by stage, rejections, files |
| `GET /v1/batches/{id}/items?cursor=` | `arrivals:read` | Per-item status with `external_ref` |
| `POST /v1/imports` | `imports:run` | File upload; returns `imp_` id and proposed mapping |
| `GET /v1/imports/{id}` | `imports:run` | |
| `POST /v1/imports/{id}:confirm` | `imports:run` | Confirm or edit the mapping; starts the import |

Inbound webhooks are not part of the agent API and have their own auth (SRC-E6):
`POST /v1/inbound/hubspot/{connectionId}` (HubSpot signature) and `POST /v1/inbound/forms/{sourceId}`
(form token).

Feedback to a source (SRC-E1-S4) is returned on `GET /v1/arrivals/{id}` and delivered as the
`intake.feedback.recorded` webhook event. Warm-intro rules and source caps are managed in the web app.

## MCP tools

`submit_account`, `submit_batch`, `get_batch_status`, `list_my_submissions` (defined in
[mcp/agent-tools.md](../mcp/agent-tools.md); behaviour in
[arrivals-and-batches.md](arrivals-and-batches.md)). `add_person` and `add_signal` (ACC tools) are
handled as targeted inline arrivals through this module.

## Open questions

1. Should a vendor's trust be shared across tenants later (Apollo's data quality is the same for
   everyone)? Not in this version (D20: strictly per tenant).
2. Should a source see the final outcome (won or lost) of its accounts, or only stages up to assigned?
   Today the principal sees whatever its scopes allow (`status:read` shows stage).
