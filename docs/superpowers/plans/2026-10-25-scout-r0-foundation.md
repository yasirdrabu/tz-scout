# Taazaa Scout R0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Scout foundation: repo layout, platform plumbing (outbox, relay, NATS, consumers, jobs, scheduler, audit, health), tenancy with Microsoft and developer sign-in, minimal API keys, integrations core on mocks, the AI task runner, a container image run in four roles, compose for laptop and VM, backups, infrastructure code and CI.

**Architecture:** One TypeScript package. Next.js serves UI and `/v1`; plain Node entry points run worker, scheduler and relay from the same code. Postgres holds one schema per module with row-level security; every event is written to `platform.outbox` in the caller's transaction and relayed to NATS JetStream, where durable consumers process it idempotently.

**Tech Stack:** Node 22+, TypeScript strict, Next.js 15 (App Router), React 19, Tailwind 3, Drizzle ORM + drizzle-kit, PostgreSQL 17, NATS 2.11+ with JetStream (`@nats-io/transport-node`, `@nats-io/jetstream` v3), better-auth (Microsoft provider), Zod 4, pino, ulid, `@node-rs/argon2`, cron-parser, tsup, Vitest, Playwright, eslint-plugin-boundaries, Docker, OpenTofu, GitHub Actions.

**Spec:** `docs/spec/README.md`, `docs/spec/architecture/*`, `docs/spec/migration-and-rollout/release-plan.md` (R0), `docs/spec/architecture/platform-stories.md`, `docs/spec/tenancy-and-access/` (TEN-E1, E2, E3, minimal E4), `docs/spec/integrations/` (INT-E1 skeleton, E2, E3 basic, E5), `docs/spec/ai-tasks/` (AI-E1, E2).

## Global Constraints

- Every table in a module schema has `tenant_id text not null` and an RLS policy `tenant_id = current_setting('app.tenant_id', true)`; platform-wide tables (`tenancy.tenant`, `tenancy.user`, better-auth tables, `platform.outbox`, `platform.processed_event`, `platform.dead_job`, `platform.schedule`) are exempt and documented as such in their schema file.
- A module imports another module only through `src/modules/<m>/index.ts` or `src/modules/<m>/contracts/*` (enforced by eslint-plugin-boundaries).
- Ids are ULIDs with a type prefix: `t_`, `usr_`, `mbr_`, `key_`, `con_`, `run_`, `evt_`, `cor_`, `job_` (spec list in `architecture/data-conventions.md`).
- Event types are `<schema>.<entity>.<verb>`; NATS subjects are `scout.<tenantId>.<schema>.<entity>.<verb>`; job subjects are `scout.<tenantId>.jobs.<job-name>`. Platform-level events use tenant `t_platform`.
- Event envelope exactly as `architecture/events-and-async.md` (id, type, schemaVersion, tenantId, occurredAt, actor, correlationId, causationId, subject, data).
- Streams: `SCOUT_EVENTS` (one `scout.*.<schema>.>` entry per module schema listed in events-and-async.md, 90 days, file), `SCOUT_JOBS` (`scout.*.jobs.>`, work queue), `SCOUT_WEBHOOKS` (`scout.*.webhooks.deliver`, work queue), `SCOUT_REPLAY` (`scout.*.replay.>`, 7 days).
- Job retries: backoff 5s, 30s, 2m, 10m, 1h; max 6 deliveries by default.
- API JSON is `snake_case`; errors are RFC 9457 `application/problem+json` with `type` `https://scout.taazaa.ai/problems/<slug>`.
- API keys: `scout_live_…` / `scout_test_…`, argon2id hash, prefix = first 12 characters, revocation effective within 60 seconds.
- Credentials: AES-256-GCM per credential with a random data key wrapped by `SCOUT_MASTER_KEY` (32 bytes, base64); never logged or returned; hint = last 4 characters.
- App refuses to start when `NODE_ENV=production` and (`AUTH_DEV_SIGNIN=true` or `SCOUT_MASTER_KEY` missing).
- Sessions: 12 hours of inactivity, 7 days at most.
- Copy: exact strings from the spec where quoted; plain words; no em dashes; design tokens from `architecture/design-and-copy.md`.
- Ports: web 4240, Postgres 5432 (compose), NATS 4222, NATS monitor 8222.

## Review Focus

1. **NATS is down when a request writes data.** The request still succeeds (only Postgres is touched) and the relay delivers everything in order once NATS is back. Test in Task 5.
2. **A query runs without `withTenant`.** RLS must return no rows and refuse writes, never return every tenant's rows. Test in Task 3.
3. **Worker dies after committing but before acking.** Redelivery must change nothing. Test in Task 6.
4. **Two schedulers run at once (VM `all-background` plus a stray `scheduler`).** Each due time is published once. Test in Task 7.
5. **Microsoft returns the email in different case or only a UPN.** The member is still matched; a non-member still gets the refusal message. Test in Task 11.

---

## File Structure

```
reference/v1/                      v1 code moved here, excluded from build, lint and tests
src/
  app/                             Next.js App Router (UI, /v1 route handlers, /api/auth, health)
  components/                      ui.tsx, client.tsx (tokens per design-and-copy.md)
  entry/                           cli.ts (role dispatcher), worker.ts, scheduler.ts, relay.ts
  platform/
    config.ts ids.ts errors.ts log.ts
    db/client.ts db/tenant.ts db/migrate.ts db/bootstrap.sql
    db/schema.ts                   platform schema tables
    events/envelope.ts events/registry.ts events/outbox.ts
    nats/connection.ts nats/streams.ts nats/subjects.ts
    relay.ts
    runtime/consumers.ts runtime/jobs.ts runtime/worker.ts
    scheduler.ts audit.ts health.ts context.ts
  modules/
    tenancy/  index.ts contracts/ domain/permissions.ts domain/data-limit.ts db/schema.ts db/migrations/
              services/tenants.ts services/members.ts services/api-keys.ts services/principal.ts auth.ts
    integrations/ index.ts contracts/ domain/crypto.ts db/schema.ts db/migrations/
              providers.ts gateway.ts services/connections.ts adapters/<provider>/mock.ts
    ai-tasks/ index.ts contracts/ db/schema.ts db/migrations/ runner.ts pricing.ts
              adapters/anthropic/contract.ts adapters/anthropic/mock.ts
infra/
  docker/Dockerfile docker/entrypoint.sh
  compose/docker-compose.yml compose/docker-compose.vm.yml compose/Caddyfile
  backup/backup.sh backup/restore-check.sh
  tofu/dns-cloudflare/ tofu/vm-vsphere/
.github/workflows/ci.yml .github/workflows/deploy-staging.yml
tests/unit/ tests/integration/ tests/e2e/
```

Layout call (deviation from `architecture/stack-and-layout.md`, recorded in Task 1): one npm package; the Next app lives in `src/app` and the other roles in `src/entry`, instead of `apps/web`, `apps/worker`, `apps/scheduler`. Next.js does not compile code outside its project folder without experimental flags, and one package keeps one dependency tree. `packages/mcp-local` arrives in R1.

---

### Task 1: Reset the repo for the rebuild

**Files:**
- Move: `src/`, `prisma/`, `tests/`, `scripts/`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `playwright.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.json`, `package.json`, `package-lock.json` → `reference/v1/` (git mv)
- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `.env.example`, `infra/compose/docker-compose.yml` (postgres + nats + mailpit services only for now), `tests/unit/sanity.test.ts`
- Modify: `docs/spec/architecture/stack-and-layout.md` (layout section: record the one-package call above), `.gitignore` (add `dist/`, `.next/`, `reference/v1/node_modules/`)

**Interfaces:**
- Produces: npm scripts `dev` (next dev -p 4240), `build`, `typecheck` (tsc --noEmit), `lint`, `test:unit`, `test:int`, `test` (both), `e2e`, `db:migrate`, `scout` (tsx src/entry/cli.ts). Path alias `@/*` → `src/*`. Vitest projects `unit` (`tests/unit/**`) and `integration` (`tests/integration/**`, `globalSetup: tests/integration/setup.ts`, single fork).

