# Taazaa Scout R1c CRM Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An assigned account lands in the tenant's HubSpot within seconds, with the company, people, a context note and dated tasks, owned by the right rep. A decline undoes the push. What reps then do in HubSpot (replies, meetings, deals) comes back as activity and deal events that move the account's stage. HubSpot marketing-qualified contacts arrive in Scout through intake, already linked to their CRM records.

**Architecture:** One new module, CRM sync (`crm` schema), sitting above Accounts, Integrations and Tenancy and below Intake and Routing. Every CRM call goes through one adapter contract (`crm/contracts/adapter.ts`) and the Integrations gateway. A Postgres-backed mock connector runs everything on a laptop, and a live HubSpot connector is ported from v1. The push, undo, follow-through, activity and deal reads are jobs. Routing gets a real ownership preflight through its existing `OwnershipPreflight` port and consumes CRM events for implied acceptance and the later stages. Accounts keeps `crm_status` from CRM events, and CRM implements Accounts' `MergeGuard`. Intake takes in qualified leads through CRM's `fetchQualifiedLead` and `listQualifiedLeads`.

**Tech Stack:** As R1b. No new dependencies; the live connector uses `fetch`.

**Spec:** `docs/spec/crm-sync/` (CRM-E1, E2, E3, E4, E5 without `backfillWonDeals`, E6, E7-S1 and S2; E7-S3 editor is R2), `docs/spec/review-and-routing/ownership-and-handoff-trigger.md` (REV-E3), `docs/spec/review-and-routing/stage-tracking-and-status.md` (REV-E4 CRM stages and the `crm:push` extras), `docs/spec/sources-and-intake/inbound-webhooks.md` (SRC-E6-S1), `docs/spec/integrations/adapter-contract-and-providers.md` (HubSpot credentials), `docs/spec/accounts/merges-and-aliases.md` (the merge guard), `docs/spec/architecture/*`. v1 reference code is in `reference/v1/`: `src/lib/ownership.ts`, `src/lib/handoff.ts`, `src/server/crm.ts`, `src/integrations/hubspot/{index,live,properties}.ts`, `src/lib/hubspotContext.ts`.

## Scope

In: the CRM module with its schema, contract, mock and live HubSpot connectors and contract tests; the HubSpot connection test, property setup and owner roster; links and the CRM check before review; the ownership rule and preflight; handoff push, batches and messages, undo, re-push and push anyway; follow-through, activity and deal reads with their events; the Routing, Accounts and Intake changes they need; every service behind a `/v1` endpoint (including people-only endpoints for the Sent, Team and Settings screens the front end will build); tenant defaults, seed and a backfill.

Out, by owner plan:
- **Playbooks plan (next):** the minimum Playbooks module. It covers the `account_brief` AI task with its rules fallback and the `HandoffPackageProvider` implementation (scores, best offer, fit parts, signals, offer and case studies, brief, opener, follow-up sequence). In R1c the port exists and nothing is registered, so the note is built from Accounts data only, as the spec allows. It also covers the `playbooks.plan.*` and `playbooks.step.completed` consumers and `crm.task_link`; the table is created in R1c and stays empty.
- **R1d:** MCP tools (including `get_account_status` CRM fields over MCP), usage caps through INT `checkCap`, per-minute rate limits, OpenAPI, the v1 data migration, the throughput test.
- **R2:** the field mapping editor (CRM-E7-S3), sending the handoff message for the leader (Teams or email).
- **R3:** `backfillWonDeals` (win analysis is R3), `jobs.history.republish`, Analytics over the events.
- **R4:** Salesforce, Dynamics, Dayko Kindle connectors.
- **Front end:** every screen, and in-app notices (REV-E3-S2-AC2 "notifies the assigner"); the events they come from are published here.

## Design

| Aggregate | Owner | Invariants it guards | Consistency boundary |
|---|---|---|---|
| Handoff (handoff row, its links, follow-through) | CRM | One handoff per assignment; at most one push or undo running per account; a completed write always has its link; nothing a person wrote in the CRM is deleted or blanked | Advisory lock `crm:<tenant>:<account>` held by every job that writes to the CRM for an account |
| Handoff batch and messages | CRM | One batch per leader action; one message per seller per batch, listing only completed handoffs | Batch row lock |
| Link | CRM | One row per (system, scout type, scout id, external id); a link points at the survivor after a merge | Unique index |
| Deal and activity cache | CRM | Each activity once per (system, external id); a deal event only on a change in status or amount | Unique indexes |
| CRM owner roster | CRM | One row per (system, external owner id) | Unique index |
| Account review | Routing | As R1b; CRM events change flags and stages through the same row lock and one snapshot per write | `account_review` row lock |
| Account `crm_status` | Accounts | Applied only from an event newer than the stored `crm_status_at` | Account lock |

Layers as in R1a and R1b: `domain/` pure (ownership rule, note and task builders, field transforms, batch name and message, follow-through counts, webhook signature), `services/` transaction scripts, `contracts/` (adapter, events, jobs, ports, types), `adapters/hubspot/{mock,live}.ts`, `db/`, `index.ts` facade.

Dependency direction (module-boundaries.md): CRM calls only Accounts, Integrations and Tenancy. Intake and Routing call CRM's `index.ts`. CRM learns about Routing and Intake only by consuming their events (`routing/contracts/events.ts`), the same allowance R1b used. CRM imports nothing from Routing, Scoring, Offers or Playbooks.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **The ownership preflight stays a port.** CRM implements Routing's `OwnershipPreflight` and the composition root registers it. Results: `new` = no company in the CRM; `assign` = the seller can take it, and the message says who had it; `stop` = only "Push anyway, keep their owner" can go ahead; `blocked` = the seller has no CRM owner. Messages:
   - `New in the CRM`
   - `In the CRM with no owner: will move to <seller first name>`
   - `Already owned by <seller first name>`
   - `Owned by <name>: will move to <seller first name>`
   - `Owned by <name> (inactive): will move to <seller first name>`
   - `Open deal owned by <name>: will not change owner`
   - `Customer owned by <name>: will not change owner`
   - `Owned by <name>: will not change owner`
   - `<seller first name> has no HubSpot owner set. Set it in Members first.` when the seller has no owner id.
   - `Link this person to a HubSpot owner first` when the seller's owner id is inactive in a roster that has been synced. An empty roster counts as unknown, which means allowed.
   
   `<name>` is the roster name, or `HubSpot owner <id>` when the owner is not in the roster. Results by message: the first is `new`; the next four are `assign`; the three that say "will not change owner" are `stop`; the last two are `blocked`.
2. **The mock CRM is Postgres-backed and commits on its own.** `AdapterFactories.mock` becomes `(ctx: ModuleContext) => Adapter`, and existing mocks ignore the argument. The HubSpot mock writes each record in its own transaction (`withTenant`), like a real CRM that doesn't roll back. Mock tables are the spec's six plus two:
   - `mock_activity`, which tests and the seed add to
   - `mock_failure` (`operation`, `kind` 429, 500 or timeout, `remaining`), set by `setMockFailure(ctx, operation, kind, times)`
   
   Mock external ids are `mock-co-<n>`, `mock-ct-<n>`, `mock-nt-<n>`, `mock-tk-<n>`, `mock-dl-<n>` and `mock-ow-<n>`, numbered per tenant.
3. **Links are written per CRM write and committed on their own** (`recordLink`, own transaction), so a push that fails and rolls back still leaves its links. A retry finds them and updates instead of creating (CRM-E3-S5-AC3).
   - Note link: `scout_type` `note`, `scout_id` = account id, `fingerprint` = note fingerprint.
   - Task links: `scout_type` `task`, with `scout_id` `<assignmentId>:first_touch` or `<assignmentId>:follow_up:<day>`. A re-push of the same assignment updates its tasks in place. A reassignment gets fresh tasks for the new seller, so the old assignment's undo closes only its own.
   - Company and person links: `scout_type` `account` and `person`.
   - Deal links: `scout_type` `deal`, `scout_id` = the `crm.deal` id.
