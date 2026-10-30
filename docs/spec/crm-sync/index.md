# CRM sync

Module code CRM · Schema `crm` · Releases R1 (HubSpot handoff, follow-through, activity and deal events), R4 (other CRMs)

## Purpose

The CRM is the record for companies, contacts and deals (v1 rule, still binding). Scout decides who
and why; this module carries that decision into the tenant's CRM and reads back what happened.

It does four things:

1. **Hands off** an assigned account: company, people, a full context note, a first-touch task,
   dated follow-up tasks, and the account plan's steps as tasks. Within seconds of the assignment.
2. **Reads back** follow-through (tasks done, emails, calls, meetings) and deals (open, won, lost),
   and turns them into events the rest of Scout uses for the funnel, playbook outcomes and trust.
3. **Answers** Sources and intake when it takes in a CRM-qualified lead: it fetches the contact and
   company from the CRM (`fetchQualifiedLead`, `listQualifiedLeads`). Sources and intake owns the
   inbound webhook and creates the arrival.
4. **Keeps links** between Scout records and CRM records, and the tenant's field mapping.

All CRM calls go through one adapter contract, so HubSpot (R1), Salesforce, Microsoft Dynamics and
Dayko Kindle (R4) are interchangeable. Credentials, rate limits, usage caps and the call log belong to
the Integrations module; this module asks Integrations for a ready client.

## Owns (data)

| Table | Key fields | Notes |
|---|---|---|
| `crm.link` | `id`, `tenant_id`, `scout_type` (account, person, note, task, deal, owner), `scout_id`, `system` (hubspot, salesforce, dynamics, dayko_kindle), `external_id`, `fingerprint`, `last_synced_at` | One row per Scout record per CRM record. Unique on (`tenant_id`, `system`, `scout_type`, `scout_id`, `external_id`). |
| `crm.handoff` | `id` (`hof_`), `tenant_id`, `account_id`, `assignment_id`, `handoff_batch_id`, `system`, `status` (queued, running, completed, needs_decision, failed, cancelled), `attempts`, `ownership_action` (assign, keep), `taken_from_owner`, `decision_reason`, `last_error`, `seller_user_id`, `assigned_by`, `assignment_note` (copied from `routing.assignment.created`, because CRM learns about assignments only from events), `cancel_requested_at`, `undone`, `undo_attempts`, `is_repush`, `queued_at`, `completed_at` | One per push. A re-push is a new row with `is_repush` true; only the first handoff of an assignment is unique, so a repeated `routing.assignment.created` makes no second one. `cancelled` means a decline or withdrawal stopped it, or it never started. |
| `crm.handoff_batch` | `id` (`hbt_`), `tenant_id`, `name` ("Oct 16 · 14 to Mike, 15 to Ashkan"), `bulk_key`, `created_by`, `created_at` | Groups handoffs made together. One batch for each leader action: handoffs with the same `bulkId` (from `routing.assignment.created`) share a batch, and a null `bulkId` makes its own. The name and the per-seller messages are rewritten whenever one of the batch's handoffs completes, fails, needs a decision or is cancelled. |
| `crm.handoff_message` | `id`, `handoff_batch_id`, `seller_user_id`, `count`, `text`, `copied_at`, `sent_at` | One message per rep per batch. |
| `crm.owner` | `id`, `tenant_id`, `system`, `external_owner_id`, `name`, `email`, `active`, `synced_at` | The CRM's owner roster, active and former, used to name who owns a company today. The link from a Scout user to their CRM owner id is **not** here: it lives on the TEN membership (`crm_owner_ids`, e.g. `{ hubspot: "123" }`) and is read with `crmOwnerId(ctx, userId, crm)`. This replaces v1's `Seller` table. |
| `crm.field_mapping` | `id`, `tenant_id`, `system`, `scout_field`, `crm_object` (company, contact, deal), `crm_property`, `direction` (push, read), `transform` (none, cents_to_amount, date, enum_map), `enabled` | Per tenant. Defaults seeded per system. |
| `crm.property_setup` | `tenant_id`, `system`, `group_name`, `created_properties[]`, `set_up_at`, `set_up_by` | Record of the custom fields Scout created. |
| `crm.follow_through` | `handoff_id`, `baseline` (counts at push), `latest` (counts now), `tasks` (id, status, due), `checked_at`, `stage`, `owner_external_id` | Counts since handoff = latest minus baseline. |
| `crm.deal` | `id`, `tenant_id`, `account_id`, `system`, `external_id`, `name`, `stage`, `status` (open, won, lost), `amount_cents`, `currency`, `opened_at`, `closed_at`, `synced_at` | Cache of deal state. Never the source of truth (v1 rule). |
| `crm.activity` | `id`, `tenant_id`, `account_id`, `handoff_id`, `system`, `external_id`, `kind` (email, reply, call, meeting, task_done), `occurred_at` | Each activity seen once; drives `crm.activity.observed`. |
| `crm.task_link` | `step_id`, `system`, `external_task_id`, `due_at`, `status` | Playbook step to CRM task. |
| `crm.setting` | `tenant_id`, `system`, `take_over_stale_ownership`, `push_new_people`, `follow_up_days`, `deals_polled_until` | One row per tenant. `deals_polled_until` is the deal poll's cursor (5 minutes of overlap, 24 hours of look-back the first time). |
| `crm.company_check` | `tenant_id`, `account_id`, `system`, `domain`, `exists`, `company_external_id`, `owner_external_id`, `owner_name`, `lifecycle`, `crm_lifecycle`, `open_deals`, `checked_at` | The CRM check before review. `domain` (lower case) lets a lookup by domain reuse a check younger than 24 hours; `crm_lifecycle` is the CRM's own stage before deals are folded into `lifecycle`. |
| `crm.webhook_receipt` | `id` (`whr_`), `tenant_id`, `connection_id`, `body`, `received_at` | Every inbound HubSpot webhook body, kept as received. |
| `crm.mock_company`, `mock_person`, `mock_note`, `mock_task`, `mock_deal`, `mock_owner`, `mock_property`, `mock_activity`, `mock_failure` | all with `tenant_id` | The mock HubSpot's records (see CRM-E1). `mock_property` holds custom properties, `mock_activity` holds the emails, calls and meetings tests and the seed add, and `mock_failure` (`operation`, `kind` 429, 500 or timeout, `remaining`) makes an operation fail on purpose. |

