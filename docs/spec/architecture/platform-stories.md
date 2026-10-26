# PLT: Platform

Module code PLT · Schema `platform` · Release R0

Owns: `outbox`, `processed_event`, `dead_job`, `schedule`, `audit_log`, `idempotency_key`.

## PLT-E1 Outbox, relay and consumers

### PLT-E1-S1 Transactional outbox
As a module developer, I want to publish an event in the same transaction as my data change, so that
no event is lost or sent for data that failed to save.
- PLT-E1-S1-AC1 Given a service writes data and calls `outbox.publish(event)` in one transaction, when
  the transaction rolls back, then no outbox row exists.
- PLT-E1-S1-AC2 Every published event is validated against the envelope schema and its type's data
  schema; an invalid event fails the transaction.

### PLT-E1-S2 Relay
As the platform, I want outbox rows moved to NATS in order, so that consumers see events quickly.
- PLT-E1-S2-AC1 Only one relay instance is active at a time (advisory lock); a second one waits.
- PLT-E1-S2-AC2 p95 time from commit to NATS publish is under 1 second at 50 events a second.
- PLT-E1-S2-AC3 If NATS is down, rows stay unsent and are published in order when it returns; nothing
  is dropped. Publishing the same row twice does not create two messages (`Nats-Msg-Id`).

### PLT-E1-S3 Idempotent consumers
- PLT-E1-S3-AC1 A consumer that receives the same event twice changes data once
  (`processed_event` checked in the consumer's transaction).
- PLT-E1-S3-AC2 Consumers that declare `orderedBy: accountId` never process two events for the same
  account at once.

### PLT-E1-S4 Retries and dead jobs
- PLT-E1-S4-AC1 A failing job is retried with the backoff in events-and-async.md, then stored in
  `dead_job` with its last error.
- PLT-E1-S4-AC2 An admin can retry or discard a dead job from Admin → System; both are audited.

## PLT-E2 Scheduler

### PLT-E2-S1 Scheduled jobs
- PLT-E2-S1-AC1 Schedules are rows (cron, job type, tenant, payload, enabled); the scheduler publishes
  due jobs through the outbox exactly once per due time, even if restarted mid-tick.
- PLT-E2-S1-AC2 Admins can see, pause and run-now each schedule.

## PLT-E3 Audit log

### PLT-E3-S1 Who did what
As an owner, I want every change recorded with who made it and through what, so that any decision can
be explained.
- PLT-E3-S1-AC1 Every write through a service records tenant, actor (user, API key or OAuth client),
  source, action, subject, correlation id, IP and a before/after summary.
- PLT-E3-S1-AC2 Owners can filter the audit log by person, key, source, account and date.

## PLT-E4 System health

### PLT-E4-S1 Health page
- PLT-E4-S1-AC1 Admin → System shows relay lag, pending messages per consumer, dead jobs, and the last
  error per integration, refreshed every 30 seconds.
- PLT-E4-S1-AC2 `/healthz` and `/readyz` behave as in deployment-and-iac.md.

## Events
None of its own except `platform.job.dead` (data: job type, error, attempts), used for alerting.