4. **Retries and attempts.** The `crm.handoff.push` job has `maxDeliver` 6 and the platform backoff. Each run first increments `handoff.attempts` and sets `running` in its own transaction.
   - A retryable error is rethrown: timeouts, 429 (`RateLimitedError`) and 5xx.
   - On the run where `attempts` reaches 6, or on a non-retryable error, the handler marks the handoff `failed`, publishes `crm.handoff.failed` and returns normally. Non-retryable means 401, 403, other 4xx, validation, or a seller with no CRM owner.
   - Failure reasons are plain words, kept to 300 characters: `HubSpot refused the token. Enter a new one in Integrations.`, `HubSpot needs another permission: <scope>.`, `This seller isn't linked to a CRM owner`, `HubSpot was busy and every retry failed.`
5. **Per-account serialisation.** Push, undo, person push and sync jobs take `pg_advisory_xact_lock(hashtext('crm:' || tenant || ':' || account))` first. A lock wait past the worker's busy timeout puts the message back without counting a run.
6. **Decline during a push** (CRM-E3-S7-AC4). The decline or withdraw consumer sets `handoff.cancel_requested_at` on the assignment's handoff in its own transaction and enqueues `crm.handoff.undo`. The push re-reads `cancel_requested_at` (committed state) before each CRM write. When it finds the flag, it stops with status `cancelled`. The undo job takes the same account lock, so it runs after the push and undoes what the links show was written. A handoff that never started (`queued`) becomes `cancelled` with nothing to undo.
7. **Undo**, per CRM-E3-S7.
   - Close the open tasks Scout created for that assignment, with `Declined in Scout: <reason label>` or `Withdrawn in Scout`.
   - Ownership: when `ownership_action` is `assign` and the company is still owned by our seller, the company, and the people Scout set an owner on, go back to `taken_from_owner`. When none was recorded or that owner is inactive, they go to the assigner's CRM owner. When the assigner has none, the owner stays and the undo records `Owner left as is: <assigner> has no HubSpot owner`. A `keep` handoff changes no owner.
   - Add a separate short note on the company: `Returned by <seller name> on <Mon D, YYYY>: <reason label>`, or `Withdrawn by <assigner name> on <date>`. The context note is never edited by an undo.
   - Record `handoff.undone = { tasksClosed[], tasksLeftDone[], ownerReturnedTo, noteExternalId, at }`.
   - `routing.assignment.declined` gains `reasonLabel` (additive).
8. **Batches follow the leader action.** `routing.assignment.created` gains `bulkId` (nullable; `bulk()` sets one `newId('blk')` for its run, a single assign sends null). CRM finds or creates `crm.handoff_batch` by (`tenant_id`, `bulk_key`); a null key makes its own batch. The batch name and the per-seller messages are rewritten whenever one of the batch's handoffs completes, fails, needs a decision or is cancelled.
9. **The note without a package.** `buildNote` takes an optional `HandoffPackage`. Its `sections` come first, in the provider's order. Then the Accounts sections:
   - People: every person, with buying roles and email quality, primary first.
   - Company: description, industry, size, location and tech stack.
   - Data as of: the latest fact date.
   - The leader's assignment note.
   - The owner line, with "reassigned from <name>" when ownership was taken.
   - `Open in Scout: <APP_PUBLIC_URL>/t/<slug>/accounts/<id>`.
   
   HubSpot's limit is `NOTE_LIMIT = 65_000` characters. Over it, sections are dropped from the bottom, never the Scout link, and `More in Scout` with the link is added. Text from the package keeps its own "Written by Claude" or "Assembled from rules" labels.

   With no provider registered, the tasks are:
   - First touch, due on the handoff day: `First touch: <buyer name> at <account>`, or `First touch: <account>` when there is no buyer. The body is `Start with <buyer>, <title> (<email>).`, or the v1 "No buyer contact yet" sentence.
   - One follow-up per `follow_up_days` entry, due that many days after the handoff: subject `Follow-up <i> of <n> (day <d>): email <buyer or account>`, body `No follow-up email written yet. Write to <buyer> about <offer or account>.`
   
   A package's `firstTouch` and `followUps` replace these.
10. **Field mapping (R1c part of CRM-E7).** Default `crm.field_mapping` rows for HubSpot are seeded per tenant. The `taazaa_*` property names from `reference/v1/src/integrations/hubspot/properties.ts` are kept, so v1 properties map unchanged:

    | Scout field | Property | Transform |
    |---|---|---|
    | practice | `taazaa_bucket` | none |
    | best offer | `taazaa_best_offer` | none |
    | tier | `taazaa_tier` | `enum_map` act_now Act now, good_fit Good fit, watch Watch, not_fit Not a fit |
    | fit | `taazaa_fit_score` | none |
    | intent | `taazaa_signal_score` | none |
    | priority | `taazaa_total_score` | none |
    | why now | `taazaa_why_now` | none |
    | top signals | `taazaa_top_signals` | none |
    | research topics | `taazaa_research_topics` | none |
    | last handoff | `taazaa_last_pushed` | `date` |
    | Scout link | `scout_link` (new) | none |

    Values come from the package's `properties` plus CRM's own `scout_link` and `last_handoff`. A missing value is not sent. A property that doesn't exist in HubSpot is skipped. "Set up HubSpot fields" creates the group `scout_buyer_signals` ("Scout buyer signals") and only the properties that are missing; existing `taazaa_*` properties are left where they are.
11. **The CRM check before review** (CRM-E7-S2). CRM consumes `accounts.account.created`, and `accounts.account.updated` when `domain` changed. For an account with a domain it calls `findCompany`, stores the result in `crm.company_check` (`account_id`, `system`, `exists`, `company_external_id`, `owner_external_id`, `owner_name`, `lifecycle`, `open_deals`, `checked_at`) and publishes the new event `crm.company.checked { accountId, system, exists, companyExternalId, ownerName, companyLifecycle, observedAt }`. A matched company also gets an `account` link. `lookupCompany(ctx, domain)` returns a check younger than 24 hours, else calls the CRM. `findLinkedAccount` is not built, because Accounts already matches arrivals on `external_id` aliases.
12. **`companyLifecycle`** (`none`, `open_deal`, `customer`) is `customer` when the CRM lifecycle is `customer` or any cached deal is won. It is `open_deal` when any cached deal is open, else `none`. It goes on `crm.company.checked`, `crm.handoff.completed` and `crm.deal.changed` (all with `observedAt`). Accounts sets `crm_status` from any of them when `observedAt` is newer than `account.crm_status_at` (new column), then re-evaluates exclusions as an edit does.
13. **External ids through intake.** Intake's `SubmitOptions` gains `externalIds?: { account?: { system; id }[]; people?: { index: number; system: string; id: string }[] }`, stored on the arrival (`arrival.external_ids jsonb`), not part of `arrival.v1`. Resolve passes them into `ArrivalForAccounts.externalIds` and a new `ArrivalPerson.externalIds`. Accounts writes them as aliases and adds an optional `externalIds` (the ones this write added) to `accounts.account.created`, `accounts.account.updated`, `accounts.person.added` and `accounts.person.updated`. CRM's consumer turns them into links (CRM-E6-S2).
14. **Qualified leads.**
    - `listQualifiedLeads(ctx, connectionId, since)` and `fetchQualifiedLead(ctx, connectionId, contactId)` check that `connectionId` is the tenant's HubSpot connection and call through the gateway by provider.
    - The rule is `connection.settings.qualified_lead_rule = { property, value }`, default `lifecyclestage` = `marketingqualifiedlead`. It is edited through `PUT /v1/settings/crm` with INT's new `setConnectionSettings`.
    - Intake polls every 15 minutes with `intake.qualified_leads.poll`, keeping `polled_until` per connection in `intake.crm_lead_poll`, at most 200 contacts per run, oldest first.
    - It submits each lead with channel `webhook`, sender the `hubspot_qualified` source (system actor), `external_ref` = `hubspot:<contactId>:<qualified date YYYY-MM-DD>` (the idempotency key), and `externalIds` for the company and the contact.
    - A contact with no company becomes an arrival with the person and the email domain as the website, and intake's normal rules decide from there. A free-mail domain becomes a shell account.