## Depends on

CRM may call only Accounts, Integrations and Tenancy and access (see `architecture/module-boundaries.md`;
Review and routing and Playbooks call CRM, so CRM must never call them back).

- **Accounts** (sync): account, people, facts, signals, for building the note.
- **Integrations** (sync): a ready CRM client for the tenant, with caps and call logging.
- **Handoff package provider** (inverted dependency): the parts of the note and the tasks that come
  from scoring, offers and playbooks (tier and scores, best offer, fit parts, scored signals, offer
  details and case studies, brief, opener, follow-up sequence, plan steps) are assembled by
  Playbooks, which may call Scoring and Offers. CRM defines the `HandoffPackageProvider` interface in
  `crm/contracts`; Playbooks implements it and the worker's composition root registers it. CRM imports
  nothing from Playbooks. With no provider registered (tests, a stripped build), the handoff sends
  the account, people and a note built from Accounts data only.
- **Tenancy and access** (sync): `crmOwnerId(ctx, userId, crm)` for the seller's CRM owner id on every
  handoff; setting a membership's `crm_owner_ids` when an owner confirms a roster match.

Every CRM call goes through Integrations' `gateway.call(ctx, crm, operation, fn)`, which applies the
tenant's credentials, rate limits, usage caps and call log.

## Epics

| Epic | File | Release |
|---|---|---|
| CRM-E1 Adapter contract | [crm-adapter-contract.md](crm-adapter-contract.md) | R1 |
| CRM-E2 HubSpot connector setup | [hubspot-connector.md](hubspot-connector.md) | R1 |
| CRM-E3 Handoff push | [handoff-push.md](handoff-push.md) | R1 |
| CRM-E4 Handoff batches and messages | [handoff-batches-and-messages.md](handoff-batches-and-messages.md) | R1 |
| CRM-E5 Follow-through, activity and deals | [follow-through-and-deals.md](follow-through-and-deals.md) | R1 (read back, activity and deal events; D32) |
| CRM-E6 CRM-qualified leads in (CRM side) | [crm-qualified-leads-in.md](crm-qualified-leads-in.md) | R1 |
| CRM-E7 Record links and field mapping | [record-links-and-field-mapping.md](record-links-and-field-mapping.md) | R1 (links), R2 (mapping editor) |
| CRM-E8 Salesforce, Dynamics, Dayko Kindle | [other-crm-connectors.md](other-crm-connectors.md) | R4 |