- [ ] **Step 1:** `git mv` the v1 files listed above into `reference/v1/`. Exclude `reference/**` in tsconfig, eslint and vitest.
- [ ] **Step 2:** Write the new config files. eslint-plugin-boundaries elements: `platform` (`src/platform/**`), `module` (`src/modules/*/**`, captured by name), `module-public` (`src/modules/*/index.ts`, `src/modules/*/contracts/**`), `app` (`src/app/**`, `src/entry/**`). Rule: a `module` file may import its own module, `platform`, and other modules' `module-public` only; `platform` may not import `module`.
- [ ] **Step 3:** Write `tests/unit/sanity.test.ts` asserting `1 + 1 === 2` and a lint fixture test `tests/unit/boundaries.test.ts` that runs ESLint programmatically on an in-memory file at `src/modules/a/services/x.ts` importing `@/modules/b/db/schema` and expects one `boundaries/element-types` error.
- [ ] **Step 4:** Run `npm install && npm run typecheck && npm run lint && npm run test:unit`. Expected: all pass.
- [ ] **Step 5:** Run `docker compose -f infra/compose/docker-compose.yml up -d postgres nats` and `docker compose ps`. Expected: both `healthy` (postgres `pg_isready`, nats `wget -qO- localhost:8222/healthz`; nats started with `-js -sd /data -m 8222`).
- [ ] **Step 6:** Commit `chore: move v1 to reference/ and scaffold Scout R0`.

### Task 2: Platform primitives (config, ids, errors, logging)

**Files:**
- Create: `src/platform/config.ts`, `src/platform/ids.ts`, `src/platform/errors.ts`, `src/platform/log.ts`
- Test: `tests/unit/platform/config.test.ts`, `tests/unit/platform/ids.test.ts`, `tests/unit/platform/errors.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env): Config` (Zod-parsed; fields `nodeEnv`, `databaseUrl`, `databaseAdminUrl`, `natsUrl`, `masterKey?: Buffer`, `masterKeyPrevious?: Buffer`, `authSecret`, `authDevSignin: boolean`, `forceMock: boolean`, `azureAd?: { tenantId, clientId, clientSecret }`, `publicUrl`); `config` (memoised).
  - `newId(prefix: IdPrefix): string`, `type IdPrefix = 't'|'usr'|'mbr'|'key'|'con'|'run'|'evt'|'cor'|'job'|'inv'|'cred'|'call'|'aud'|'dead'|'sch'`.
  - `class ScoutError extends Error { slug: string; status: number; detail?: string; errors?: {path: string; message: string}[] }`, `toProblem(e: unknown): { status: number; body: ProblemJson }`.
  - `log` (pino root), `logFor(ctx: { tenantId?: string; correlationId?: string; traceId?: string }): Logger`.

- [ ] **Step 1: Write failing tests.**
  - `loadConfig({ NODE_ENV: 'production', AUTH_DEV_SIGNIN: 'true', … })` throws with message containing `AUTH_DEV_SIGNIN must be false in production`.
  - `loadConfig({ NODE_ENV: 'production', … no SCOUT_MASTER_KEY })` throws with message containing `SCOUT_MASTER_KEY is required in production`.
  - `loadConfig` with `SCOUT_MASTER_KEY` that is not 32 bytes base64 throws `SCOUT_MASTER_KEY must be 32 bytes, base64`.
  - `newId('acc' as never)` is a type error (`// @ts-expect-error`); `newId('t')` matches `/^t_[0-9A-HJKMNP-TV-Z]{26}$/`; two ids created in order sort in order.
  - `toProblem(new ScoutError({ slug: 'key-revoked', status: 401, title: 'Key revoked' }))` returns status 401 and `type: 'https://scout.taazaa.ai/problems/key-revoked'`; `toProblem(new Error('x'))` returns 500 with title `Something went wrong` and no stack.