15. **The inbound webhook** is `POST /v1/inbound/hubspot/{connectionId}`, outside `v1Route` (no principal).
    - INT gains `connectionTenant(connectionId)`, an adminDb lookup that returns `{ tenantId, provider }` or null, in the new file `src/modules/integrations/services/inbound.ts`. That file is added to `ADMIN_DB_ALLOWED` in `eslint.config.mjs`, with the reason that an unauthenticated webhook has no tenant until its connection is found. INT also gains `webhookSecret(ctx, provider)`, which returns the decrypted `client_secret` or null.
    - The route answers 401 when the connection, the secret or the v3 signature is wrong, or the timestamp is older than 5 minutes; each refusal is logged. Otherwise it answers 200 within 1 second.
    - It stores nothing in intake. It calls CRM `handleCrmWebhook(ctx, connectionId, rawBody)`, which stores the body in `crm.webhook_receipt` and parses it. Deal and engagement events enqueue `crm.sync` for each affected linked company. Lifecycle events matching the rule publish the new event `crm.lead.qualified { connectionId, contactId }`, which intake consumes. CRM never imports intake, which would be an import cycle.
    - Signature verification is a pure CRM function: `verifyHubSpotV3(secret, { method, url, rawBody, timestamp, signature }, now)`.
16. **The HubSpot `client_secret` is a second credential.** `saveCredential(ctx, 'hubspot', { kind: 'client_secret' })` stores it beside the token, replacing an earlier `client_secret` only. It never becomes `connection.credential_id`. `TestResult` gains `facts?: Record<string, string>`, merged into `connection.settings` after a passing test. HubSpot uses it for `portal_id` and `portal_name`, which build `https://app.hubspot.com/contacts/<portal_id>/record/0-2/<company id>`.
17. **Follow-through and activity.**
    - The poll covers handed-off accounts whose latest handoff completed within 180 days, ordered by `follow_through.checked_at` ascending, at most 200 per run.
    - For each one it reads `readFollowThrough` (task statuses and counts; `latest` minus `baseline`, never below 0) and `listActivities(company, since)`.
    - `since` is the later of the handoff's `completed_at` and the last activity seen.
    - `listActivities` gains `actorOwnerExternalId` (CRM-E5-S2-AC3), and `actorUserId` comes from tenancy's `userForCrmOwner`.
    - A task Scout created that turns completed becomes a `task_done` activity whose `externalId` is the task id.
    - Polls are fixed in R1c: activity every 15 minutes, deals hourly, owners daily at 05:00 UTC. They are tenant schedules, not settings.
18. **Deals.** The hourly poll calls `listDeals({ changedSince })` once and keeps only deals whose company has an `account` link. A deal is new when there is no `crm.deal` row (status `open` publishes `open`, a deal first seen closed publishes its status). `crm.deal.changed` is published when status or amount changed. An unchanged re-read publishes nothing. `crm.sync { accountId }` (from webhooks, or "Check follow-through") reads one account's follow-through, activities and deals now.
19. **Routing on CRM events.**
    - `crm.activity.observed` with `actorUserId` equal to the open pending assignment's seller accepts it, with `acceptedHow` `crm_activity`.
    - Kind `reply` or `meeting` moves the stage to `engaged` (cause `<eventId>`).
    - `crm.deal.changed` `open` moves to `opportunity`, `won` to `won` and `lost` to `lost`.
    - `crm.handoff.completed`, `.failed`, `.needs_decision` and `.cancelled` (a new internal event) set `account_review.flags.handoff = { handoffId, state: sending | in_crm | needs_decision | failed | cancelled, reason?, currentOwnerName?, at }`, and `routing.assignment.created` sets `sending`. A state change follows the event order by `at` (later wins).
    - Two new `REVIEW_FLAGS` strings go to the summary: `handoff_needs_decision` and `handoff_failed`.
    - `getAccountStatus` adds `handoff: { status, ownership_action, crm_url }` and `last_activity_at` for principals with `crm:push`, read through CRM `latestHandoff` and `lastActivityAt`. Queue rows gain `crm: { exists, ownerName, lifecycle }` from CRM `companyChecks(ctx, accountIds)`.
20. **Re-push.** `push(ctx, accountId, { keepCurrentOwner })` uses the latest handoff's assignment and seller. CRM knows assignments only from events, so it refuses with 409 `Assign it before pushing.` when there is none, or when that assignment was declined or withdrawn (its handoff was undone or cancelled). A retry of a failed handoff is the same call.
21. **Owner matches are computed on read.** `ownerMatches(ctx)` pairs active members that have no owner id for the CRM with roster owners of the same email, case-insensitive. Confirming calls tenancy `setCrmOwnerIds`. No stored suggestion and no `tenancy.member.added` consumer.
22. **Push new people.** CRM consumes `accounts.person.added`. When the account has a completed handoff, the setting is on, and the account has fewer than 10 people linked, it enqueues `crm.person.push { accountId, personId }`. That job pushes with the handoff's owner decision and links the person.

## Global Constraints

- Everything in R1a's and R1b's Global Constraints holds:
  - every `crm` table has `tenant_id` and forced RLS
  - module imports only through `index.ts` or `contracts/*`
  - prefixed ULIDs, snake_case JSON, problem+json errors
  - no em dashes in copy
  - every POST, PUT or PATCH goes through `v1Route` with bounded bodies and idempotency, except the inbound webhook (Ruling 15)
  - domain functions take `now`
- New schema `crm` (Task 1):
  - bootstrap grants and default privileges
  - `MODULE_ORDER` (`… accounts, crm, intake, scoring, routing`) and the migrate test's order
  - `drizzle/crm.config.ts`, Dockerfile `COPY`, RLS catalog test
  - `src/entry/registry.ts`, `src/entry/compose.ts`, `src/entry/worker.ts`
- New id prefixes, added to `src/platform/ids.ts` by Task 1:
  - `hof_` handoff, `hbt_` handoff batch (both in data conventions)
  - `lnk_` link, `hmg_` handoff message, `cow_` CRM owner, `fmp_` field mapping, `dea_` deal, `cac_` activity, `whr_` webhook receipt, `blk_` bulk action
- CRM settings (`crm.setting`, one row per tenant), with defaults: `system` `hubspot`, `take_over_stale_ownership` true, `push_new_people` true, `follow_up_days` `[3, 7, 14]`. The days list holds 1 to 5 unique ascending integers, each 1 to 60.
- Limits:
  - at most 10 people per push, primary first
  - note `NOTE_LIMIT` 65,000 characters
  - failure reason 300 characters
  - polls 200 accounts or contacts per run
  - roster sync up to 2,000 owners
- Mock CRM fixtures (`seedMockCrm(ctx)`, used by seed and tests):
  - an owner for each member's `crm_owner_ids.hubspot`
  - `Rahul Mehta` (inactive) and `Vijay Kumar` (active)
  - companies `owned-elsewhere.example` (owner Vijay), `open-deal.example` (owner Vijay, one open deal), `customer.example` (owner Vijay, lifecycle customer) and `inactive-owner.example` (owner Rahul)
  - one qualified contact `pat.lee@qualified.example` at `qualified.example`
