# CRM-E1 Adapter contract

Release R1 · Module CRM

## Why

One contract lets Scout hand off to HubSpot now and to Salesforce, Dynamics or Dayko Kindle later
without touching the handoff logic. It also lets the whole flow run on a mock CRM with seed data.

## The contract

Every CRM connector implements these operations. Inputs and outputs are Zod schemas in
`src/modules/crm/contracts/adapter.ts`. Every operation is idempotent when given the same external ids.

| Operation | Input | Output |
|---|---|---|
| `findCompany` | domain | `{ externalId, name, ownerExternalId, lifecycle, openDeals, deals } \| null` |
| `upsertCompany` | external id (optional), domain, name, website, location, employees, description, owner, `replaceableOwner`, mapped properties | `{ externalId, created, ownerExternalId }` |
| `findPerson` | email, or name plus company external id | `{ externalId, ownerExternalId } \| null` |
| `upsertPerson` | external id (optional), name, title, email, phones, LinkedIn, owner, `takeOverOwner`, company external id | `{ externalId, created }` |
| `upsertNote` | external id (optional), expected fingerprint, company and person ids, html, owner | `{ externalId, fingerprint, kept }` (`kept` = the existing note was edited in the CRM, so a new note was added instead) |
| `upsertTask` | external id (optional), company, person, subject, body, owner, due date | `{ externalId, status }` |
| `closeTask` | external id | `{ status }` |
| `listOwners` | none | `[{ externalId, name, email, active }]` |
| `readFollowThrough` | company external id, our task ids | `{ tasks[], emails, calls, meetings, deals, openDeals, stage, ownerExternalId, lastActivityAt }` |
| `listActivities` | company external id, since | `[{ externalId, kind, occurredAt }]` |
| `listDeals` | company external id, or `changedSince` | `[{ externalId, companyExternalId, name, stage, status, amountCents, currency, openedAt, closedAt }]` |
| `listQualifiedLeads` | `changedSince` | `[{ contact, company, lifecycleStage, qualifiedAt, raw }]` |
| `existingProperties` | none | set of property names |
| `setUpProperties` | group name, property definitions | `{ created[] }` |
| `verifyWebhook` | headers, raw body | `boolean` |
| `parseWebhook` | raw body | `[{ kind: deal \| activity \| lifecycle, externalIds }]` |

Rules:

- Money in and out in integer cents; the connector converts to the CRM's format.
- A connector never decides ownership. The handoff service decides (CRM-E3) and passes the result.
- A connector that cannot do an operation (for example, no webhooks) says so in its `capabilities`
  object, and the module falls back to polling.
- Each connector has a `mock` implementation that keeps its state in Postgres, in mock tables in the
  `crm` schema (`crm.mock_company`, `mock_person`, `mock_note`, `mock_task`, `mock_deal`,
  `mock_owner`, `mock_property`, `mock_activity` and `mock_failure`, all with `tenant_id`), so the web process (ownership preflight) and the worker (push)
  see the same records. `mock_activity` holds the emails, replies, calls and meetings that tests and the seed add, `mock_property` holds the custom properties "Set up HubSpot fields" creates, and `mock_failure` (`operation`, `kind` 429, 500 or timeout, `remaining`) is how a test makes an operation fail. It writes every call to the integration call log and can be told to fail a
  given operation for tests (spec's call, D30). The mock factory takes the module context, `(ctx) => Adapter`.
- The mock commits each record in its own transaction, like a real CRM that does not roll back when Scout does. Its external ids are `mock-co-<n>`, `mock-ct-<n>`, `mock-nt-<n>`, `mock-tk-<n>`, `mock-dl-<n>` and `mock-ow-<n>`, numbered per tenant.
- `listDeals({ changedSince })` returns at most `DEALS_PAGE_LIMIT` (1,000) deals, oldest change first, each with `modifiedAt`; a deal with no company is returned with `companyExternalId` null, so a full page can be told apart.
- `listActivities` returns `actorOwnerExternalId` for each activity, `listQualifiedLeads` takes `{ changedSince, rule }` and returns each lead with `cursorAt` (the time the CRM paged on: `hs_lifecyclestage_<value>_date` for the default lifecycle rule, `lastmodifieddate` for other rules; the lifecycle rule filters on that date alone, so a contact past the stage still counts, and `readQualifiedLead` accepts a contact with the date set), and `readQualifiedLead` takes `{ contactId, rule }`. The rule (`{ property, value }`, default `lifecyclestage` = `marketingqualifiedlead`) lives in the connection's settings; CRM reads it and passes it, so adapters never read settings for it.
- `test()` returns Integrations' `TestResult`, which may carry `facts` (for HubSpot, `portal_id` and `portal_name`); a passing test merges them into the connection's settings.

## Stories

### CRM-E1-S1 One contract for every CRM
As a developer, I want the handoff to call one CRM contract, so that adding a CRM never changes the
handoff logic.
- CRM-E1-S1-AC1 The handoff service imports only the contract types, never a connector.
- CRM-E1-S1-AC2 A contract test suite runs against every connector (mock in CI, live behind a flag)
  and checks each operation's output schema and idempotency (same input twice gives the same external
  ids and no duplicates).

### CRM-E1-S2 Capabilities
As a developer, I want each connector to declare what it can do, so that Scout picks webhooks or
polling and hides settings that don't apply.
- CRM-E1-S2-AC1 `capabilities` lists: webhooks (deals, activities, lifecycle), custom properties,
  task due dates, note fingerprinting, owner roster.
- CRM-E1-S2-AC2 When `webhooks.deals` is false, the scheduler polls deals hourly for that tenant.

### CRM-E1-S3 Mock CRM
As a developer, I want a mock CRM with seed companies, owners and deals, so that the whole flow runs
on a laptop with no CRM account.
- CRM-E1-S3-AC1 With the CRM connection mode = mock, a handoff creates mock records (in the `crm`
  schema mock tables) and shows them in the integration call log; a preflight in the web process sees
  records the worker created.
- CRM-E1-S3-AC2 The mock can simulate: an existing company owned by someone else, an open deal, an
  existing customer, a note edited by a rep, a 429 rate limit and a 500 error.
- CRM-E1-S3-AC3 `seedMockCrm` (used by seed and tests) adds an owner for each member's `crm_owner_ids.hubspot`, `Rahul Mehta` (inactive) and `Vijay Kumar` (active), the companies `owned-elsewhere.example` (owner Vijay), `open-deal.example` (owner Vijay, one open deal), `customer.example` (owner Vijay, lifecycle customer) and `inactive-owner.example` (owner Rahul), and one qualified contact, `pat.lee@qualified.example` at `qualified.example`. Running it twice adds nothing.
