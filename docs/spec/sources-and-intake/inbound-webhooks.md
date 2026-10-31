# SRC-E6 Inbound webhooks: qualified leads and web forms

Status: Draft · Release: R1 (HubSpot qualified leads), R2 (web forms)

## Why

Marketing decides when a HubSpot lead is qualified; Scout only scores it (answer B5). When a contact
becomes a marketing qualified lead in HubSpot, Scout should take in the contact and its company like
any other arrival. Web forms on a tenant's site come in the same way. Both replace today's single
shared-secret form webhook.

## Rules

### HubSpot qualified leads

- The tenant's HubSpot connection (INT, used by CRM) has an intake setting: which change counts as
  qualified. Default: `lifecyclestage` changed to `marketingqualifiedlead`. It may instead be any
  contact property and value.
- **In R1 the 15-minute poll (below) is the primary path** (spec's call, D28). Scout does not register
  HubSpot webhook subscriptions; an admin may set them up by hand in HubSpot, or a later public app
  does it.
- `POST /api/v1/inbound/hubspot/{connectionId}` receives hand-configured HubSpot webhook subscriptions.
  Requests are checked with HubSpot's v3 signature against the connection's optional
  `webhook_client_secret` credential, and the timestamp (reject if older than 5 minutes). With no
  secret set, every request is refused with `401`.
- For each event Scout calls CRM `fetchQualifiedLead(connectionId, contactId)`, which returns the
  contact, its associated company and the HubSpot ids. Intake builds an `arrival.v1` with source
  `hubspot_qualified` (kind `crm`) and submits it like any other arrival; the HubSpot contact and
  company ids are recorded as `(hubspot, id)` external ids on the person and account.
- **Fallback poll**: every 15 minutes a job asks HubSpot for contacts that entered the qualified state
  since the last poll, in case webhooks were missed. The same contact never produces two arrivals for
  the same qualification date (idempotent on contact id plus date).
- A contact whose company is already an open deal or customer still arrives; ACC marks the exclusion
  and REV shows it, people decide.

### Web forms

- Each web form is a source of kind `web_form` with its own token (`scout_form_…`) and an optional
  allowed-origins list. `POST /api/v1/inbound/forms/{sourceId}` with header `Scout-Form-Token`.
- Body: today's form shape is accepted unchanged (`email`, `firstName`, `lastName`, `title`,
  `company`, `phone`, `smsConsent`, `timeline`, `offering`, `answers`), mapped to `arrival.v1`
  (`offering` → `offer_hint`, `timeline` and `answers` → facts of kind `form_answer`). Native
  `arrival.v1` bodies are also accepted.
- Rate limit per form: 60 a minute per IP and the source's daily limit. Responses: `202` with
  `arrival_id`; `401` on a bad token; `400` with problem details.

## Stories

### SRC-E6-S1 Take in HubSpot qualified leads
As a CRO, I want contacts marketing qualifies in HubSpot to show up in Scout scored and ready for
review, so that marketing's work reaches sales through the same path as everything else.
- SRC-E6-S1-AC1 Given a HubSpot contact's lifecycle stage changes to marketing qualified lead, then
  within 15 minutes (next poll) an arrival from `hubspot_qualified` is resolved to the contact's
  company with the contact as a person; if a hand-configured webhook arrives, within 10 seconds.
- SRC-E6-S1-AC2 A webhook with a bad signature, a timestamp older than 5 minutes, or on a connection
  with no `webhook_client_secret` is refused with `401` and logged.
- SRC-E6-S1-AC3 The 15-minute poll picks up the same contacts as any webhook; no duplicate arrivals
  when both run.
- SRC-E6-S1-AC4 With the HubSpot connection mode = mock, Settings has "Simulate a qualified lead" which
  sends a seeded contact through the same path.

### SRC-E6-S2 Web forms
As an operator, I want each of our web forms to send submissions to Scout with its own token, so that
form leads are tracked per form and a leaked token affects one form only.
- SRC-E6-S2-AC1 Creating a web form source shows its endpoint URL, token and a sample request; the
  token can be rotated.
- SRC-E6-S2-AC2 A body in today's form shape is accepted and mapped as in Rules (contract test with
  today's example payload).
- SRC-E6-S2-AC3 A submission from an origin not on the allowed list is refused when the list is set.