- Copy (exact), besides the Rulings:
  - `Assign it before pushing.`
  - `Set up HubSpot fields`
  - `Owner list can't be read, so Scout can't name who owns a company`
  - `Two HubSpot companies are linked`
  - `Not sent yet`
  - `Declined in Scout: <reason>`
  - `Withdrawn in Scout`
  - `More in Scout`
  - `This environment uses sample data only.` (INT's `SAMPLE_ONLY`, for simulate outside mock)

## Review Focus

1. **A seller declines while the push is running, or before it starts.** Expected: the push stops after its current write; the undo closes every open task Scout wrote and returns ownership; nothing is left owned by the seller; nothing a person wrote is deleted. Test in Task 9.
2. **`routing.assignment.created` arrives twice, and the CRM returns 429 then 500 partway through a push.** Expected: one handoff; on retry, one company, no duplicate people, notes or tasks; `attempts` counts the runs; the links written before the failure are reused. Test in Task 7.
3. **A rep edited the context note and completed the first-touch task, then the leader pushes again.** Expected: a new note is added and the edited one kept; the completed task is not reopened and no duplicate is created; the other tasks update in place. Test in Task 10.
4. **The same activity comes by webhook and by poll, an unchanged deal is re-read, and the company had activity before the handoff.** Expected: one `crm.activity.observed`; no `crm.deal.changed`; follow-through counts exclude the baseline. Tests in Tasks 11 and 12.
5. **A qualified contact is polled twice and also arrives by webhook, and another qualified contact has no company.** Expected: one arrival per contact per qualified date; the no-company contact arrives through intake's normal rules; both accounts are linked to their HubSpot records. Test in Task 15.

## File Structure

```
src/modules/crm/
  index.ts contracts/{adapter,events,jobs,ports,types}.ts db/schema.ts db/migrations/
  adapters/hubspot/{mock,live,properties,register}.ts
  domain/{ownership,note,tasks,fields,batch,message,follow-through,webhook}.ts
  services/{links,checks,owners,preflight,handoff,batches,undo,push,follow-through,deals,leads,webhook,settings,read,merge}.ts
  jobs.ts consumers.ts defaults.ts fixtures.ts
src/modules/integrations/          mock factory takes ctx, client_secret beside the token, TestResult.facts, setConnectionSettings, connectionTenant, webhookSecret
src/modules/routing/               bulkId, reasonLabel, handoff flags, CRM consumers, status and queue CRM fields
src/modules/accounts/              crm_status_at and consumers, externalIds on aliases and events
src/modules/intake/                arrival.external_ids, qualified lead poll and fetch jobs, crm_lead_poll
src/app/v1/                        accounts/{id}:push, accounts/{id}/handoffs, handoff-batches, handoff-messages, crm/*, settings/crm, inbound/hubspot/{connectionId}
tests/unit/crm/  tests/integration/crm/  tests/contract/crm/
```

---

### Task 1: CRM module schema, contracts, ports and tenant defaults

**Files:**
- Create:
  - `src/modules/crm/{index.ts,contracts/adapter.ts,contracts/events.ts,contracts/jobs.ts,contracts/ports.ts,contracts/types.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`
  - `drizzle/crm.config.ts`
- Modify:
  - `src/platform/db/bootstrap.sql`, `src/platform/db/migrate.ts`, `tests/integration/platform/migrate.test.ts`, `infra/docker/Dockerfile`
  - `src/entry/{registry,compose,worker}.ts`, `src/platform/ids.ts`, RLS catalog test
  - `src/modules/integrations/providers.ts`, plus each existing `registerAdapter` call (Ruling 2)
- Test: `tests/integration/crm/defaults.test.ts`, `tests/integration/platform/rls-catalog.test.ts`

**Interfaces:**
- Tables from the CRM index, each with `tenant_id`. Additions:
  - `handoff`: `owner_external_id`, `company_external_id`, `cancel_requested_at`, `undone jsonb`, status `cancelled`
  - `handoff_batch.bulk_key` (unique per tenant when not null)
  - `company_check` (Ruling 11), `setting`, `webhook_receipt`
  - the mock tables (Ruling 2)
  - unique `activity (tenant_id, system, external_id)`, `deal (tenant_id, system, external_id)`, `owner (tenant_id, system, external_owner_id)`, `handoff (tenant_id, assignment_id)`
- `contracts/adapter.ts`: Zod input and output schemas for every operation in CRM-E1, and `type CrmAdapter = Adapter & { capabilities; findCompany(…); … }`.
  - `listActivities` output adds `actorOwnerExternalId: string | null` (Ruling 17).
  - `test()` returns `facts` (Ruling 16).
  - `capabilities = { webhooks: { deals, activities, lifecycle }, customProperties, taskDueDates, noteFingerprint, ownerRoster }`.
- `contracts/events.ts`: the five events of the CRM index, with `companyLifecycle` and `observedAt` (Ruling 12); `crm.company.checked` (Ruling 11); `crm.handoff.cancelled { handoffId, accountId, assignmentId, at }`; `crm.lead.qualified { connectionId, contactId }` (Ruling 15).
- `contracts/jobs.ts`:
  - `crm.handoff.push { handoffId }` (maxDeliver 6), `crm.handoff.undo { handoffId }`, `crm.person.push { accountId, personId }`, `crm.sync { accountId }`
  - `crm.activity.poll {}`, `crm.deals.poll {}`, `crm.owners.sync {}`, `crm.company.check { accountId }`
- `contracts/ports.ts`: `HandoffPackageProvider { package(ctx, accountId, assignmentId): Promise<HandoffPackage | null> }`, with `registerHandoffPackageProvider(p | null)` and `handoffPackageProvider()`. The default returns null.
  - `HandoffPackage = { sections: { key; label; html }[]; properties: Record<string, string | number | null>; firstTouch: { subject; body } | null; followUps: { day; subject; body }[]; planSteps: { stepId; subject; body; dueAt }[] }`
- `seedCrmDefaults(ctx)`: the setting row, the HubSpot field mapping rows (Ruling 10), and the three schedules (Ruling 17). Consumer `crm.tenant_defaults` on `tenancy.tenant.created`.

- [ ] **Step 1: Write failing tests.**
  - Defaults are written once and twice changes nothing.
  - Every `crm` table is under forced RLS.
  - Migrate order includes `crm` after `accounts`.
  - Each adapter schema parses a valid sample and rejects one missing a required field.
  - The default package provider returns null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `platform/rls`, `platform/migrate` and `integrations`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): schema, contracts, ports and tenant defaults`.

### Task 2: Mock HubSpot connector and the contract test suite

**Files:**
- Create: `src/modules/crm/adapters/hubspot/{mock,register}.ts`, `src/modules/crm/fixtures.ts`, `tests/contract/crm/adapter.contract.ts`, `tests/integration/crm/mock-contract.test.ts`
- Modify: `src/modules/crm/index.ts`, `src/entry/compose.ts` (register the HubSpot adapter)

**Interfaces:**
- `hubspotMock(ctx): CrmAdapter`. It implements every operation over the mock tables, with each write in its own transaction (Ruling 2), and follows the same rules as the live connector:
  - find by domain, email, or name plus company
  - never replace an owner except `replaceableOwner`
  - a note fingerprint mismatch adds a new note (`kept: true`)
  - a completed task is not reopened
  - money in cents
  - `listQualifiedLeads` reads `mock_person.lifecycle` against the rule
  - it consults `mock_failure` first and throws `RateLimitedError`, an error with `status` 500, or a timeout error
- `seedMockCrm(ctx)` adds the fixtures (Global Constraints). Test helpers: `setMockFailure`, `mockEditNote(ctx, externalId)`, `mockCompleteTask`, `mockAddActivity`, `mockAddDeal`, `mockSetDeal`.
- `runAdapterContract(make: () => CrmAdapter, opts)` is the shared suite (CRM-E1-S1-AC2). It checks each operation's output schema, and that the same input twice gives the same external ids and no duplicates. The live run is skipped unless `SCOUT_LIVE_HUBSPOT_TOKEN` is set.

- [ ] **Step 1: Write failing tests.**
  - The contract suite passes on the mock.
  - CRM-E1-S3-AC2: owned elsewhere, open deal, customer, an edited note gives `kept: true`, 429 gives `RateLimitedError`, and 500 throws with status 500.
  - CRM-E1-S3-AC1: a record created by one transaction is visible to a fresh one, and each call writes an integration call log row with `provider` `hubspot`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): Postgres-backed mock HubSpot and the adapter contract suite`.

### Task 3: Live HubSpot connector and connection test

**Files:**
- Create: `src/modules/crm/adapters/hubspot/{live,properties}.ts`, `tests/unit/crm/hubspot-live.test.ts`
- Modify:
  - `src/modules/crm/adapters/hubspot/register.ts`
  - `src/modules/integrations/{providers.ts,services/connections.ts,index.ts}` (Ruling 16: `TestResult.facts`, `client_secret` beside the token, `setConnectionSettings(ctx, provider, patch)`)
- Test: `tests/unit/crm/hubspot-live.test.ts`, `tests/integration/integrations/hubspot-credentials.test.ts`

**Interfaces:**
- `hubspotLive(creds: LiveCredentials, fetchImpl = fetch): CrmAdapter`, ported from `reference/v1/src/integrations/hubspot/live.ts`:
  - same endpoints, association ids, ownership rules and note fingerprint (`sha1` of whitespace-collapsed body)
  - Zod-validated responses
  - it never reads env vars
  - idempotent reads retry twice with jitter, and a 429 throws `RateLimitedError` with `Retry-After`
  - it adds `listActivities` (emails, calls and meetings associated with the company since a time; `hs_email_direction = INCOMING_EMAIL` gives kind `reply`; `hubspot_owner_id` gives the actor), `listDeals` (by company, or by `hs_lastmodifieddate` since), `listQualifiedLeads` / contact read, `closeTask`, `verifyWebhook` and `parseWebhook`