- [ ] **Step 2:** Run `npm run test:unit -- platform`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the four files to the signatures above.
- [ ] **Step 4:** Run `npm run test:unit -- platform`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): config, ids, errors, logging`.

### Task 3: Database foundation with schemas, roles and row-level security

**Files:**
- Create: `src/platform/db/bootstrap.sql`, `src/platform/db/client.ts`, `src/platform/db/tenant.ts`, `src/platform/db/migrate.ts`, `drizzle/<module>.config.ts` (one per module: platform, tenancy, integrations, ai), `tests/integration/setup.ts`, `tests/integration/helpers/db.ts`
- Test: `tests/integration/platform/rls.test.ts`, `tests/integration/platform/migrate.test.ts`

**Interfaces:**
- Produces:
  - `bootstrap.sql`: creates roles `scout_app` (LOGIN, NOBYPASSRLS) and `scout_admin` (LOGIN, BYPASSRLS), schemas `platform`, `tenancy`, `integrations`, `ai`, grants usage and DML to `scout_app`. Idempotent.
  - `appDb` (Drizzle over `config.databaseUrl`, user `scout_app`), `adminDb` (over `databaseAdminUrl`, user `scout_admin`, for migrations, platform-admin and cross-tenant jobs only).
  - `withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` runs a transaction on `appDb` with `select set_config('app.tenant_id', $1, true)` first.
  - `type Tx` (Drizzle transaction type).
  - `MODULE_ORDER = ['platform', 'tenancy', 'integrations', 'ai'] as const`; `migrateAll(): Promise<void>` runs bootstrap.sql then each module's folder `src/modules/<m>/db/migrations` (platform: `src/platform/db/migrations`) with `migrationsSchema: <m>`, `migrationsTable: '__migrations'`, as `scout_admin`.
  - RLS convention: each tenant table migration includes `alter table … enable row level security; alter table … force row level security; create policy tenant_isolation on … using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));`
  - Test helper `freshDatabase()`: integration global setup creates database `scout_test_<pid>` and runs `migrateAll()`.

- [ ] **Step 1: Write failing tests** using a test-only table `platform.rls_probe(id text, tenant_id text)` created in the test with the RLS convention:
  - Insert a row for `t_A` inside `withTenant('t_A')`; inside `withTenant('t_B')` a select returns 0 rows.
  - A select on `appDb` outside `withTenant` returns 0 rows (Review Focus 2).
  - An insert with `tenant_id = 't_B'` inside `withTenant('t_A')` throws (policy violation).
  - `migrateAll()` run twice succeeds and the second run applies 0 migrations.
- [ ] **Step 2:** Run `npm run test:int -- rls migrate`. Expected: FAIL.
- [ ] **Step 3:** Implement the files above. Compose Postgres init creates both roles via `bootstrap.sql` mounted into `/docker-entrypoint-initdb.d/` as well.
- [ ] **Step 4:** Run `npm run test:int -- rls migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): schemas, roles, RLS and migration runner`.

### Task 4: Event envelope, registry and outbox

**Files:**
- Create: `src/platform/db/schema.ts` (tables `outbox`, `processed_event`, `dead_job`, `schedule`, `audit_log`, `idempotency_key`), `src/platform/db/migrations/*`, `src/platform/events/envelope.ts`, `src/platform/events/registry.ts`, `src/platform/events/outbox.ts`, `src/platform/context.ts`
- Test: `tests/unit/platform/envelope.test.ts`, `tests/integration/platform/outbox.test.ts`

**Interfaces:**
- Produces:
  - `EnvelopeSchema` (Zod) and `type Envelope<D>`; `Actor = { kind: 'user'|'agent'|'system'; id: string; sourceId?: string }`.
  - `defineEvent<D>(type: string, schemaVersion: number, data: z.ZodType<D>): EventDef<D>`; `defineJob<D>(name: string, data: z.ZodType<D>, opts?: { maxDeliver?: number; backoffMs?: number[]; timeoutMs?: number }): JobDef<D>`; `eventDef(type)`, `jobDef(name)` lookups. Type must match `/^[a-z_]+\.[a-z_]+\.[a-z_]+$/`; job name must match `/^[a-z_]+(\.[a-z_]+)+$/`.
  - `type ModuleContext = { tenantId: string; actor: Actor; correlationId: string; causationId?: string; tx: Tx }`.
  - `publish<D>(ctx: ModuleContext, def: EventDef<D>, data: D, subject?: { type: string; id: string }): Promise<Envelope<D>>` inserts into `platform.outbox` (`id, kind 'event'|'job', nats_subject, payload jsonb, created_at, sent_at null, seq bigserial`).
  - `enqueueJob<D>(ctx: ModuleContext, def: JobDef<D>, data: D): Promise<string>` inserts a `kind 'job'` row; payload is an envelope with `type = 'jobs.' + name`.
  - Platform tables use `scout_admin`-only writes except `outbox`, `processed_event`, `audit_log` which `scout_app` may insert.

- [ ] **Step 1: Write failing tests.**
  - Unit: an envelope missing `correlationId` fails `EnvelopeSchema`; `defineEvent('Bad.Type', 1, z.object({}))` throws.
  - Integration: inside `withTenant`, `publish` then throw → after rollback `select count(*) from platform.outbox` is 0 (PLT-E1-S1-AC1).
  - Integration: `publish(ctx, def, { wrong: 1 })` where the data schema requires `userId` throws a Zod error and the transaction rolls back (PLT-E1-S1-AC2).
  - Integration: a published event's row has `nats_subject = 'scout.t_A.tenancy.member.added'`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): event envelope, registry and transactional outbox`.

### Task 5: NATS streams and the relay

**Files:**
- Create: `src/platform/nats/connection.ts`, `src/platform/nats/streams.ts`, `src/platform/nats/subjects.ts`, `src/platform/relay.ts`, `src/entry/relay.ts`
- Test: `tests/unit/platform/subjects.test.ts`, `tests/integration/platform/relay.test.ts`

**Interfaces:**
- Consumes: `platform.outbox` (Task 4).
- Produces:
  - `connectNats(): Promise<{ nc: NatsConnection; js: JetStreamClient; jsm: JetStreamManager }>`.
  - `ensureStreams(jsm): Promise<void>` creates or updates the four streams in Global Constraints.
  - `eventSubject(tenantId, type)`, `jobSubject(tenantId, name)`; `MODULE_SCHEMAS` constant (the 14 schema names from events-and-async.md).
  - `runRelay({ signal: AbortSignal, batchSize = 100, idleMs = 200 }): Promise<void>`: takes `pg_try_advisory_lock(hashtext('scout_relay'))` (waits and retries every 2s if not held), reads unsent rows ordered by `seq`, publishes each with `msgID = envelope.id`, sets `sent_at`; wakes early on `LISTEN scout_outbox` (outbox insert trigger `pg_notify('scout_outbox', '')`); on publish error stops the batch and retries after 1s without skipping.
  - `relayLagMs(): Promise<number>` (age of the oldest unsent row, 0 if none) for the health page.

- [ ] **Step 1: Write failing tests.**
  - Unit: `eventSubject('t_A', 'tenancy.member.added') === 'scout.t_A.tenancy.member.added'`; `eventSubject('t_A', 'jobs.x.y')` throws (reserved token).
  - Integration: publish 100 events in one transaction; a JetStream ordered consumer receives all 100 in `seq` order within 2 seconds; p95 commit-to-publish under 1 second at 50 events per second for 10 seconds (PLT-E1-S2-AC2).
  - Integration (Review Focus 1): stop the test NATS container (or point the relay at a closed port), publish 5 events through `withTenant` (succeeds), restart NATS, all 5 arrive in order and none twice.
  - Integration: two `runRelay` instances; only one holds the lock (assert via `pg_locks`), and every event arrives exactly once (PLT-E1-S2-AC1, AC3).
  - Integration: mark a sent row unsent and run the relay again; the stream message count does not increase (dedupe by `msgID`).
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): NATS streams and outbox relay`.

### Task 6: Consumers, jobs, retries and dead jobs

**Files:**
- Create: `src/platform/runtime/consumers.ts`, `src/platform/runtime/jobs.ts`, `src/platform/runtime/worker.ts`, `src/platform/dead-jobs.ts`, `src/platform/diagnostics.ts`, `src/entry/worker.ts`
- Test: `tests/integration/platform/consumers.test.ts`, `tests/integration/platform/jobs.test.ts`

**Interfaces:**
- Consumes: `defineEvent`, `defineJob`, `publish`, `enqueueJob`, `connectNats`.
- Produces:
  - `defineConsumer<D>({ name: string; event: EventDef<D>; orderedBy?: (e: Envelope<D>) => string; handle: (e: Envelope<D>, ctx: ModuleContext) => Promise<void> }): ConsumerDef`.
  - `defineJobHandler<D>(job: JobDef<D>, handle: (e: Envelope<D>, ctx: ModuleContext) => Promise<void>): JobHandlerDef`.
  - `startWorker({ consumers, jobs, signal }): Promise<void>`: one durable JetStream consumer per `ConsumerDef` on `SCOUT_EVENTS` (filter `scout.*.<type>`), one per job on `SCOUT_JOBS` (filter `scout.*.jobs.<name>`), `ack_wait` = job `timeoutMs` (default 60s). For each message: open `withTenant(envelope.tenantId)`, insert `platform.processed_event(consumer_name, event_id)` with `on conflict do nothing` (if no row inserted, ack and skip), take `pg_advisory_xact_lock(hashtext(name || key))` when `orderedBy` is set, run handler with `ctx.causationId = envelope.id`, commit, ack. On error: if `deliveryCount < maxDeliver` then `nak(backoffMs[deliveryCount - 1])`, else insert `platform.dead_job(id, tenant_id, consumer_or_job, envelope, last_error, attempts, dead_at)`, publish `platform.job.dead` (data `{ jobType, error, attempts }`) via outbox, and `term()`.
  - `listDeadJobs(): Promise<DeadJobView[]>` (`{ id, tenantId, name, lastError, attempts, deadAt }`, newest first).
  - `retryDeadJob(adminCtx, deadJobId)` re-enqueues the envelope with a new id and the same correlation id and deletes the dead row; `discardDeadJob(adminCtx, deadJobId)`; both write an audit entry (Task 8 `audit`; use a stub until Task 8 lands, then replace).
  - Diagnostics: job `platform.ping` (data `{ sentAt: string }`) whose handler inserts `platform.ping_result(id, tenant_id, sent_at, handled_at)`; `sendPing(ctx): Promise<string>` and `pingResult(id)` used by the System page and the exit check.

- [ ] **Step 1: Write failing tests.**
  - Deliver the same envelope twice to a consumer that increments a counter row; counter is 1 (PLT-E1-S3-AC1).
  - Review Focus 3: a handler that commits then the test forces the message not to be acked (kill the subscription before ack); after redelivery the counter is still 1.
  - Two events for the same `accountId` with a handler that sleeps 300 ms and records start and end times: the intervals do not overlap; events with different keys do overlap (PLT-E1-S3-AC2).
  - A job whose handler always throws, with `backoffMs: [50, 50]` and `maxDeliver: 3`: after 3 attempts a `dead_job` row exists with `attempts = 3` and the error text, and a `platform.job.dead` outbox row exists (PLT-E1-S4-AC1).
  - `retryDeadJob` makes the job run again (handler now succeeds) and removes the dead row (PLT-E1-S4-AC2).
  - `sendPing` round trip produces a `ping_result` within 3 seconds with the relay and worker running.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): idempotent consumers, jobs, retries and dead jobs`.

### Task 7: Scheduler

**Files:**
- Create: `src/platform/scheduler.ts`, `src/entry/scheduler.ts`
- Test: `tests/integration/platform/scheduler.test.ts`

**Interfaces:**
- Consumes: `enqueueJob`, `jobDef`.
- Produces:
  - `platform.schedule` columns: `id (sch_)`, `tenant_id` (or `t_platform`), `job_name`, `cron`, `timezone`, `payload jsonb`, `enabled`, `next_run_at`, `last_run_at`.
  - `upsertSchedule(adminCtx, { tenantId, jobName, cron, timezone, payload })`, `pauseSchedule(id)`, `resumeSchedule(id)`, `runNow(id)` (each audited).
  - `schedulerTick(now: Date): Promise<number>`: in one transaction selects `enabled and next_run_at <= now` rows `for update skip locked`, enqueues each job through the outbox, sets `last_run_at = next_run_at`, computes `next_run_at` with cron-parser from `now` in the row's timezone; returns how many it published. `runScheduler({ signal, everyMs = 15000 })` loops.

- [ ] **Step 1: Write failing tests.**
  - A row due one minute ago: one tick publishes exactly one job and moves `next_run_at` into the future (PLT-E2-S1-AC1).
  - Review Focus 4: two `schedulerTick` calls started concurrently for the same due row publish one job in total.
  - A paused row is not published; `runNow` publishes one job immediately without changing `next_run_at` (PLT-E2-S1-AC2).
  - Cron `0 11 * * 1` in `UTC` from Sunday 2026-10-25 12:00 gives `next_run_at` 2026-10-26 11:00Z.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): cron scheduler with exactly-once publishing`.

### Task 8: Audit log

**Files:**
- Create: `src/platform/audit.ts`
- Modify: `src/platform/dead-jobs.ts`, `src/platform/scheduler.ts` (replace the audit stub)
- Test: `tests/integration/platform/audit.test.ts`

**Interfaces:**
- Produces:
  - `audit(ctx: ModuleContext, entry: { action: string; subject?: { type: string; id: string }; before?: unknown; after?: unknown; ip?: string }): Promise<void>` inserts `platform.audit_log(id aud_, tenant_id, actor_kind, actor_id, source_id, api_key_id, action, subject_type, subject_id, correlation_id, ip, before, after, at)` in the caller's transaction. `before` and `after` are summaries: keys whose names match `/secret|token|password|key_hash|ciphertext/i` are replaced by `"[redacted]"`.
  - `platformAudit(entry)` writes with `tenant_id = 't_platform'` through `adminDb` (used by tenant creation, TEN-E1-S1-AC3).
  - `listAudit(ctx, { actorId?, apiKeyId?, sourceId?, subjectId?, from?, to?, cursor?, limit = 50 }): Promise<{ rows; nextCursor }>`.

- [ ] **Step 1: Write failing tests.** An audited change inside a rolled-back transaction leaves no audit row; a `before` containing `{ token: 'abc' }` is stored as `[redacted]`; `listAudit` filtered by `actorId` returns only that actor's rows, newest first; tenant B cannot read tenant A's rows (PLT-E3-S1-AC1, AC2).
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement and replace the stubs from Tasks 6 and 7.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): audit log`.

### Task 9: Tenants and memberships

**Files:**
- Create: `src/modules/tenancy/db/schema.ts` (`tenant`, `membership`, `invite`, `api_key`; better-auth tables are added in Task 11), migrations, `src/modules/tenancy/contracts/events.ts`, `src/modules/tenancy/services/tenants.ts`, `src/modules/tenancy/services/members.ts`, `src/modules/tenancy/index.ts`
- Modify: `docs/spec/architecture/event-catalog.md` (add `tenancy.tenant.created` with data `tenantId, slug, createdBy`; consumers: every module that seeds tenant defaults)
- Test: `tests/integration/tenancy/tenants.test.ts`, `tests/integration/tenancy/members.test.ts`

**Interfaces:**
- Consumes: `publish`, `audit`, `platformAudit`, `withTenant`, `adminDb`.
- Produces:
  - Events: `tenancy.tenant.created`, `tenancy.member.added` (`userId, role, invitedBy`), `tenancy.member.removed` (`userId, removedBy`), `tenancy.member.role_changed` (`userId, from, to`).
  - `createTenant(adminActor, { slug, name, currency, timezone, ownerEmail }): Promise<{ tenantId; ownerMembershipId }>`: platform admins only; creates the user row if the email is new (status invited membership).
  - `addMember(ctx, { email, role, crmOwnerIds? }): Promise<string>` (membership id, status `invited` if the user has never signed in).
  - `removeMember(ctx, membershipId)`, `changeMember(ctx, membershipId, { role?, extraPermissions?, dataLimit? })`.
  - `setCrmOwnerIds(ctx, membershipId, ids: Record<string, string>)`, `crmOwnerId(ctx, userId, crm): Promise<string | null>`, `userForCrmOwner(ctx, crm, ownerId): Promise<string | null>`.
  - `members(ctx, { permission? }): Promise<Member[]>` (`Member = { membershipId, userId, name, email, role, status, permissions }`).
  - `tenantsFor(userId): Promise<{ id; slug; name }[]>` (active memberships only).
  - Error copy: `That short name is taken.`, `A tenant needs at least one owner.`, `That CRM user is already linked to someone else.`

- [ ] **Step 1: Write failing tests** (ACs from `tenancy-and-access/tenants-and-memberships.md`):
  - TEN-E1-S1-AC1: tenant exists, owner membership is `invited`, `tenancy.tenant.created` outbox row exists. AC2: duplicate slug throws `That short name is taken.` AC3: a `platformAudit` row exists and no tenant audit row.
  - TEN-E1-S2-AC1: `addMember` gives status `invited` and a `tenancy.member.added` row. AC2: `removeMember` publishes `tenancy.member.removed`. AC3: removing or demoting the last active owner throws `A tenant needs at least one owner.`
  - TEN-E1-S3-AC2: `changeMember` publishes `role_changed` and writes audit before and after.
  - TEN-E1-S4-AC3/AC4: invited seller with `{ hubspot: '123' }` is returned by `userForCrmOwner(ctx, 'hubspot', '123')`; a second membership with the same id throws the CRM copy above.
  - TEN-E1-S5-AC1: `tenantsFor` omits removed memberships.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tenancy): tenants and memberships`.

### Task 10: Permissions, roles and data limits

**Files:**
- Create: `src/modules/tenancy/domain/permissions.ts`, `src/modules/tenancy/domain/data-limit.ts`, `src/modules/tenancy/contracts/principal.ts`
- Test: `tests/unit/tenancy/permissions.test.ts`, `tests/unit/tenancy/data-limit.test.ts`

**Interfaces:**
- Produces:
  - `PERMISSIONS` (the 35 strings in `roles-and-data-scopes.md`, as a const tuple) and `type Permission`.
  - `ROLE_PERMISSIONS: Record<'owner'|'leader'|'seller'|'operator', Permission[]>` exactly per the roles table. Seller rows marked "own" grant the permission (the data limit narrows rows); "grantable" means not granted by default.
  - `permissionsFor(role, extra: Permission[], platformAdmin: boolean): Permission[]` (platform admin gets all).
  - `type Principal = { tenantId: string; kind: 'user'|'api_key'|'oauth'; id: string; userId?: string; sourceId?: string; permissions: Permission[]; dataLimit: DataLimit; platformAdmin: boolean; supportAccess: boolean }`.
  - `can(p: Principal, perm: Permission): boolean`; `requirePermission(p, perm)` throws `ScoutError({ slug: 'forbidden', status: 403, detail: 'This key can\'t do that. It needs the `<perm>` scope.' })` for keys, `You don't have access to that.` for people.
  - `DataLimitSchema` (Zod discriminated union of `all`, `practices {ids}`, `own_accounts`, `sources {ids}`, `own_source`, `any_of {limits}`), `DEFAULT_DATA_LIMIT` per role and `own_source` for keys.
  - `describeAccess(p: Principal): string[]` (plain-words lines for the profile page, TEN-E3-S4-AC1), e.g. `You can see every account in this workspace.` for `all`.
  - `dataFilter` is not built in R0 (no account tables yet); it lands with Accounts in R1, together with the TEN-E3-S1-AC2 suite over list endpoints. TEN-E2-S3-AC2 ("Creator disabled" on keys, revoking OAuth grants) lands with the key and OAuth screens in R1.

- [ ] **Step 1: Write failing tests.** A table-driven test asserts, for each role, the presence and absence of: `review:act` (owner, leader yes; seller, operator no), `assign:act` (owner, leader only), `offers:manage` (owner, operator only), `integrations:manage` (owner only), `members:read` (owner, leader), `assignments:respond` (not operator). `PERMISSIONS.length === 35`. `DataLimitSchema` rejects `{ kind: 'practices' }` without `ids`. `describeAccess` for a seller returns a line containing `accounts assigned to you`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tenancy): permissions, roles and data limits`.

### Task 11: Microsoft sign-in, developer sign-in and sessions

**Files:**
- Create: `src/modules/tenancy/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/api/dev/sign-in/route.ts`, `src/modules/tenancy/services/principal.ts` (session part)
- Modify: `src/modules/tenancy/db/schema.ts` (better-auth `user`, `session`, `account`, `verification` in schema `tenancy`; `user` additional fields `platform_admin boolean default false`, `disabled_at`, `last_tenant_id`, `last_sign_in_at`)
- Test: `tests/integration/tenancy/auth.test.ts`

**Interfaces:**
- Consumes: `members`, `tenantsFor`, `permissionsFor`, `config`.
- Produces:
  - `auth` (better-auth instance): Drizzle adapter on `adminDb`; `socialProviders.microsoft` from `config.azureAd` (tenant id, client id, secret; scopes `openid profile email User.Read`); `session.expiresIn = 7 days`, `session.updateAge = 1 hour`; id generator returns `newId('usr')` for users.
  - Sign-in gate in `databaseHooks.session.create.before`: look up the user's active or invited memberships (email compared lower-cased, UPN accepted as email); none → reject with `Your account isn't set up in Scout yet. Ask your Scout owner to add you.`; invited memberships become active (TEN-E2-S1-AC3); disabled user → reject.
  - `sessionPrincipal(headers: Headers, tenantSlug: string): Promise<Principal | null>`: null when no session, session idle more than 12 hours, user disabled, or no active membership in that tenant; platform admins get every tenant with `supportAccess: true`. Membership and disabled checks are cached at most 60 seconds (TEN-E1-S2-AC2, TEN-E2-S3-AC1).
  - `POST /api/dev/sign-in { userId }` exists only when `config.authDevSignin`; creates a session through better-auth's internal adapter and sets the cookie; returns 404 otherwise.
  - `landingPathFor(userId): Promise<string>` → `/t/<last tenant slug>` or the first active tenant (TEN-E2-S1-AC1).

- [ ] **Step 1: Write failing tests.**
  - Review Focus 5: a member `ash@taazaa.com` signing in with profile email `Ash@Taazaa.com` passes the gate; a profile with only `userPrincipalName: ash@taazaa.com` passes; `nobody@taazaa.com` is rejected with the exact message above and no session row is created.
  - Invited membership becomes `active` after the first session.
  - A user disabled 5 seconds ago: `sessionPrincipal` returns null after the cache window (test with the cache TTL set to 0 via a test hook).
  - A session last updated 13 hours ago returns null.
  - `/api/dev/sign-in` returns 404 when `authDevSignin` is false.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Test the gate by calling the hook functions directly with fake profiles; the Microsoft redirect itself is covered by a manual check in Task 22.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tenancy): Microsoft and developer sign-in with membership gate`.

### Task 12: Minimal API keys, principal resolution and the /v1 foundation

**Files:**
- Create: `src/modules/tenancy/services/api-keys.ts`, `src/modules/tenancy/contracts/source-validator.ts`, `src/app/v1/_lib/route.ts`, `src/app/v1/me/route.ts`
- Modify: `src/modules/tenancy/services/principal.ts` (bearer part), `src/modules/tenancy/index.ts`
- Test: `tests/integration/tenancy/api-keys.test.ts`, `tests/integration/v1/me.test.ts`

**Interfaces:**
- Consumes: `Principal`, `requirePermission`, `publish`, `audit`, `toProblem`.
- Produces:
  - `interface SourceValidator { exists(ctx: ModuleContext, sourceId: string): Promise<boolean> }`; `registerSourceValidator(v)`. With none registered, creating a key with `arrivals:write` throws `Keys that send accounts need a source. Sources arrive in the next release.`
  - `createApiKey(ctx, { name, environment: 'live'|'test', scopes: Permission[], dataLimit?, sourceId?, expiresAt? }): Promise<{ id: string; secret: string }>`: secret `scout_<env>_` + 32 base62 characters; stores `prefix` (first 12 chars) and argon2id hash; publishes `tenancy.api_key.created` without the secret; audits.
  - `revokeApiKey(ctx, id, reason)`: sets `revoked_at`, publishes `tenancy.api_key.revoked`.
  - `resolvePrincipal(req: Request, tenantSlug?: string): Promise<Principal | null>`: bearer token → look up by prefix, verify argon2id, reject revoked (`ScoutError` slug `key-revoked`, 401) or expired (slug `key-expired`, 401); verified keys cached 60 seconds by prefix + hash of the token; updates `last_used_at`, `last_used_ip` at most once a minute. No bearer → `sessionPrincipal`.
  - `v1Route({ permission?: Permission }, handler: (req, principal, ctx) => Promise<Response | object>)`: resolves the principal (401 `unauthenticated` if none), checks permission, sets `x-correlation-id` (from header or `newId('cor')`), converts thrown errors with `toProblem`, serialises objects as `snake_case` JSON.
  - `GET /v1/me` returns `{ tenant: { id, slug, name }, kind, id, scopes, data_limit, source_id }`.
  - CLI hook used by Task 17: `scout keys:create --tenant <slug> --name <n> --scopes a,b [--test]`.

- [ ] **Step 1: Write failing tests.**
  - A created key calls `GET /v1/me` (invoke the route handler with a `Request`) and gets 200 with `kind: 'api_key'` and `scopes` equal to what was granted; no row anywhere contains the secret (search `api_key` and `outbox` payload text).
  - After `revokeApiKey`, with the cache TTL set to 0, the same call returns 401 and `type` ends with `/key-revoked` (TEN-E4-S3-AC2).
  - A wrong secret with a valid prefix returns 401 `unauthenticated`.
  - `createApiKey` with `arrivals:write` and no validator registered throws the copy above.
  - A key without `members:read` calling a test route declared with `permission: 'members:read'` gets 403 with `detail` `This key can't do that. It needs the \`members:read\` scope.`
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tenancy): API keys, principal resolution and /v1/me`.

### Task 13: Integrations core: connections, encrypted credentials, gateway and call log

**Files:**
- Create: `src/modules/integrations/db/schema.ts` (`connection`, `credential`, `call_log`; caps tables arrive in R1), migrations, `src/modules/integrations/domain/crypto.ts`, `src/modules/integrations/providers.ts`, `src/modules/integrations/gateway.ts`, `src/modules/integrations/services/connections.ts`, `src/modules/integrations/contracts/events.ts`, `src/modules/integrations/index.ts`, `src/modules/integrations/adapters/demo/mock.ts`
- Test: `tests/unit/integrations/crypto.test.ts`, `tests/integration/integrations/connections.test.ts`, `tests/integration/integrations/gateway.test.ts`

**Interfaces:**
- Consumes: `config.masterKey`, `config.forceMock`, `publish`, `audit`, `withTenant`.
- Produces:
  - `encryptSecret(plain: string, masterKey: Buffer, keyVersion: number): Sealed` (`{ ciphertext, iv, authTag, wrappedDataKey, keyVersion }`, all base64), `decryptSecret(s: Sealed, keys: Map<number, Buffer>): string`, `rewrap(s: Sealed, from: Buffer, to: Buffer, toVersion: number): Sealed`.
  - `PROVIDERS` registry: the 15 providers from `integrations/adapter-contract-and-providers.md` with `{ key, name, usedFor, interfaceOwner, release }`; adapters register with `registerAdapter(provider, { mock: () => Adapter, live?: (creds) => Adapter })` where `Adapter = { test(): Promise<{ ok: boolean; message: string; missingPermissions?: string[] }> }` plus provider-specific methods typed by the owning module.
  - `listConnections(ctx): Promise<ConnectionView[]>` merges `PROVIDERS` with rows so every provider appears (INT-E1-S1-AC1); `ConnectionView = { provider, name, mode, status, hint?, lastTestedAt?, lastTestResult?, lastError?, callsToday }`.
  - `saveCredential(ctx, provider, { kind, value, expiresAt? })` (hint = last 4 chars; old credential kept 1 hour then deleted by a scheduled job `integrations.credentials.cleanup`); `testConnection(ctx, provider)` (runs `adapter.test()` through the gateway, stores result, publishes `integrations.connection.tested`); `setMode(ctx, provider, mode)` (live needs a credential and a passing test in the last 10 minutes, else `Test the connection before switching it to live.`; with `forceMock` throws `This environment uses sample data only.`; publishes `integrations.connection.changed`); `setDisabled(ctx, provider, disabled)`.
  - `gateway.call<T>(ctx, provider, operation: string, fn: (adapter: Adapter) => Promise<T>, opts?: { units?: number; unit?: string; costCents?: number; apiKeyId?: string }): Promise<T>`: disabled → `ScoutError` slug `connection_disabled`; picks mock when `forceMock`, mode `mock`, or the principal uses a test key; times the call; writes `call_log` (outcome `ok`/`error`/`rate_limited`, redacted `request_summary`); after 3 consecutive errors sets status `failing`; a success sets `connected`.
  - `adapterFor(ctx, provider)` is internal to `gateway.call` in R0 (no other module calls live adapters yet).
  - A `demo` provider (test only, not in `PROVIDERS` shown to users) backs the tests.
  - Job `integrations.credentials.cleanup` (`defineJob` + handler): deletes replaced credentials older than 1 hour.
  - ESLint `no-restricted-imports` rule: provider SDK packages (`@anthropic-ai/sdk`, `@hubspot/api-client`, and any later SDK) may be imported only under `src/modules/*/adapters/*/live*` (INT-E5-S2-AC1).

- [ ] **Step 1: Write failing tests.**
  - Unit: `decryptSecret(encryptSecret('pat-abc-1234', K1, 1), {1: K1})` returns the plain text; tampering one byte of `ciphertext` throws; `rewrap` from K1 to K2 then decrypt with `{2: K2}` works; `JSON.stringify(sealed)` does not contain `pat-abc`.
  - Integration: `saveCredential` stores `hint = '1234'` and no column contains `pat-abc` (INT-E2-S1-AC2).
  - `setMode(live)` without a passing test throws the copy above (INT-E1-S2-AC1); after `testConnection` passes it succeeds and publishes `integrations.connection.changed` (AC2); with `forceMock` it throws `This environment uses sample data only.` (AC3).
  - `gateway.call` on a disabled connection throws `connection_disabled` (INT-E1-S3-AC1); three failing calls set status `failing`; every call writes one `call_log` row with the operation name.
  - `listConnections` for a fresh tenant returns 15 entries, all `mock` / `not_set_up`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(integrations): connections, encrypted credentials, gateway and call log`.

### Task 14: AI task runner, run log and rules fallback

**Files:**
- Create: `src/modules/ai-tasks/db/schema.ts` (`ai_run`, `ai_setting`), migrations, `src/modules/ai-tasks/runner.ts`, `src/modules/ai-tasks/pricing.ts`, `src/modules/ai-tasks/adapters/anthropic/contract.ts`, `src/modules/ai-tasks/adapters/anthropic/mock.ts`, `src/modules/ai-tasks/contracts/events.ts`, `src/modules/ai-tasks/index.ts`
- Test: `tests/integration/ai/runner.test.ts` (with a test-only task `echo_test` defined in the test file)

**Interfaces:**
- Consumes: `gateway.call`, `publish`, `withTenant`, `registerAdapter`.
- Produces:
  - `defineTask<I, O>({ name, promptVersion: string, model: string, system: string, buildUser: (i: I) => string, input: z.ZodType<I>, output: z.ZodType<O>, rules?: (i: I) => O, mock?: (i: I) => O, maxTokens: number, maxCostCents?: number }): TaskDef<I, O>`.
  - `interface AnthropicAdapter { complete(req: { model; system; user; maxTokens; jsonSchema: object }): Promise<{ json: unknown; inputTokens; outputTokens; cacheReadTokens }>; test() }` registered as provider `anthropic` with a mock implementation (deterministic: returns `task.mock(input)` shape when given, else a schema-valid minimal object). The live implementation lands in R1.
  - `runTask<I, O>(ctx, task: TaskDef<I, O>, input: I, opts: { subject: { type: string; id: string }; allowRules?: boolean; fresh?: boolean }): Promise<{ output: O; runId: string; mode: 'live'|'rules'|'mock' }>`: validates input; `input_hash = sha256(canonical JSON of input)`; reuses an `ok` run with the same task, prompt version and hash in the last 24 hours unless `fresh` (AI-E1-S2-AC1); mode resolution per `ai-tasks/rules-fallback.md` (connection mock → mock; live with key → live; no key, cap refusal or disabled → rules if defined, else `ScoutError` slug `ai_unavailable` with detail `Add a Claude key to use this.`); live output validated with the task schema, one retry with the Zod errors appended to the user message, second failure stored `invalid_output` and thrown with the task name (AI-E1-S1-AC2); cost from `pricing.ts` (cents per million tokens per model, rounded up); writes `ai_run`; publishes `ai.run.completed`.
  - `getRun(ctx, runId)`, `listRuns(ctx, { task?, status?, mode?, from?, to? })`, `runTotalsThisMonth(ctx)` (tokens and cost per task) for Admin → AI.
  - `AI_LABEL = { live: 'Written by Claude', rules: 'Assembled from rules', mock: 'Sample output' }`.

- [ ] **Step 1: Write failing tests** with `echo_test` (`input { text: string }`, `output { echoed: string }`, `rules: i => ({ echoed: i.text })`):
  - Connection mode mock: result mode `mock`, an `ai_run` row and an `ai.run.completed` outbox row.
  - Connection live with a fake adapter returning valid JSON: mode `live`, `ai_run.input_tokens` and `cost_cents > 0` (AI-E1-S1-AC1).
  - Fake adapter returning invalid JSON twice: `ai_run.status = 'invalid_output'` and the thrown error message contains `echo_test` (AC2).
  - Same input twice within 24 hours: second call makes no adapter call and returns the first `runId`; with `fresh: true` it calls again (AI-E1-S2-AC1).
  - Live connection with no credential: mode `rules`, output `{ echoed: 'hi' }` (AI-E2-S1-AC1 pattern). A task without `rules` throws `Add a Claude key to use this.`
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ai): task runner, run log and rules fallback`.

### Task 15: Web shell: sign-in, tenant layout, members, profile and health endpoints

**Files:**
- Create: `src/app/layout.tsx`, `src/app/globals.css`, `src/app/signin/page.tsx`, `src/app/page.tsx` (redirect to `landingPathFor`), `src/app/t/[tenant]/layout.tsx`, `src/app/t/[tenant]/page.tsx` (empty home: "Accounts arrive here in the next release."), `src/app/t/[tenant]/settings/members/page.tsx` + `actions.ts`, `src/app/t/[tenant]/profile/page.tsx`, `src/app/admin/tenants/page.tsx` + `actions.ts`, `src/app/healthz/route.ts`, `src/app/readyz/route.ts`, `src/components/ui.tsx`, `src/components/client.tsx`, `src/server/page-context.ts`, `src/entry/seed.ts` (`seed(): Promise<{ devApiKey: string }>`, contents as described in Task 17; Playwright global setup calls it), `tests/e2e/global-setup.ts`
- Modify: `tailwind.config.ts` (tokens from `architecture/design-and-copy.md`)
- Test: `tests/e2e/shell.spec.ts`, `tests/integration/platform/health.test.ts`

**Interfaces:**
- Consumes: `sessionPrincipal`, `tenantsFor`, `members`, `addMember`, `removeMember`, `changeMember`, `setCrmOwnerIds`, `createTenant`, `describeAccess`, `requirePermission`.
- Produces:
  - `pageContext(tenantSlug): Promise<{ principal: Principal; tenant; can: (p: Permission) => boolean }>` (redirects to `/signin` when null).
  - UI primitives carried over in spirit from v1 `src/components/ui.tsx` (PageHeader, Card, Badge, Button, Table/Th/Td with `numeric`, EmptyState, Notice) using the new tokens; `ActionForm` and `SubmitButton` client primitives.
  - Sign-in page: "Sign in with Microsoft" button when `config.azureAd` is set; developer user picker when `authDevSignin`.
  - Header: tenant switcher (only tenants from `tenantsFor`; platform admins see all with a "Support access" badge, TEN-E1-S5), profile link, sign out.
  - Members page (`members:manage` to change, `members:read` to view): list with role, status, CRM owner id per CRM; add member; change role, extra permissions and data limit; remove; copy strings from Task 9.
  - Profile page renders `describeAccess` lines (TEN-E3-S4-AC1).
  - `/admin/tenants` (platform admins only): list and create tenant (TEN-E1-S1).
  - `GET /healthz` → 200 `{ ok: true }` always; `GET /readyz` → 200 when `select 1` and NATS `flush()` both succeed within 2 seconds, else 503 naming the failing dependency.

- [ ] **Step 1: Write failing tests.** Integration: `/readyz` returns 503 with body naming `nats` when NATS is unreachable. E2E (dev sign-in, seeded data from Task 17's seed run in Playwright global setup): sign in as the owner, see the tenant home, add member `new.seller@taazaa.com` as Seller and see "Invited", open Profile and see the access lines; sign in as a seller and get "You don't have access to that." on `/settings/members` actions.
- [ ] **Step 2:** Run `npm run test:int -- health` and `npm run e2e -- shell`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): shell, sign-in, members, profile and health endpoints`.

### Task 16: Admin pages: System, Integrations, AI runs and Audit

**Files:**
- Create: `src/platform/health.ts`, `src/app/admin/system/page.tsx` + `actions.ts`, `src/app/t/[tenant]/settings/integrations/page.tsx` + `actions.ts`, `src/app/t/[tenant]/settings/ai/page.tsx`, `src/app/t/[tenant]/settings/audit/page.tsx`
- Test: `tests/e2e/admin.spec.ts`, `tests/integration/platform/system-health.test.ts`

**Interfaces:**
- Consumes: `relayLagMs`, `listDeadJobs`, `retryDeadJob`, `discardDeadJob`, `pauseSchedule`, `resumeSchedule`, `runNow`, `sendPing`, `pingResult`, `listConnections`, `saveCredential`, `testConnection`, `setMode`, `setDisabled`, `listRuns`, `runTotalsThisMonth`, `listAudit`.
- Produces:
  - `systemHealth(): Promise<{ relayLagMs: number; consumers: { name: string; pending: number; ackPending: number }[]; deadJobs: number; schedules: ScheduleView[] }>` (consumer numbers from `jsm.consumers.list`).
  - System page (platform admins; refreshes every 30 seconds, PLT-E4-S1-AC1): relay lag, pending per consumer, dead jobs with Retry and Discard (PLT-E1-S4-AC2), schedules with Pause, Resume and Run now (PLT-E2-S1-AC2), and "Send test event" showing "Round trip: <n> ms" or "No answer after 10 seconds. Check the worker and relay."
  - Integrations page (`integrations:manage`): one row per provider with "Using sample data" chip for mock, status chip ("Failing: <last error>"), last call, calls today; Manage panel with credential field showing `Saved. Ends in <hint>.`, Test button, mode switch, last 50 calls (INT-E1 R0 skeleton plus INT-E2-S1 and a basic INT-E3 list; filters and CSV export are R1).
  - AI page: runs table with filters task, status, mode, date and monthly totals per task (AI-E1-S3-AC1); a run detail drawer with redacted input (emails and phone numbers replaced by `[email]`, `[phone]`), output, prompt version, model, duration (AC2).
  - Audit page (`audit:read`): filters person, key, source, subject, date (PLT-E3-S1-AC2).

- [ ] **Step 1: Write failing tests.** Integration: `systemHealth()` reports `deadJobs: 1` after forcing a dead job (Task 6 helper). E2E as platform admin: System page shows the dead job, Retry removes it; "Send test event" shows a round trip; Integrations page lists 15 providers with "Using sample data"; saving a demo credential shows `Saved. Ends in 1234.`; AI page lists an `echo_test` run created in setup with the label `Sample output`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): admin system, integrations, AI runs and audit pages`.

### Task 17: CLI, roles and seed data

**Files:**
- Create: `src/entry/cli.ts`, `tsup.config.ts`
- Modify: `src/entry/seed.ts` (from Task 15: add the production refusal and the schedule)
- Modify: `package.json` (`build:server` = tsup building `src/entry/cli.ts` to `dist/cli.js`; `build` = `next build && npm run build:server`)
- Test: `tests/integration/entry/cli.test.ts`

**Interfaces:**
- Consumes: `runRelay`, `startWorker`, `runScheduler`, `migrateAll`, `createTenant`, `addMember`, `createApiKey`, `upsertSchedule`.
- Produces:
  - `scout <command>`: `web` (execs `node server.js` from the Next standalone output), `worker`, `scheduler`, `relay`, `all-background` (worker + scheduler + relay in one process), `migrate`, `seed`, `keys:create`, `tenants:create`. Each long-running role handles SIGTERM by aborting its signal and exits 0 within 10 seconds. `ensureStreams` runs at start of `relay`, `worker` and `all-background`.
  - Seed (idempotent, refuses when `NODE_ENV=production`): platform admin `yasir@taazaa.com`; tenant `taazaa` (USD, America/New_York) with owner `zach.wiant@taazaa.com`, invited sellers Ash, Mike, Andy with placeholder CRM owner ids; tenant `northwind` sample with one owner; schedule `integrations.credentials.cleanup` hourly; prints one dev API key for `taazaa` with scopes `status:read, members:read`.

- [ ] **Step 1: Write failing tests.** `seed` run twice leaves one `taazaa` tenant and one owner membership; `keys:create --tenant taazaa --name t --scopes status:read` prints a string starting `scout_live_`; `scout worker` started as a child process exits 0 within 10 seconds of SIGTERM; `NODE_ENV=production scout seed` exits non-zero with `Seed data is for local use only.`
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(entry): scout CLI with roles and seed data`.

### Task 18: Container image and compose for laptop and VM

**Files:**
- Create: `infra/docker/Dockerfile`, `infra/docker/entrypoint.sh`, `.dockerignore`, `infra/compose/docker-compose.vm.yml`, `infra/compose/Caddyfile`
- Modify: `infra/compose/docker-compose.yml` (add `migrate`, `web`, `worker`, `scheduler`, `relay`; Mailpit stays), `next.config.ts` (`output: 'standalone'`), `.env.example` (every variable from `loadConfig` with comments)

**Interfaces:**
- Produces:
  - Image `scout:<sha>`: multi-stage (deps → build → runtime on `node:22-bookworm-slim`), non-root user, contains `.next/standalone`, `.next/static`, `public`, `dist/cli.js`, migrations folders, `bootstrap.sql`. `ENTRYPOINT ["/app/entrypoint.sh"]`; `entrypoint.sh <role>` maps to `node dist/cli.js <role>`.
  - Laptop compose: `docker compose -f infra/compose/docker-compose.yml up` runs migrate (once, `depends_on` healthy postgres), then web on 4240, worker, scheduler, relay, with `SCOUT_FORCE_MOCK=true` and `AUTH_DEV_SIGNIN=true`.
  - VM compose: same services, `all-background` instead of three background services, `NODE_ENV=production`, env from `/opt/scout/.env`, Caddy on 443 for `scout.taazaa.ai` (profile `public-ip`) or `cloudflared tunnel run` with `TUNNEL_TOKEN` (profile `tunnel`), and the `backup` service from Task 19.

- [ ] **Step 1:** Build: `docker build -f infra/docker/Dockerfile -t scout:dev .`. Expected: success, image under 400 MB.
- [ ] **Step 2:** Run `docker compose -f infra/compose/docker-compose.yml up -d` then `curl -s localhost:4240/readyz`. Expected: `{"ok":true}`.
- [ ] **Step 3:** Run `docker compose exec web node dist/cli.js seed`, sign in with the developer picker, open Admin → System, click "Send test event". Expected: a round trip under 2 seconds (the R0 exit path web → outbox → NATS → worker).
- [ ] **Step 4:** Run `docker compose -f infra/compose/docker-compose.vm.yml --profile tunnel config`. Expected: valid config with `all-background`, `cloudflared` and `backup`.
- [ ] **Step 5:** Commit `feat(infra): container image and compose for laptop and VM`.

### Task 19: Backups and restore check

**Files:**
- Create: `infra/backup/backup.sh`, `infra/backup/restore-check.sh`, `infra/backup/Dockerfile` (postgres:17 client + `rclone` + `supercronic`), `infra/backup/crontab`
- Modify: `infra/compose/docker-compose.vm.yml` (service `backup`)

**Interfaces:**
- Produces:
  - `backup.sh`: `pg_dump -Fc` of the database to `/backups/scout-<UTC timestamp>.dump`, then `rclone copy` to `$BACKUP_REMOTE` when set (S3-compatible: Cloudflare R2 or any bucket); deletes local and remote dumps older than 14 days. Runs nightly at 02:00 UTC via supercronic.
  - `restore-check.sh [dump]`: restores the newest (or given) dump into a scratch database `scout_restore_check`, compares row counts of every table in schemas `platform`, `tenancy`, `integrations`, `ai` against the live database (allowing growth since the dump), prints `Restore check passed: <n> tables` or exits 1 naming the first mismatch, then drops the scratch database.

- [ ] **Step 1:** With the laptop stack seeded, run `docker compose -f infra/compose/docker-compose.vm.yml run --rm backup /backup.sh`. Expected: a `.dump` file in the backups volume.
- [ ] **Step 2:** Run `docker compose -f infra/compose/docker-compose.vm.yml run --rm backup /restore-check.sh`. Expected: `Restore check passed`.
- [ ] **Step 3:** Delete a row from the scratch restore (simulate by passing a truncated dump made with `--exclude-table-data tenancy.membership`). Expected: exit 1 naming `tenancy.membership`.
- [ ] **Step 4:** Commit `feat(infra): nightly backups and restore check`.

### Task 20: Infrastructure code (OpenTofu)

**Blocked on the hosting decision (`architecture/deployment-and-iac.md`, owner Yasir).** The recommended option is a VMware VM in Taazaa's data center with a Cloudflare Tunnel; this task builds that. If another option is chosen, replace `vm-vsphere` with `vm-hetzner` or `vm-azure` with the same inputs and outputs.

**Files:**
- Create: `infra/tofu/vm-vsphere/{main.tf,variables.tf,outputs.tf,cloud-init.yaml.tftpl}`, `infra/tofu/dns-cloudflare/{main.tf,variables.tf,outputs.tf}`, `infra/tofu/envs/staging/{main.tf,terraform.tfvars.example}`, `infra/tofu/README.md`

**Interfaces:**
- Produces:
  - `vm-vsphere` inputs: `vsphere_server`, `datacenter`, `cluster`, `datastore`, `network`, `template_name` (Ubuntu 24.04 cloud image), `vm_name`, `cpus = 2`, `memory_mb = 4096`, `disk_gb = 60`, `ssh_authorized_keys`, `scout_env` (sensitive map written to `/opt/scout/.env`), `image_tag`, `compose_profile` (`tunnel` or `public-ip`). Cloud-init installs Docker, writes `/opt/scout/{docker-compose.vm.yml,.env}`, logs in to the registry, runs `migrate` then `up -d`. Outputs `vm_ip`.
  - `dns-cloudflare` inputs: `zone = "taazaa.ai"`, `hostname = "scout"` (or `scout-staging`), `mode` (`tunnel`: creates the tunnel, its config pointing at `http://web:4240`, and a proxied CNAME, outputs `tunnel_token` as sensitive; `a_record`: creates a proxied A record to `target_ip`).
  - `envs/staging` composes both.

- [ ] **Step 1:** Run `tofu -chdir=infra/tofu/envs/staging init -backend=false && tofu -chdir=infra/tofu/envs/staging validate`. Expected: `Success! The configuration is valid.`
- [ ] **Step 2:** With real credentials (owner: Yasir), run `tofu plan` then `tofu apply` for staging. Expected: VM up, `https://scout-staging.taazaa.ai/readyz` returns `{"ok":true}`.
- [ ] **Step 3:** Commit `feat(infra): OpenTofu modules for VMware VM and Cloudflare DNS`.

### Task 21: CI and staging deploy

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`

**Interfaces:**
- Produces:
  - `ci.yml` on every push and pull request: services `postgres:17` (init with `bootstrap.sql`) and `nats:2.11` (`-js`); steps `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:int`, `npx playwright install --with-deps chromium && npm run e2e`, `docker build`. On `scout-rebuild` and `main`: push `ghcr.io/yasirdrabu/tz-scout:<sha>` (registry owner can change when Taazaa's GitHub organisation exists).
  - `deploy-staging.yml` (manual `workflow_dispatch` with `image_tag`, environment `staging` with required reviewer): SSH to the staging VM (`STAGING_SSH_HOST`, `STAGING_SSH_KEY` secrets), set `IMAGE_TAG`, run `docker compose pull`, `run --rm migrate`, `up -d`, then poll `/readyz` for 60 seconds.

- [ ] **Step 1:** Push the branch. Expected: `ci.yml` green.
- [ ] **Step 2:** After Task 20 Step 2, run `deploy-staging` with the latest tag. Expected: green, and `/readyz` ok.
- [ ] **Step 3:** Commit `ci: build, test and staging deploy workflows`.

### Task 22: R0 exit check and notes

**Files:**
- Create: `docs/CHANGELOG.md` entry `## 2026-10-xx: Scout R0 foundation`, `README.md` (rewrite: what Scout is, run on a laptop, run tests, deploy)
- Modify: `docs/spec/migration-and-rollout/release-plan.md` (tick R0 exit items with dates)

- [ ] **Step 1:** On the laptop stack: a tenant, users and an API key exist (`seed`, then `curl -H "Authorization: Bearer <key>" localhost:4240/v1/me` returns the tenant). Expected: 200.
- [ ] **Step 2:** On the laptop and on staging: Admin → System "Send test event" round trip succeeds.
- [ ] **Step 3:** Force a dead job (`scout` test command or the Task 6 helper) and see it in Admin → System.
- [ ] **Step 4:** On staging: run `backup.sh` then `restore-check.sh`. Expected: `Restore check passed`.
- [ ] **Step 5:** With the Entra app registration settings on staging and `AUTH_DEV_SIGNIN=false`, sign in with Microsoft as Zach (member) and as a non-member (gets the refusal message).
- [ ] **Step 6:** `npm run typecheck && npm run lint && npm test && npm run e2e`. Expected: all pass.
- [ ] **Step 7:** Commit `docs: R0 changelog, README and exit check`.
