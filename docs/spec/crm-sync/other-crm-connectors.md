# CRM-E8 Salesforce, Dynamics, Dayko Kindle

Release R4 · Module CRM

## Why

Clients like Tobi will not all use HubSpot (decision D19). Each new CRM is a connector behind the
CRM-E1 contract; nothing else changes.

## Mapping of concepts

| Scout | HubSpot | Salesforce | Dynamics 365 Sales | Dayko Kindle |
|---|---|---|---|---|
| Account | Company | Account | Account | To confirm with the Dayko team |
| Person | Contact | Contact | Contact | To confirm |
| Note | Note engagement | ContentNote (or Task with notes) | Annotation (note) | To confirm |
| Task | Task | Task | Task activity | To confirm |
| Owner | Owner | User | SystemUser | To confirm |
| Deal | Deal | Opportunity | Opportunity | To confirm |
| Qualified lead | Lifecycle stage | Lead status (configurable) | Lead status | To confirm |
| Change events | Webhooks | Change Data Capture or polling | Webhooks via service endpoints or polling | NATS events (preferred) |

## Stories

### CRM-E8-S1 Salesforce connector
As an owner on Salesforce, I want Scout to hand off to Salesforce the same way, so that our reps work
in their CRM.
- CRM-E8-S1-AC1 The CRM-E1 contract test suite passes against a Salesforce sandbox.
- CRM-E8-S1-AC2 Auth is OAuth (connected app); token refresh is handled by Integrations.

### CRM-E8-S2 Dynamics connector
- CRM-E8-S2-AC1 The contract test suite passes against a Dynamics trial environment.

### CRM-E8-S3 Dayko Kindle connector
As Taazaa, I want Scout to hand off to Dayko Kindle, so that Scout can live inside Dayko later.
- CRM-E8-S3-AC1 The contract test suite passes against a Dayko Kindle test tenant.
- CRM-E8-S3-AC2 Where Dayko Kindle publishes NATS events for deals and activities, the connector
  subscribes to them instead of polling.

## Open questions

- Dayko Kindle's object model and API are not documented here yet; the Dayko team to provide them
  before R4 planning.