## Events published

| Event | Data |
|---|---|
| `crm.handoff.completed` | `handoffId`, `accountId`, `assignmentId`, `handoffBatchId`, `system`, `companyExternalId`, `personExternalIds[]`, `ownerExternalId`, `ownershipAction` (assign, keep), `takenFromOwner` (nullable), `taskCount`, `companyLifecycle` (`none`, `open_deal`, `customer`: `customer` when the CRM lifecycle is customer or any cached deal is won, `open_deal` when any cached deal is open; ACC uses it with `crm.deal.changed` and `crm.company.checked` to keep `crm_status`), `observedAt` (ACC applies a status only when this is newer than `account.crm_status_at`) |
| `crm.handoff.failed` | `handoffId`, `accountId`, `assignmentId`, `system`, `attempt`, `retryable`, `reason` |
| `crm.handoff.cancelled` | `handoffId`, `accountId`, `assignmentId`, `at`. Internal. Published when a decline or withdrawal stopped a handoff, and when an undo of a completed handoff finished (the handoff stays `completed` with `undone` set) |
| `crm.company.checked` | `accountId`, `system`, `exists`, `companyExternalId` (nullable), `ownerName` (nullable), `companyLifecycle`, `observedAt`. A matched company also gets an `account` link |
| `crm.lead.qualified` | `connectionId`, `contactId`. Internal. Published by the inbound webhook when a lifecycle change matches the qualified-lead rule; Intake consumes it |
| `crm.handoff.needs_decision` | `handoffId`, `accountId`, `assignmentId`, `reason` (open_deal, customer, owned_elsewhere), `currentOwnerName` |
| `crm.activity.observed` | `accountId`, `handoffId` (nullable), `system`, `externalId`, `kind` (email, reply, call, meeting, task_done), `occurredAt`, `actorCrmOwnerId` (nullable), `actorUserId` (nullable: the Scout user whose membership `crm_owner_ids` holds that owner; REV uses it for implied acceptance), `taskExternalId` and `stepId` (for `task_done` on a plan step task). `actorOwnerExternalId` is read from the CRM for each activity, and `actorUserId` comes from Tenancy's `userForCrmOwner` |
| `crm.deal.changed` | `accountId`, `system`, `dealExternalId`, `status` (open, won, lost), `previousStatus` (nullable), `stage`, `amountCents`, `currency`, `openedAt`, `closedAt` (nullable), `companyLifecycle`, `observedAt`. Published only when status or amount changed; a deal first seen already closed publishes its closed status; an unchanged re-read publishes nothing |

`crm.handoff.completed` and `crm.deal.changed` are public webhook event types (see
`public-api/outgoing-webhooks.md`); the others are internal.

## Events consumed

| Event | Does |
|---|---|
| `routing.assignment.created` | Queue `jobs.crm.handoff`, using the assignment's `ownershipDecision` (plain assign, or "push anyway, keep their owner") from REV's preflight. The push always starts on assignment, not acceptance (REV-E3 decision). |
| `routing.assignment.declined` / `.withdrawn` | Undo the handoff (CRM-E3-S7): close the open tasks Scout created with "Declined in Scout: <reason label>", give ownership back to the previous owner recorded on the handoff (or the assigner), add a separate short note. Never delete or edit anything people wrote. A decline that arrives while the push runs sets `cancel_requested_at` first (CRM-E3-S7-AC4). |
| `playbooks.plan.created` / `.changed` | Create, update or close the CRM tasks for the plan's steps on handed-off accounts (step data read from the package provider). |
| `playbooks.step.completed` | Complete the step's CRM task. |
| `accounts.account.merged` | Repoint links from the merged id to the survivor; flag if both had different CRM companies. |
| `jobs.history.republish` | Re-publish stored handoff, activity and deal events with `replay: true` (events-and-async.md). |
| `accounts.person.added` | On a handed-off account whose setting "Push new people" is on (default on) and that has fewer than 10 people linked, queue `crm.person.push`. It pushes with the handoff's owner decision and links the person. |
| `accounts.account.created` / `.updated` | Check the account's company in the CRM (`crm.company.check`) when it has a domain (on `.updated`, only when the domain changed). When the event carries `externalIds`, record them as links (CRM-E6-S2). |
| `accounts.person.updated` | When the event carries `externalIds`, record them as links. |
| `crm.lead.qualified` | Not consumed here; Intake consumes it. |

