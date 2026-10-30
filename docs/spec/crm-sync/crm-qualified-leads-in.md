# CRM-E6 CRM-qualified leads in (CRM side)

Release R1 · Module CRM · Pairs with SRC-E6 in `sources-and-intake/inbound-webhooks.md`

## Why

Marketing marks leads as qualified in the CRM; Scout only scores them (decision D6). Sources and intake
owns the inbound webhook, the poll schedule and the arrival. This module supplies what only it can:
reading the contact and company from the CRM through the adapter contract.

## Rules

- `fetchQualifiedLead(ctx, connectionId, contactId)` returns the contact, its associated company, the
  CRM ids, the lifecycle stage, the date it qualified and the raw CRM records as received.
- `listQualifiedLeads(ctx, connectionId, since)` returns the same for every contact that entered the
  qualified state since a time, for SRC's 15-minute fallback poll.
- Which change counts as qualified is the intake setting stored on the CRM connection (INT connection
  settings: `qualified_lead_rule` = property and value, e.g. `lifecyclestage = marketingqualifiedlead`,
  and whether webhooks are expected or only the poll runs). It is edited on the CRM connection's
  settings screen, read by SRC-E6, and applied by this module when querying. For the lifecycle rule the
  HubSpot connector reads the stage date (`hs_lifecyclestage_<value>_date`) only, so a contact already
  past the stage (a sales qualified lead or a customer) still counts as qualified when it has that date.
- **Polling is the primary path; Scout does not register HubSpot webhook subscriptions** (spec's call,
  D28). A private app token cannot create webhook subscriptions through the API, and private-app
  webhook signatures are checked with the app's client secret, which the token does not carry. So:
  qualified leads are polled every 15 minutes (`listQualifiedLeads`); CRM activity is polled every 15
  minutes and deals hourly (whenever those reads ship). Webhooks are optional: a tenant admin may set up
  subscriptions by hand in HubSpot's own screens, pointing at
  `POST /v1/inbound/hubspot/{connectionId}`, or they arrive automatically with a HubSpot public app in a
  later release.
- The HubSpot connection has an optional credential `webhook_client_secret` (encrypted like other
  credentials, INT). When it is set, SRC's inbound route verifies the v3 signature with it; when it is
  not set, the inbound route refuses every request with `401` and only polling runs.
- SRC's `POST /v1/inbound/hubspot/{connectionId}` verifies the HubSpot signature once, then hands deal
  and engagement events to this module's `handleCrmWebhook(ctx, connectionId, events)`. Webhook and
  poll results go through the same idempotent handling, so receiving both never double-counts.
- Calls go through `gateway.call`, so they count against the connection's caps and appear in its call
  log.
- The CRM company and contact ids returned are recorded by SRC on the account and person; this module
  then creates `crm.link` rows on `accounts.account.created` / `accounts.person.added` when those
  carry CRM external ids, so a later handoff updates the existing company instead of creating one.

## Stories

### CRM-E6-S1 Fetch a qualified lead
As Sources and intake, I want the contact and company for a qualified CRM contact, so that I can build
an arrival with the CRM's own ids.
- CRM-E6-S1-AC1 Given a contact id, `fetchQualifiedLead` returns contact, company (or null when the
  contact has none) and ids, validated by the contract schema.
- CRM-E6-S1-AC2 With the mock CRM, a seeded qualified contact is returned, so SRC's "Simulate a
  qualified lead" works on a laptop.

### CRM-E6-S2 Linked from the start
As a leader, I want a CRM-qualified account linked to its existing CRM company, so that a handoff never
creates a duplicate company.
- CRM-E6-S2-AC1 After such an arrival resolves, `getLinks(accountId)` returns the CRM company and
  contact.
- CRM-E6-S2-AC2 A later handoff of that account updates the linked company (no `upsertCompany` create).
