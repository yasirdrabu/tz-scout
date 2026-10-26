# Events and async work (decisions D10, D11)

## The path of every event

1. A service changes data **and** inserts an event row into `platform.outbox` in the **same
   Postgres transaction**. If the transaction rolls back, the event never existed.
2. The **relay** (one active instance, Postgres advisory lock) reads unsent outbox rows in order,
   publishes each to NATS JetStream with `Nats-Msg-Id = event.id` (JetStream de-duplicates repeats),
   and marks the row sent. Target delay: under 1 second at p95.
3. **Consumers** in the worker role subscribe with durable JetStream consumers. Each consumer records
   `(consumer_name, event_id)` in `platform.processed_event` inside its own transaction, so a
   redelivered event is skipped (exactly-once effect on top of at-least-once delivery).
4. A consumer's own changes publish new events through the outbox in the same way.

Nothing publishes to NATS directly from a request handler.

## Subjects and streams

Subject: `scout.<tenantId>.<module>.<entity>.<verb>` — for example
`scout.t_01J9….intake.arrival.received`. Verbs are past tense for events (`received`, `scored`,
`assigned`) and imperative for jobs (`jobs.enrich.run`).

| Stream | Subjects | Retention | Use |
|---|---|---|---|
| `SCOUT_EVENTS` | one entry per module: `scout.*.tenancy.>`, `scout.*.intake.>`, `scout.*.accounts.>`, `scout.*.enrichment.>`, `scout.*.scoring.>`, `scout.*.offers.>`, `scout.*.playbooks.>`, `scout.*.routing.>`, `scout.*.crm.>`, `scout.*.campaigns.>`, `scout.*.analytics.>`, `scout.*.integrations.>`, `scout.*.ai.>`, `scout.*.platform.>` | limits: 90 days, file storage | fan-out to every interested consumer, replay |
| `SCOUT_JOBS` | `scout.*.jobs.>` | work queue (each message to one consumer) | background work: enrichment calls, CRM pushes, imports, rescoring |
| `SCOUT_WEBHOOKS` | `scout.*.webhooks.deliver` | work queue | outgoing webhook deliveries with retry |
| `SCOUT_REPLAY` | `scout.*.replay.>` | limits: 7 days | history re-published for a rebuilding read model only |

Streams must not overlap (JetStream rejects overlapping subjects), so `SCOUT_EVENTS` lists module
prefixes rather than a catch-all; `jobs`, `webhooks` and `replay` are reserved second tokens and can
never be module names. Job subjects are `scout.<tenant>.jobs.<job-name>` (for example
`scout.t_01J9….jobs.rescore.accounts`).

Ordering: events about one account must be processed in order by consumers that care. Those consumers
use a key (`accountId`) and process one message per key at a time (consumer-side keyed lock in
Postgres or NATS per-subject ordering with `scout.<tenant>.<module>.<entity>.<verb>.<accountId>`
where needed). Each module spec says which of its consumers need ordering.

## Event envelope

Every event, whatever its type, has this shape (Zod schema in `src/platform/events.ts`):

```json
{
  "id": "evt_01JB…",              // ULID, unique; also the NATS message id
  "type": "intake.arrival.received",
  "schemaVersion": 1,
  "tenantId": "t_01J9…",
  "occurredAt": "2026-10-25T14:03:11.120Z",
  "actor": { "kind": "user|agent|system", "id": "usr_…|key_…|system", "sourceId": "src_…" },
  "correlationId": "cor_…",       // same across everything one request or batch caused
  "causationId": "evt_…",         // the event that caused this one, if any
  "subject": { "type": "account", "id": "acc_…" },
  "data": { }                      // type-specific, Zod-validated, documented in the module spec
}
```

Rules: events carry ids and the minimum facts consumers need, not whole records. Adding an optional
field is a compatible change; anything else bumps `schemaVersion` and consumers accept both versions
for one release.

## Jobs

Background work is a job message on `SCOUT_JOBS`, published through the outbox like an event.

- **Retries:** exponential backoff (5s, 30s, 2m, 10m, 1h), max 6 deliveries by default; per job type
  configurable.
- **Dead letters:** after the last attempt the job goes to `platform.dead_job` with its last error,
  visible in Admin → System, and can be retried or discarded by a person.
- **Idempotency:** every job handler is safe to run twice (it checks `processed_event` or its own
  state before acting).
- **Timeouts:** each job type declares one; outside calls go through the integrations module, which
  enforces rate limits and usage caps.

## Scheduling

The scheduler role holds a table `platform.schedule` (cron expression, job type, tenant, payload,
enabled). On each tick it publishes due jobs through the outbox. Defaults:

| Job | When |
|---|---|
| Scheduled source pulls (Apollo saved searches) | as configured per pull; default daily 10:00 UTC |
| CRM follow-through check | hourly |
| Weekly scorecard and diagnosis | Mondays 11:00 UTC |
| Trust score recompute | nightly 03:00 UTC |
| Usage cap reset | first of each month 00:00 UTC per tenant timezone |

## Rescoring (replay, D11)

"Replay" means recomputing derived data from stored facts, not rebuilding tables from events.

- Changing scoring rules, weights or an offer publishes `scoring.rules.changed`; a consumer enqueues
  `jobs.rescore.accounts` for every affected account (batched, 500 ids per message).
- An admin can trigger a full rescore for a tenant from Settings.
- `SCOUT_EVENTS` keeps 90 days of history; a new read model (for example a new analytics view) may
  be built by replaying the stream from a start time into a fresh consumer.

## Rebuilding history older than 90 days

`SCOUT_EVENTS` keeps 90 days. To build a read model from older history, a module that owns stored
history (SRC, REV, CRM, PLB, INT) handles the job `jobs.history.republish { tenantId, from, to,
types[] }`: it re-publishes events reconstructed from its own tables with `replay: true` on
`scout.<tenant>.replay.>`. Only the rebuilding consumer subscribes to replay subjects, so normal
consumers never act twice.

## Linking costs and work

Every event and every outside call made while handling one request, batch or job carries the same
`correlationId`. Analytics attaches cost lines (from `integrations.usage.recorded`) to the account,
source and batch named by the work that shares that `correlationId` (for example
`enrichment.request.completed`, `ai.run.completed`).

## Moving to Dayko later

Dayko runs NATS. Scout's subjects are already tenant- and module-namespaced, so Scout can publish
into Dayko's NATS cluster (via account import/export or a leaf node) without changing event shapes.
