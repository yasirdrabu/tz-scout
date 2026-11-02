# Workspace Database Split (D35, plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each workspace's data lives in its own Postgres database on a shared server, with users,
sign-in and the workspace list in a control-plane database.

**Architecture:** Two phases. Phase A (Tasks 1–4) routes every query through the right door while
there is still one physical database (`SCOUT_WORKSPACE_DATABASES=shared`, the default): a control-plane
door for tenancy and platform-wide tables, a workspace door resolved per tenant, and an outbox, relay
and scheduler that work per database. Every existing test stays green after each task. Phase B (Tasks
5–7) adds `per_workspace` mode: provisioning, per-database migrations, pooled routing, the move tool,
and runs the integration suite in that mode.

**Tech Stack:** TypeScript, Drizzle + postgres.js, Postgres 16, NATS JetStream, Vitest.

**Spec:** `docs/spec/architecture/tenant-infrastructure.md` (D35, binding). Code map:
`docs/plans/2026-11-02-workspace-database-split.map.md` (file:line, approximate).

## Global Constraints

- Control plane: schemas `tenancy` and the platform-wide `platform` tables (`schedule` rows of
  `t_platform`, `ping_result`, platform audit). Workspace database: every other module schema plus the
  tenant-scoped `platform` tables (`outbox`, `processed_event`, `idempotency_key`, `dead_job`,
  `delivery_attempt`, workspace `schedule` rows, workspace audit log). The control plane gets its own
  `outbox`, `processed_event`, `idempotency_key` and `dead_job` for tenancy and platform work.
- Workspace databases are named `scout_t_<tenant id lowercased>`; same roles, grants and RLS policies
  as today, `app.tenant_id` still set.
- `t_platform` is the control plane, never a workspace database.
- Module boundaries unchanged: workspace modules reach tenancy only through `@/modules/tenancy`'s index;
  tenancy never runs SQL on a workspace transaction.
- Default mode `shared` must behave exactly as today (same single database); `per_workspace` is opt-in
  by config until Task 7.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A tenancy call made with a workspace `ctx` in `per_workspace` mode never reads a workspace database
   (and vice versa): prove it with a test that fails if tenancy SQL runs on the workspace transaction.
2. Writes that used to share one transaction and now span two databases (tenant creation and its
   `tenant.created` event, sign-in completion and its audit rows, dead-job retry): no lost event and no
   duplicate on retry (control-plane outbox, idempotent consumers).
3. The relay publishes from every database fairly and keeps per-database ordering; one slow or broken
   workspace database doesn't stop the others.
4. Pool limits: 200 workspaces never open more than the global cap of connections per process.
5. A workspace in `provisioning`, `failed`, `deleting` or `suspended` gets the right refusal on requests,
   consumers and jobs.

---

## Phase A: route through the right door (one physical database)

### Task 1: Doors and the workspace registry

**Files:** `src/platform/db/client.ts`, `tenant.ts`, create `src/platform/db/doors.ts`; `config.ts`
(`SCOUT_WORKSPACE_DATABASES` = `shared` | `per_workspace`, default `shared`; `SCOUT_WORKSPACE_POOL_MAX`
3; `SCOUT_WORKSPACE_POOL_CAP` 60); `src/modules/tenancy/db/schema.ts` + migration (`tenancy.workspace_infra`
per the spec: `tenant_id` pk, `region`, `database`, `status`, `schema_versions` jsonb, `seats`, `quotas`
jsonb, `test`, `last_backup_at`, `support_access_until`, `support_access_by`; key columns come with plan
2); backfill a row (`active`, region `us-1`, database `scout`) for every existing tenant.

**Interfaces (produces):**
- `controlDb` (app role) and `controlAdminDb` (admin role): the control-plane connections (today's
  `appDb`/`adminDb` URLs). `appDb`/`adminDb` stay as deprecated aliases until Task 4 removes their last
  uses.
- `withControl<T>(fn: (tx) => Promise<T>): Promise<T>` and `withControlAdmin`.
- `workspaceDb(tenantId): Promise<{ app: Db; admin: Db }>` — `shared` mode returns the control-plane
  connections; `per_workspace` comes in Task 5.
- `withTenant(tenantId, fn)` resolves `workspaceDb(tenantId).app` (behaviour identical in `shared`).
- `withWorkspaceAdmin(tenantId, fn)` for cross-RLS work in one workspace.
- `listWorkspaceDatabases(): Promise<Array<{ tenantId; admin: Db }>>` — `shared` returns one entry
  standing for all tenants (`tenantId: '*'`).
- `ScoutError` slug `workspace-unavailable` (503) for a workspace not `active`.

- [ ] Tests (unit + integration): shared mode resolves the same pool; `workspace_infra` backfilled; a
  tenant whose infra row is `provisioning` gets `workspace-unavailable` from `withTenant`.
  Commit `feat(platform): control-plane and workspace doors`.

### Task 2: Tenancy off the workspace transaction