- `test()` reads account details and the token's scopes. It returns `facts: { portal_id, portal_name }`, and `missingPermissions` in plain words for any missing scope out of companies, contacts, notes and tasks (through companies and contacts), deals read, owners read and properties write. Missing owners read passes with the warning `Owner list can't be read, so Scout can't name who owns a company` (CRM-E2-S1-AC2).
- `properties.ts`: `PROPERTY_GROUP = { name: 'scout_buyer_signals', label: 'Scout buyer signals' }` and the property definitions (v1's list plus `scout_link`). `setUpProperties` creates only the ones `existingProperties` lacks.

- [ ] **Step 1: Write failing tests** with a fake `fetch`:
  - a company found by domain and updated without taking an owner set by someone else
  - an edited note gives a new note with `kept: true`
  - a completed task is not patched
  - 429 then success retries for a read and throws `RateLimitedError` for a write
  - 401 gives a non-retryable error
  - `test()` lists missing scopes and passes with the owners warning
  - the token never appears in a thrown message
  - set-up run twice creates nothing the second time
  - a `client_secret` save leaves `credential_id` on the token
  - passing test facts land in `connection.settings`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `integrations`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): live HubSpot connector, connection test facts and webhook secret`.

### Task 4: Links, CRM check and owner roster

**Files:**
- Create: `src/modules/crm/services/{links,checks,owners}.ts`
- Modify: `src/modules/crm/{consumers,jobs,index}.ts`, `src/entry/worker.ts`
- Test: `tests/integration/crm/{links,checks,owners}.test.ts`

**Interfaces:**
- Links:
  - `recordLink(ctx, { scoutType, scoutId, system, externalId, fingerprint? })` (own transaction, upsert, `last_synced_at`)
  - `getLinks(ctx, accountId)` → `{ company, people[], note, tasks[], deals[], conflict: boolean }`, where `conflict` means two company links (CRM-E7-S1)
  - `companyLink(ctx, accountId, system)`
- Checks:
  - `lookupCompany(ctx, domain)` (Ruling 11, 24-hour cache)
  - `checkCompany(ctx, accountId)` (stores the check, records a company link when found, publishes `crm.company.checked`)
  - `companyChecks(ctx, accountIds)` (at most 200)
  - consumers on `accounts.account.created` and on domain changes in `accounts.account.updated`, which enqueue `crm.company.check`
- Owners:
  - `syncOwners(ctx)` → `{ count }` (upsert `crm.owner`, active flag; refused with the warning copy when the test showed no owners read)
  - `listOwners(ctx)`, `ownerMatches(ctx)` and `confirmOwnerMatch(ctx, { userId, externalOwnerId })` (Ruling 21; refuses an owner another member holds)
  - `ownerName(ctx, system, externalOwnerId)`, `isOwnerActive(…)` → true, false, or null for unknown
  - job `crm.owners.sync` (daily)
- Consumer on `accounts.account.created/updated/person.added/person.updated` `externalIds` → `recordLink` (Ruling 13; the event field is added in Task 15, and the consumer reads it as optional).

- [ ] **Step 1: Write failing tests.**
  - A new account at `open-deal.example` gets a check with `exists`, `ownerName: 'Vijay Kumar'`, `companyLifecycle: 'open_deal'`, a company link and one `crm.company.checked`.
  - A second lookup inside 24 hours makes no CRM call (call log count).
  - A shell account with no domain is not checked.
  - Owner sync is idempotent and marks Rahul inactive.
  - A member with the same email as an owner is offered as a match, and confirming writes `crm_owner_ids.hubspot`.
  - `getLinks` reports `conflict` with two company links.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): links, the CRM check before review and the owner roster`.

### Task 5: Ownership rule and preflight

**Files:**
- Create: `src/modules/crm/domain/ownership.ts`, `src/modules/crm/services/preflight.ts`
- Modify: `src/modules/crm/index.ts`, `src/entry/compose.ts` (`registerOwnershipPreflight(crmOwnershipPreflight)`)
- Test: `tests/unit/crm/ownership.test.ts`, `tests/integration/crm/preflight.test.ts`, `tests/integration/v1/routing.test.ts` (assign preview)

**Interfaces:**
- `decideOwnership(input: OwnershipInput): OwnershipDecision`, ported unchanged from `reference/v1/src/lib/ownership.ts`. The types are the same: `existing`, `ownerId`, `pushedOwnerId`, `currentOwnerActive`, `takeOver`, `allowOtherOwner` → `assign { replaceOwnerId, takenFrom } | keep { reason } | stop { reason }`.
- `preflightOwnership(ctx, accountId, sellerUserId)` → `{ result: 'new' | 'assign' | 'stop' | 'blocked', message, reason: 'open_deal' | 'customer' | 'owned_elsewhere' | 'no_owner' | null, currentOwnerName, takenFrom }`. Its inputs:
  - the seller's owner id (`crmOwnerId`)
  - the company (fresh `findCompany` through the company link or domain, which refreshes the check)
  - `pushedOwnerId` (the latest completed `assign` handoff's `owner_external_id`)
  - the roster's active flag
  - the `take_over_stale_ownership` setting
  - `allowOtherOwner` false
  
  Messages follow Ruling 1.
- `crmOwnershipPreflight: OwnershipPreflight` maps it to `{ result, message }`.

- [ ] **Step 1: Write failing tests.**
  - One unit test per row of the CRM-E3 ownership table, plus "owned by the owner we set last time".
  - With the mock fixtures, preflight for each fixture company gives the exact Ruling 1 message.
  - A seller with no owner id is `blocked` with `Ash has no HubSpot owner set. Set it in Members first.`
  - A seller linked to an inactive roster owner is `blocked` with `Link this person to a HubSpot owner first`.
  - `GET /v1/accounts/{id}:assign-preview` shows the real preflight, and `assign` without `keep` on `open-deal.example` is 409 with the preflight message.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `routing`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): ownership rule and the real preflight for assignments`.

### Task 6: Note, tasks and field values (pure)

**Files:**
- Create: `src/modules/crm/domain/{note,tasks,fields}.ts`
- Test: `tests/unit/crm/{note,tasks,fields}.test.ts`

**Interfaces:**
- `buildNote(input: NoteInput): { html: string; droppedSections: string[] }`.
  - `NoteInput = { account; people; assignmentNote; ownerLine; scoutUrl; dataAsOf; pkg: HandoffPackage | null }`
  - It follows Ruling 9: HTML-escaped, the v1 `esc` rules, the section order, the 65,000 cap and `More in Scout`.
- `buildTasks(input: { account; buyer; offerName; followUpDays; handoffAt; pkg }): { firstTouch: TaskSpec; followUps: (TaskSpec & { day })[] }`, where `TaskSpec = { subject; body; dueAt }` and dates are computed in the tenant timezone.
- `propertyValues(mappings, values, existing: Set<string>, now): Record<string, string | number>`, applying `none`, `cents_to_amount`, `date` and `enum_map`, and dropping empty values and properties that don't exist (CRM-E3-S3-AC3, Ruling 10).
- `noteFingerprint(html)`: the same as live.

- [ ] **Step 1: Write failing tests.**
  - The section order with and without a package.
  - Every section with data is present, and an empty one is absent (CRM-E3-S3-AC1).
  - A 70,000-character input drops sections from the bottom, keeps the Scout link and adds `More in Scout` (CRM-E3-S3-AC4).
  - Names containing `<script>` are escaped.
  - Follow-up subjects and due dates for days 3, 7 and 14 from a Friday in `America/New_York`.
  - A package's tasks replace the defaults.
  - `enum_map` for tier, a value that is null or empty is never sent, and a property that doesn't exist is skipped.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): note, task and field value builders`.

### Task 7: Handoff push

**Files:**
- Create: `src/modules/crm/services/handoff.ts`
- Modify:
  - `src/modules/crm/{consumers,jobs,index}.ts`
  - `src/modules/routing/contracts/events.ts` (`bulkId` on `assignment.created`, `reasonLabel` on `assignment.declined`), `src/modules/routing/services/{assign,respond}.ts`
  - `src/entry/worker.ts`
- Test: `tests/integration/crm/push.test.ts`, `tests/integration/routing/assign.test.ts`