## Public interface (for other modules)

- `preflightOwnership(ctx, accountId, sellerUserId)` → `{ result: assign | stop, reason, currentOwnerName, takenFrom }` (REV-E3 assign dialog; same pure rule the push uses)
- `getLinks(ctx, accountId)`. There is no `findLinkedAccount`: Accounts already matches arrivals on `external_id` aliases.
- `lookupCompany(ctx, domain)` (read-only CRM check, cached 24 hours), `companyChecks(ctx, accountIds)` (stored checks, at most 200), `latestHandoff` and `lastActivityAt`
- `ownerMatches(ctx)` pairs active members that have no owner id with roster owners of the same email (case-insensitive), computed on read; confirming calls Tenancy `setCrmOwnerIds`. There is no stored suggestion and no `tenancy.member.added` consumer.
- `fetchQualifiedLead(ctx, connectionId, contactId)`, `listQualifiedLeads(ctx, connectionId, since)` (for SRC-E6)
- `handleCrmWebhook(ctx, connectionId, rawBody)` (called by the inbound route; stores the body, enqueues `crm.sync` for each affected linked company, and publishes `crm.lead.qualified` for lifecycle changes that match the rule)
- `followThrough(ctx, accountId)`
- `backfillWonDeals(ctx, { since, limit })` → closed-won deals with company, amount, close date and
  associated contacts, read only (`crm:backfillWonDeals` in OFF's win analysis; default last 24 months
  or 500 deals)
- Implements ACC's `MergeGuard`: `check(ctx, survivorId, mergedId)` refuses a merge when both accounts
  are linked to different CRM companies (from `crm.link`); wired by the composition root (D29).
- `HandoffPackageProvider` (interface, implemented by Playbooks): `package(ctx, accountId, assignmentId)`
  → note sections, first-touch task, follow-up tasks, plan step tasks

## API endpoints

| Method and path | Scope | Does |
|---|---|---|
| `POST /v1/accounts/{id}:push` | `crm:push` | Async. Push or re-push now; body `{ "keep_current_owner": true }` for "push anyway". Retrying a failed handoff is the same call. |
| `GET /v1/accounts/{id}/handoffs` | `accounts:read` | CRM ids and links, handoffs with status and ownership action, follow-through counts, cached deals |

Handoff lists, batches and messages are web-app screens (Sent) in R1, not `/v1` endpoints.

Inbound CRM webhooks are optional; polling is the primary path in R1 (D28, see CRM-E6). When an admin
sets up subscriptions by hand in HubSpot, HubSpot sends every subscription to one URL per connection,
`POST /v1/inbound/hubspot/{connectionId}`. In R1c the route sits outside `v1Route` (it has no principal) and Integrations
checks it: `connectionTenant(connectionId)` finds the tenant, and the v3 signature is verified against the
connection's `client_secret` (a second credential kept beside the token, never the connection's own
credential). It answers 401 when the connection, the secret or the signature is wrong or the timestamp is
over 5 minutes old, and 200 within a second otherwise. The body goes to `handleCrmWebhook` here; contact
lifecycle changes reach Intake as `crm.lead.qualified`, so CRM never imports Intake.

## MCP tools

None of its own. `get_account_status` (REV) includes the CRM owner, link and last activity from this
module's public interface.

## Settings (per tenant)

| Setting | Default |
|---|---|
| CRM system | HubSpot |
| Take over ownership from people not working the account | on |
| Push new people on handed-off accounts | on |
| Follow-up tasks | days 3, 7 and 14 after handoff |
| Activity poll | every 15 minutes (a fixed tenant schedule, not a setting) |
| Deal poll | hourly (fixed) |
| Owner roster | daily at 05:00 UTC (fixed) |
| Field mapping | the `taazaa_*` defaults seeded per tenant (`practice`, `best_offer`, `tier`, `fit`, `intent`, `priority`, `why_now`, `top_signals`, `research_topics`, `last_handoff`, and `scout_link`) |

## Open questions

- Does the leader want the handoff message sent for them (Teams or email) or only shown to copy, as
  today? R1 keeps copy; sending needs a messaging integration.
- If the previous owner recorded on the handoff has since left the company, a decline returns the
  account to the assigner. Is that right for clients, or should it go unowned? R1: the assigner.