**Files:** every service in `src/modules/tenancy/services/*` (map §2, §9): tenancy SQL runs on
`withControl`/`withControlAdmin` (or a control transaction passed in by a tenancy route), never on a
workspace `ctx.tx`. Public functions keep their signatures (they still take `ctx` for tenant id and
actor). `api-keys.ts:390,438` stop using `withTenant`. `auditEntries` and `memberDirectory` joins that mix
workspace and tenancy tables become two reads (workspace rows, then names from tenancy). Tenancy events
(`tenant.created`, member changes) go through a control-plane outbox (`platform.outbox` in the control
database is the same table in shared mode — add an `origin` column only if the relay needs it).
`completeSignIn` writes its per-tenant audit rows after the control transaction commits, through the
workspace door, idempotently.

- [ ] Tests: a guard test that wraps the workspace transaction so any query on a `tenancy.*` table
  through it fails, and runs the members, sign-in, api-keys, principal and v1 members suites with it on;
  tenant creation publishes `tenant.created` exactly once across a retry. Commit
  `refactor(tenancy): use the control plane, never the workspace transaction`.

### Task 3: Outbox, relay, scheduler and dead jobs per database

**Files:** `src/platform/relay.ts` (one loop over `listWorkspaceDatabases()` plus the control plane,
round-robin, an advisory lock and `LISTEN` per database, a broken database logged and skipped with
backoff), `scheduler.ts` (workspace schedules read and outbox rows written in that workspace's database;
`t_platform` schedules on the control plane), `upsertSchedule` uses the caller's `ctx.tx`, dead-job
record/retry in the database the job belongs to, `processed_event` and `idempotency_key` written where the
work happens. Tests: relay and scheduler suites in shared mode unchanged; new unit tests for the
round-robin and skip-on-error with fake databases.

- [ ] Commit `refactor(platform): outbox, relay and scheduler per database`.

### Task 4: Cross-tenant readers and the last shared-database assumptions

**Files:** `ai-tasks/services/admin-runs.ts` (loop over workspace databases, merge, sort, cursor),
`integrations/services/inbound.ts` (webhook token → tenant through a control-plane index
`tenancy.inbound_route(token_hash, tenant_id)` written when a connection is saved), `integrations/jobs.ts`
credential cleanup (loop), `delivery_attempt` readers, `diagnostics.ts`, `v1-route.ts:288` (`t_platform`
uses the control plane), CLI (`seed`, `import`, backfills, `rescore`) through the doors; remove the last
`appDb`/`adminDb` uses in src (tests may keep them in shared mode).

- [ ] Full suite green in shared mode. Commit `refactor: cross-workspace readers go through the doors`.

## Phase B: one database per workspace

### Task 5: Provisioning and per-workspace connections

**Files:** `doors.ts` (`per_workspace`: per-tenant pools created lazily with `SCOUT_WORKSPACE_POOL_MAX`,
closed after 10 minutes idle, LRU-closed over `SCOUT_WORKSPACE_POOL_CAP`; infra row cached 60 s);
`src/platform/db/migrate.ts` (`migrateControlPlane()`, `migrateWorkspace(tenantId)`, `migrateAll` = control
then every workspace 4 at a time, recording `schema_versions`, marking `failed` and continuing);
bootstrap split (control roles/schemas; workspace database grants and schemas); provisioning job in
tenancy (`provisionWorkspace(tenantId)`: create database (from a migrated template database
`scout_t_template` when present, else migrate), seed defaults by running the `tenant.created`
consumers against it, set `active`; each step idempotent; `failed` with step and error); admin
`POST /api/v1/admin/tenants/{id}:retry-provisioning`; `createTenant` returns at once with status
`provisioning`.
- [ ] Tests in `per_workspace` mode: create a tenant → database exists, migrated, seeded, `active`; a
  failure mid-way and a retry; two tenants can't see each other even with RLS off on the admin role;
  pool cap. Commit `feat(platform): a database per workspace`.

### Task 6: Move existing workspaces

**Files:** `src/entry/cli.ts` `tenant split <slug>` and `tenant split --all` (spec "Moving existing
workspaces": provision, pause writes for that tenant (`status` `moving`, requests 503 with Retry-After),
copy module by module in dependency order with `COPY (SELECT ... WHERE tenant_id = ...)`, verify counts
per table, switch the infra row's `database`, delete the tenant's rows from the shared database, resume).
- [ ] Integration test: a tenant with data in shared mode, split, every API read returns the same data,
  the shared database has none of its rows. Commit `feat(cli): move a workspace into its own database`.

### Task 7: Run everything per workspace

**Files:** `tests/integration/setup.ts` + helpers (control database per run; template workspace
database; tenants provisioned per test file from the template), `tests/integration/close-dbs.ts` (close
workspace pools), e2e global setup, `infra/compose` (env `SCOUT_WORKSPACE_DATABASES=per_workspace`),
default mode becomes `per_workspace`; docs (`data-conventions.md`, `module-boundaries.md`, deployment
spec, api-gaps §22 rows).
- [ ] Full suite and e2e green in `per_workspace` mode; shared mode kept only for the move tool.
- [ ] `scout-verify`: run `tenant split --all`, sign in, walk the queue, account page, settings; create a
  new workspace from Admin and see it provision. Commit `feat: one database per workspace by default`.