**Interfaces:**
- Consumer `crm.assignment_created` (ordered by account) → `queueHandoff(ctx, event)`. It inserts a `handoff` (status `queued`, `ownership_action` from `ownershipDecision`), at most once per assignment (unique index), and enqueues `crm.handoff.push`.
- `runPush(ctx, handoffId, now)` (the job handler), following CRM-E3 Flow and Rulings 3 to 6 and 9:
  1. Lock the account.
  2. Count the attempt.
  3. Load the account and up to 10 people (Accounts), and the package (port).
  4. Get the seller's owner id. With none, the handoff fails non-retryable (CRM-E3-S1-AC4).
  5. Re-run `decideOwnership`. A `stop` gives `needs_decision` and `crm.handoff.needs_decision { reason, currentOwnerName }` (CRM-E3-S1-AC5).
  6. Write the company (with property values), the people (same owner decision, CRM-E3-S2-AC3), the note (fingerprint from its link), the first touch and the follow-ups, linking each write and checking for a cancel before each one.
  7. Read the baseline into `follow_through`.
  8. Mark `completed` with the condition `cancel_requested_at is null`, store `owner_external_id`, `company_external_id` and `taken_from_owner`, and publish `crm.handoff.completed` (with `companyLifecycle`, `observedAt` and `taskCount`).
  9. Call `refreshBatch` (Task 8; until then a no-op hook).
- A `bulk()` run in routing sets one `bulkId` on every `assignment.created` it publishes, and `decline` publishes `reasonLabel`.

- [ ] **Step 1: Write failing tests.**
  - An assignment gives one mock company owned by the seller's owner id, people (primary first, at most 10), one note and four tasks, all linked, and `crm.handoff.completed`, within 10 seconds on the mock (CRM-E3-S1-AC2, a timed assertion).
  - CRM-E3-S1-AC1: the event delivered twice gives one handoff.
  - Review Focus 2: 429 then 500 on `upsertTask` (`setMockFailure`) retries, counts 3 attempts, and still gives one company, note and set of tasks.
  - The sixth failed run marks `failed` with the plain reason and `crm.handoff.failed`.
  - A seller with no owner id fails at once and is not retried.
  - A `stop` found at push time gives `needs_decision`.
  - `keep` pushes without changing the owner.
  - An empty Scout value never blanks a mock company field (CRM-E3-S3-AC3).
  - A bulk assign of two accounts shares one `bulkId`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `routing`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): handoff push on assignment with retries, links and the ownership re-check`.

### Task 8: Handoff batches and messages

**Files:**
- Create: `src/modules/crm/domain/{batch,message}.ts`, `src/modules/crm/services/batches.ts`
- Modify: `src/modules/crm/services/handoff.ts`, `src/modules/crm/index.ts`
- Test: `tests/unit/crm/message.test.ts`, `tests/integration/crm/batches.test.ts`

**Interfaces:**
- `batchName(members, at, timezone)` and `handoffMessage(input)` / `handoffMessages(input)`, ported from `reference/v1/src/server/crm.ts` and `reference/v1/src/lib/handoff.ts`.
  - The follow-up days come from the setting, so the default text is v1's.
  - `replyBy` counts two working days in the tenant timezone.
  - The HubSpot link uses `portal_id` (Ruling 16).
- `batchFor(ctx, bulkKey, createdBy)` and `refreshBatch(ctx, batchId)`. `refreshBatch` rewrites the name and one `handoff_message` per seller (CRM-E4-S2-AC2). Completed handoffs go in the message text; failed, needs-decision and cancelled ones are returned as `notSentYet: [{ accountName, reason }]`.
- `listBatches(ctx, { cursor, limit })`, `getBatch(ctx, id)` → handoffs with seller, status, follow-through counts, messages and `notSentYet`. `markCopied(ctx, messageId)` sets `copied_at`.

- [ ] **Step 1: Write failing tests.**
  - CRM-E4-S2-AC3 snapshot: `handoffMessage` equals v1's output for the same input, the fixed date and days `[3, 7, 14]`, with the v1 text pasted into the test.
  - The name for one account and for 3 to Mike plus 2 to Ash.
  - A bulk assign of 3 accounts to two sellers gives one batch with two messages.
  - A failed handoff is listed under `Not sent yet` with its reason and left out of the text.
  - Copying sets `copied_at`.
  - Batches list newest first.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): handoff batches and one message per seller`.

### Task 9: Undo on decline or withdrawal

**Files:**
- Create: `src/modules/crm/services/undo.ts`
- Modify: `src/modules/crm/{consumers,jobs,index}.ts`, `src/entry/worker.ts`
- Test: `tests/integration/crm/undo.test.ts`

**Interfaces:**
- Consumers on `routing.assignment.declined` and `.withdrawn` → `requestUndo(ctx, { assignmentId, reasonLabel | null, by, kind })`. It follows Ruling 6: set `cancel_requested_at`; a `queued` handoff becomes `cancelled` and publishes `crm.handoff.cancelled`; otherwise it enqueues `crm.handoff.undo`. A withdrawal with `replacedBy` (a reassign) also undoes; the new assignment pushes again.
- `runUndo(ctx, handoffId, now)` follows Ruling 7, records `undone`, publishes `crm.handoff.cancelled` when the push was stopped, and refreshes the batch.

- [ ] **Step 1: Write failing tests.**
  - CRM-E3-S7-AC1: after a completed push, a decline closes the four tasks with `Declined in Scout: Not my territory` and returns the company and people to the recorded previous owner.
  - The company `inactive-owner.example` goes back to the assigner's owner.
  - A `keep` handoff changes no owner.
  - CRM-E3-S7-AC3: a task the rep completed stays completed and is listed in `tasksLeftDone`.
  - CRM-E3-S7-AC2: one short note is added and the context note is unchanged.
  - Review Focus 1, part one: a decline while the push is held after its company write (`setMockFailure` with a timeout on the next write, then the decline) stops the push with `cancelled`, and the undo closes nothing that wasn't written.
  - Review Focus 1, part two: a decline before the job runs gives `cancelled` with no CRM writes.
  - Running the undo twice changes nothing.
  - A reassign from Ash to Mike leaves the company owned by Mike's owner with Mike's four tasks open, and Ash's four tasks closed.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): undo a handoff on decline or withdrawal`.

### Task 10: Re-push, push anyway, new people and the handoff reads

**Files:**
- Create: `src/modules/crm/services/{push,read,settings}.ts`
- Modify: `src/modules/crm/{consumers,jobs,index}.ts`
- Test: `tests/integration/crm/{repush,read,settings}.test.ts`

**Interfaces:**
- `push(ctx, accountId, { keepCurrentOwner?: boolean }): Promise<{ handoffId }>` (Ruling 20; CRM-E3-S6). It creates a new handoff for the same assignment and enqueues the push, with its own batch.
- Re-push behaviour (CRM-E3-S4-AC4, CRM-E3-S3-AC2):
  - tasks update in place
  - a completed one is neither reopened nor recreated
  - a note whose fingerprint still matches is updated, and an edited one gets a new note
- `crm.person.push` job and its consumer (Ruling 22).
- Reads:
  - `getHandoffs(ctx, accountId)` → `{ links, handoffs: [{ id, status, ownershipAction, takenFromOwner, attempts, lastError, undone, queuedAt, completedAt }], followThrough, deals, conflict }`
  - `latestHandoff(ctx, accountId)` and `lastActivityAt(ctx, accountId)`
  
  All of them check account visibility through Accounts `filterVisibleAccountIds`; an account the caller can't see is not found.
- Settings: `getCrmSettings(ctx)` and `setCrmSettings(ctx, patch)` (Global Constraints ranges, `qualified_lead_rule` through INT `setConnectionSettings`, audited). `setUpHubSpotFields(ctx)` → `{ created[] }`, recording `crm.property_setup`.

