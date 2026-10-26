# API-E3 Outgoing webhooks

Release R3 (lower priority per answer 15; polling covers R1)

## Rules

- Tables in schema `platform`: `webhook_endpoint` (`id`, `tenant_id`, `url` (https only),
  `event_types[]`, `secret_hash`, `secret_hint`, `owner_principal_id` (the key or user that made it),
  `data_limit` (copied from the owner, can only narrow), `status` (active, disabled), `failing_since`)
  and `webhook_delivery` (`id`, `endpoint_id`, `event_id`, `attempt`, `status_code`, `duration_ms`,
  `next_attempt_at`, `delivered_at`, `error`).
- Public event types (others stay internal):
  `intake.arrival.resolved`, `intake.arrival.rejected`, `intake.batch.completed`,
  `scoring.account.scored`, `routing.status.changed`, `routing.assignment.created`,
  `routing.assignment.accepted`, `routing.assignment.declined`, `crm.handoff.completed`,
  `crm.deal.changed`, `playbooks.outcome.recorded`.
- A delivery goes out only if the event's subject is inside the endpoint's data limit. Payload is the
  event envelope with `data` trimmed to fields the owner's scopes allow (no contact details without
  `people:read`).
- Signing: header `Scout-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
  Receivers should reject timestamps older than 5 minutes. The secret is shown once at creation.
- Delivery: POST with 10 second timeout; any 2xx is success. Retries via the `SCOUT_WEBHOOKS` stream:
  1m, 5m, 30m, 2h, 6h, 12h (about 24 hours). Order is not guaranteed; receivers use `occurredAt` and
  the event id.
- An endpoint failing for 3 days in a row is disabled and its owner notified.

## Stories

### API-E3-S1 Register an endpoint
As an agent builder, I want to subscribe to events about my submissions, so that my agent reacts
without polling.
- API-E3-S1-AC1 `POST /webhook-endpoints` with url and event types returns the endpoint and its secret
  once.
- API-E3-S1-AC2 `POST /webhook-endpoints/{id}:test` sends a signed `scout.test` event and returns the
  receiver's status code.

### API-E3-S2 Verify deliveries
- API-E3-S2-AC1 The developer page shows signature verification code for Node, Python and C#.

### API-E3-S3 See deliveries
As an owner, I want each endpoint's delivery history, so that I can fix a broken receiver.
- API-E3-S3-AC1 Shows the last 30 days of attempts with status code and error; a failed delivery can
  be resent by hand.