- [ ] **Step 1: Write failing tests.**
  - Review Focus 3: edit the note and complete the first touch in the mock, then `push` gives a new note (old kept), the first touch not reopened and no duplicate task, and the follow-ups updated.
  - `keepCurrentOwner` records `keep`.
  - A push after a decline gives 409 `Assign it before pushing.`
  - Retrying a `failed` handoff completes.
  - A person added to a handed-off account is pushed and linked, and with the setting off it isn't.
  - `getHandoffs` shape, and not found outside the data limit.
  - Settings ranges are refused with field errors.
  - Fields set-up twice records nothing new.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): re-push, push anyway, new people, handoff reads and settings`.

### Task 11: Follow-through and activity

**Files:**
- Create: `src/modules/crm/domain/follow-through.ts`, `src/modules/crm/services/follow-through.ts`
- Modify: `src/modules/crm/{jobs,index}.ts`, `src/entry/worker.ts`
- Test: `tests/unit/crm/follow-through.test.ts`, `tests/integration/crm/activity.test.ts`

**Interfaces:**
- `followThroughCounts(latest, baseline, now)`, ported from v1 `followUpFrom`: tasks done, total and overdue, then emails, calls, meetings and deals above the baseline (never below 0), open deals, stage, owner and last activity.
- `syncAccount(ctx, accountId, now)`: reads follow-through and activities and, after Task 12, deals. It writes `crm.activity` once per (system, external id) and publishes one `crm.activity.observed` for each new row, with `handoffId`, `actorCrmOwnerId` and `actorUserId`. A Scout task turning completed gives a `task_done` with `taskExternalId`.
- `pollActivity(ctx, now)` (Ruling 17) for the `crm.activity.poll` job, and `checkFollowThrough(ctx, accountId)` (enqueues `crm.sync`).
- `followThrough(ctx, accountId)`: the counts for the account page.

- [ ] **Step 1: Write failing tests.**
  - Unit: counts above the baseline and overdue tasks at `now`.
  - CRM-E5-S1-AC3: two emails existed before the push, then one reply and one meeting are added; the counts show one email (the reply) and one meeting, and two activity events are published.
  - Review Focus 4, part one: the same activity polled twice and synced from a webhook gives one row and one event.
  - CRM-E5-S2-AC3: an email by the seller's owner has `actorUserId` = the seller.
  - Completing the first-touch task in the mock gives one `task_done`.
  - The poll takes at most 200 accounts, oldest checked first, and skips handoffs older than 180 days.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): follow-through counts and activity events`.

### Task 12: Deals and webhook handling

**Files:**
- Create: `src/modules/crm/services/{deals,webhook}.ts`, `src/modules/crm/domain/webhook.ts`
- Modify: `src/modules/crm/services/follow-through.ts`, `src/modules/crm/{jobs,index}.ts`
- Test: `tests/unit/crm/webhook.test.ts`, `tests/integration/crm/{deals,webhook}.test.ts`

**Interfaces:**
- `pollDeals(ctx, now)` for the `crm.deals.poll` job (Ruling 18), and `applyDeals(ctx, deals, now)`. `applyDeals` upserts `crm.deal`, records deal links, and publishes `crm.deal.changed` with `previousStatus`, `companyLifecycle` and `observedAt` only on a change. `syncAccount` also reads the account's deals.
- `companyLifecycle(ctx, accountId)` (Ruling 12).
- `verifyHubSpotV3(secret, req, now): boolean`, which follows HubSpot's v3 signature: HMAC-SHA256, base64, over `method + url + body + timestamp`, and refuses timestamps older than 5 minutes. `parseHubSpotWebhook(rawBody)` → `[{ kind: 'deal' | 'activity' | 'lifecycle', objectId, companyId? , contactId? }]`.
- `handleCrmWebhook(ctx, connectionId, rawBody)` (Ruling 15) → `{ syncs: number, leads: number }`.

- [ ] **Step 1: Write failing tests.**
  - Unit: a signature computed from HubSpot's documented example is accepted, a changed body is refused, and a 6-minute-old timestamp is refused.
  - CRM-E5-S3-AC1 and AC2: a new deal on a linked company gives `open`, closing it won gives `won` with cents and `closedAt`.
  - Review Focus 4, part two: re-reading an unchanged deal publishes nothing.
  - A deal on an unlinked company is ignored.
  - CRM-E5-S3-AC4: no deal write is ever made (the mock call log has no deal writes).
  - A webhook body with a deal and a lifecycle event enqueues one `crm.sync`, publishes one `crm.lead.qualified`, and stores the receipt.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(crm): deal events, company lifecycle and webhook handling`.

### Task 13: Routing on CRM events

**Files:**
- Modify:
  - `src/modules/routing/{consumers.ts,contracts/types.ts,services/respond.ts,services/read.ts,services/queue.ts,services/snapshot.ts,index.ts}`
  - `src/modules/accounts/` (accept the two new `REVIEW_FLAGS` strings)
  - `src/entry/worker.ts`
- Test: `tests/integration/routing/crm-events.test.ts`, `tests/integration/routing/status.test.ts`, `tests/integration/routing/queue.test.ts`

**Interfaces:**
- Consumers, ordered by account, importing `@/modules/crm/contracts/events` only:
  - `routing.crm_activity`: implied acceptance with `acceptedHow` `crm_activity` (REV-E4, REV-E2), and `engaged` on a reply or meeting.
  - `routing.crm_deal`: `opportunity`, `won` and `lost`.
  - `routing.crm_handoff`: the `flags.handoff` state (Ruling 19).
  
  Each write publishes one snapshot.
- `getAccountStatus` adds `handoff` and `last_activity_at` for `crm:push`. `listQueue` rows add `crm` (Ruling 19), read through CRM's `index.ts` (REV → CRM is allowed).
- `assign` sets `flags.handoff.state = 'sending'`.

- [ ] **Step 1: Write failing tests.**
  - A pending assignment plus a seller's email activity gives accepted with `crm_activity`, and the stage moves to `assigned`.
  - A reply gives `engaged`, and a repeat event moves nothing (REV-E4-S1-AC2).
  - Another rep's activity does not accept.
  - A deal open, won or lost moves the stage, and a new open deal after `lost` gives `opportunity`.
  - `needs_decision` sets the flag `handoff_needs_decision` and the reason in flags.
  - `completed` after `failed` with a later `at` gives `in_crm`, and an older event is ignored.
  - Status for a leader shows `handoff.status` and `crm_url`; for an agent without `crm:push` it doesn't.
  - A queue row for `open-deal.example` shows `crm.ownerName` `Vijay Kumar`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `routing` and `accounts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(routing): implied acceptance, CRM stages, handoff state and CRM fields`.

### Task 14: Accounts CRM status, merge guard and links on merge

**Files:**
- Create: `src/modules/crm/services/merge.ts`
- Modify:
  - `src/modules/accounts/{consumers.ts,db/schema.ts,db/migrations/*,services/exclusion.ts,index.ts}`
  - `src/modules/crm/{consumers,index}.ts`, `src/entry/compose.ts` (`registerMergeGuard(crmMergeGuard)`)
- Test: `tests/integration/accounts/crm-status.test.ts`, `tests/integration/crm/merge.test.ts`

**Interfaces:**
- Accounts migration: `account.crm_status_at timestamptz`.
- Consumers `accounts.crm_status` on `crm.company.checked`, `crm.handoff.completed` and `crm.deal.changed` (Ruling 12), importing CRM contracts only (ACC → CRM events are allowed as a published language, like R1b).
- `crmMergeGuard.check(ctx, survivorId, mergedId)` refuses with `Two HubSpot companies are linked` when both accounts have company links to different external ids.
- Consumer `crm.account_merged`: links, handoffs, deals, activities, checks and follow-through move to the survivor. When the guard was bypassed and two companies stay, both links are kept and `getLinks` reports `conflict`.

- [ ] **Step 1: Write failing tests.**
  - An account checked at `customer.example` gets `crm_status` `customer`, is excluded with `Already a customer`, and publishes `exclusion_changed`.
  - An older `observedAt` event after a newer one changes nothing.
  - Cross-module merge test: two accounts linked to different HubSpot companies can't be merged (the copy is shown). Two accounts where only one is linked merge; then the links, handoff and deals point at the survivor, the routing review and the scoring score follow the survivor (R1b consumers), and intake arrivals resolve to the survivor.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `accounts`, `routing` and `intake`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: crm_status from CRM events, the CRM merge guard and links on merge`.

### Task 15: HubSpot qualified leads in

**Files:**
- Create: `src/modules/crm/services/leads.ts`, `src/modules/intake/services/qualified-leads.ts`
- Modify:
  - `src/modules/intake/{contracts/jobs.ts,db/schema.ts,db/migrations/*,services/submit.ts,services/resolve.ts,jobs.ts,defaults.ts,index.ts}`
  - `src/modules/accounts/{contracts/types.ts,contracts/events.ts,services/upsert.ts}`
  - `src/modules/crm/index.ts`, `src/entry/worker.ts`
- Test: `tests/integration/intake/qualified-leads.test.ts`, `tests/integration/accounts/external-ids.test.ts`

**Interfaces:**
- CRM: `fetchQualifiedLead(ctx, connectionId, contactId)` → `{ contact, company | null, contactExternalId, companyExternalId | null, lifecycleStage, qualifiedAt, raw }`, and `listQualifiedLeads(ctx, connectionId, since)` → the same, at most 200 (CRM-E6-S1, Ruling 14).
- Accounts: `ArrivalPerson.externalIds?`. Aliases for people (`person_alias` kind `external_id`). Optional `externalIds` on the four events (Ruling 13).
- Intake (Ruling 14):
  - `SubmitOptions.externalIds` and `arrival.external_ids`, with resolve passing them on
  - table `crm_lead_poll (tenant_id, connection_id, polled_until)`
  - job `intake.qualified_leads.poll {}` (15-minute schedule in `seedIntakeDefaults`), and consumer `intake.lead_qualified` on `crm.lead.qualified`, which fetches the lead and submits it
  - `submitQualifiedLead(ctx, lead)` → `SubmitResult`, built from the lead with `external_ref` `hubspot:<contactId>:<YYYY-MM-DD>`
  - `simulateQualifiedLead(ctx)`, mock only: it sends `pat.lee@qualified.example` through the same path, and outside mock it gives 409 with `SAMPLE_ONLY`

- [ ] **Step 1: Write failing tests.**
  - SRC-E6-S1-AC1: a seeded qualified contact, polled, gives an arrival from `hubspot_qualified` with initial status `needs_review`. It resolves to the company with the contact as a person, and the account and person carry `hubspot` aliases.
  - CRM-E6-S2-AC1: `getLinks` returns the company and contact.
  - CRM-E6-S2-AC2: a later handoff updates the linked mock company, with no create in the call log.
  - Review Focus 5 / SRC-E6-S1-AC3: polling twice plus a `crm.lead.qualified` for the same contact gives one arrival, and a no-company contact arrives through intake's normal rules.
  - `polled_until` advances.
  - Simulate works on the mock and gives 409 outside it.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `accounts`, `intake` and `crm`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): HubSpot qualified leads in, linked to their CRM records`.

### Task 16: CRM on /v1 and the inbound webhook

**Files:**
- Create:
  - `src/app/v1/accounts/[id]/handoffs/route.ts`, `src/app/v1/handoff-batches/{route.ts,[id]/route.ts}`, `src/app/v1/handoff-messages/[id]/route.ts`
  - `src/app/v1/crm/{owners/route.ts,owner-matches/route.ts,fields/route.ts,qualified-leads/route.ts}`, `src/app/v1/settings/crm/route.ts`
  - `src/app/v1/inbound/hubspot/[connectionId]/route.ts`
- Modify:
  - `src/app/v1/accounts/[id]/route.ts` (actions `:push` and `:check-follow-through`)
  - `src/modules/integrations/{services/connections.ts,index.ts}` (`webhookSecret`), new `src/modules/integrations/services/inbound.ts` (`connectionTenant`), `eslint.config.mjs` (`ADMIN_DB_ALLOWED`, Ruling 15)
- Test: `tests/integration/v1/crm.test.ts`, `tests/integration/v1/inbound-hubspot.test.ts`

**Interfaces** (people-only unless noted, `snake_case`, problem+json):
- `POST /v1/accounts/{id}:push` (`crm:push`, idempotent; body `{ keep_current_owner?: boolean }`) → 202 `{ handoff_id }`. Agents with the scope may call it.
- `POST /v1/accounts/{id}:check-follow-through` (`crm:push`) → 202.
- `GET /v1/accounts/{id}/handoffs` (`accounts:read`, agents too).
- `GET /v1/handoff-batches` and `GET /v1/handoff-batches/{id}` (`crm:push`); `POST /v1/handoff-messages/{id}:copied` (`crm:push`).
- `GET /v1/crm/owners`, `POST /v1/crm/owners:sync` (`members:manage`).
- `GET /v1/crm/owner-matches` and `POST /v1/crm/owner-matches:confirm { user_id, external_owner_id }` (`members:manage`).
- `POST /v1/crm/fields:set-up` (`integrations:manage`) → `{ created }`.
- `GET /v1/settings/crm` and `PUT /v1/settings/crm` (`settings:manage`).
- `POST /v1/crm/qualified-leads:simulate` (`integrations:manage`).
- `POST /v1/inbound/hubspot/{connectionId}`: no principal, at most 1 MB, Ruling 15 → 200 `{ received: true }` or 401.

- [ ] **Step 1: Write failing tests.**
  - Each endpoint's scope: 403 without it; 404 for an account outside the data limit.
  - Push is idempotent with the same `Idempotency-Key`.
  - Batches are paginated.
  - Settings validation errors carry paths.
  - SRC-E6-S1-AC2: a bad signature, an old timestamp, or a connection with no secret gives 401, and a good request gives 200 and enqueues the jobs.
  - An unknown connection id gives 401, not 404.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): CRM endpoints and the HubSpot inbound webhook`.

### Task 17: Backfill, seed, R1c exit path and docs

**Files:**
- Modify:
  - `src/entry/seed.ts`, `src/entry/cli.ts` (`scout backfill-r1c <tenant-slug>`)
  - `README.md`, `docs/CHANGELOG.md`
  - `docs/spec/migration-and-rollout/release-plan.md` (R1c status)
  - `docs/spec/architecture/event-catalog.md` (new events, jobs and fields: `crm.company.checked`, `crm.handoff.cancelled`, `crm.lead.qualified`, `companyLifecycle`, `observedAt`, `bulkId`, `reasonLabel`, `externalIds`, `actorOwnerExternalId`)
  - `docs/spec/architecture/module-boundaries.md` (CRM implements `OwnershipPreflight`, kept as a port)
  - `docs/spec/architecture/data-conventions.md` (id prefixes)
  - `docs/spec/crm-sync/{index,crm-adapter-contract,handoff-push}.md` (Rulings 2, 6, 7, 9, 11 and 17, the `cancelled` status, and the mock tables)
  - `docs/spec/review-and-routing/index.md` (handoff flags)
  - `docs/spec/accounts/index.md` (`crm_status_at`)
  - `docs/spec/sources-and-intake/index.md` (`external_ids`, the poll table)
- Test: `tests/integration/crm/one-path.test.ts`, `tests/integration/entry/cli.test.ts`

**Interfaces:**
- `backfillR1c(ctx)` runs, in order:
  - `seedCrmDefaults`
  - `crm.company.check` enqueued for every account with a domain and no check
  - links recorded from existing `external_id` aliases
  - the qualified-lead poll schedule
  
  It is idempotent. Seed calls it for each tenant, and calls `seedMockCrm` when the HubSpot connection is in mock mode.
- R1c exit, on the mock, through services and `runOutbox`:
  1. An agent sends an account. It is scored, queued and assigned by a leader, and lands in the mock CRM with the note and four tasks, owned by the seller.
  2. One message per seller appears in the batch.
  3. A reply by the seller in the mock makes the next activity poll accept the assignment (`crm_activity`) and move the stage to `engaged`.
  4. A new deal makes the next deal poll move the stage to `opportunity`, and closing it won moves it to `won`.
  5. A second account assigned and then declined has its tasks closed and its owner returned.
  6. A qualified contact polled from the mock reaches the queue as `needs_review`, linked.

- [ ] **Step 1: Write failing tests.**
  - The exit path end to end.
  - The backfill gives R1b-style accounts checks and links, and running it twice changes nothing.
  - Seed twice leaves one setting row, one set of field mappings and one set of mock fixtures.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run typecheck && npm run lint && npm test && npm run e2e && npm run build`. Expected: PASS. Then the laptop smoke run:
  - Seed, then start the background roles and web.
  - Assign the Miami-Dade account with the dev session.
  - Read `GET /v1/accounts/{id}/handoffs` until `completed`.
  - Call `POST /v1/crm/qualified-leads:simulate`.
  - Stop exactly the processes started.
- [ ] **Step 5:** Commit `feat: R1c backfill, seed, exit path test and docs`.
