# Split map: control-plane DB + per-workspace DBs (repo: C:\dev\tz-scout-infra)
Paths relative to repo root. Spec: docs/spec/architecture/tenant-infrastructure.md (D35). Read-only research.

## 1. src/platform/db/*
- client.ts:25 `appDb` = lazy drizzle(postgres(config.databaseUrl, max=databasePoolMax)) as scout_app (RLS applies).
- client.ts:34 `adminDb` = lazy drizzle(postgres(config.databaseAdminUrl)) as scout_admin (bypassrls); default pool size.
- client.ts:40 `adminTransaction(tx|undefined, fn)`: savepoint on a given admin tx, else `adminDb.transaction`.
- client.ts:45 `closeDbs()` ends both pools (cli.ts:285, tests close-dbs.ts, e2e).
- tenant.ts:4 `Tx` type derived from appDb.transaction param (same Tx type used for admin txs). tenant.ts:11 `withTenant(tenantId, fn)` = `appDb.transaction` + `set_config('app.tenant_id', id, true)`. Single door; no pool resolution yet.
- migrate.ts:5 MODULE_ORDER = platform, tenancy, integrations, ai, offers, accounts, crm, intake, scoring, routing, playbooks.
- migrate.ts:8 `migrationsFolder(m)`: platform -> src/platform/db/migrations; else src/modules/(m, or ai-tasks for ai)/db/migrations (uses process.cwd()).
- migrate.ts:22 `bootstrapDatabase(superuserUrl)`: runs bootstrap.sql in the DB the URL names, then alter role password from SCOUT_APP_DB_PASSWORD / SCOUT_ADMIN_DB_PASSWORD.
- migrate.ts:51 `migrateAll({adminUrl?, folders?})`: ONE db; loops all 11 modules in order via drizzle migrator; table "<module>"."__migrations" per module; returns {applied}; throws without meta/_journal.json. No per-db/per-tenant concept; no schema_versions recorded.
- guarded-tx.ts:25 `guardTx(tx)`: clone of drizzle PostgresJsTransaction whose client throws TransactionClosedError after close(); used only by worker runInTx (runtime/worker.ts:247). Depends on drizzle internals.
- bootstrap.sql:9-13 roles scout_app (nobypassrls) / scout_admin (bypassrls, createdb); :22-25 alter database current_database() owner scout_admin, grant connect to scout_app; :27-37 create 11 schemas (platform tenancy integrations ai offers accounts intake scoring routing crm playbooks) authorization scout_admin; :39-41 grants usage/tables/sequences to scout_app; :44-52 revoke update,delete on platform.audit_log and delete on intake.arrival from scout_app; :54-58 default privileges for scout_admin. Creates ALL 11 schemas in whichever DB it runs against.
- migrations/platform: 0000_platform_events (outbox, processed_event, platform.notify_outbox() trigger fn -> pg_notify scout_outbox, line 31), 0001_platform_jobs (dead_job, ping_result), 0002 dead_job_unique, 0003 delivery_attempt, 0004 scheduler, 0005 audit_log (RLS forced), 0006 audit_support_access, 0007 idempotency_key_rls, 0008 idempotency_principal.
- schema.ts (all platform.*):
  - :13 outbox (seq, id, tenant_id, kind, nats_subject, payload, created_at, sent_at). RLS-exempt (tenant_id for tracing). Spec: per-workspace.
  - :28 processed_event (consumer_name,event_id PK; no tenant_id). RLS-exempt. Spec: per-workspace.
  - :38 idempotency_key (tenant_id,principal_id,key PK). TENANT-SCOPED, RLS forced (0007). Spec: per-workspace. Session routes store keys under tenant t_platform (see 3).
  - :56 dead_job (tenant_id, consumer_or_job, envelope...; unique (consumer_or_job, envelope id)). RLS-exempt; via adminDb. Mixed: workspace jobs + t_platform jobs.
  - :75 ping_result (tenant_id always t_platform in practice). RLS-exempt. Control plane per spec.
  - :88 delivery_attempt (consumer_name,event_id PK; no tenant_id). RLS-exempt; adminDb (worker.ts:319-339). Not named in spec; per-message, workspace-natured.
  - :103 schedule (tenant_id, job_name, cron, ..., next_run_at; unique (tenant_id,job_name)). RLS-exempt; tenant_id t_platform for platform jobs. Mixed.
  - :128 audit_log. TENANT-SCOPED, RLS forced; platform-wide entries use tenant t_platform via adminDb. Mixed.
- tests/integration/platform/rls-catalog.test.ts:8 PLATFORM_WIDE allowlist = outbox, processed_event, dead_job, schedule, delivery_attempt, ping_result; scans all 11 schemas in a single DB.

## 2. Callers of withTenant / appDb / adminDb / adminTransaction (src/)
Lint: eslint.config.mjs:45 ADMIN_DB_ALLOWED = src/platform/**, src/modules/tenancy/services/**, tenancy/auth.ts, integrations/jobs.ts, integrations/services/inbound.ts, http/routes/v1/_lib/v1-route.ts, src/entry/**.

### platform
- relay.ts:134,151,186 adminDb: select/update platform.outbox of ALL tenants (one shared outbox). Cross-tenant. relay.ts:62 also opens its own postgres(config.databaseAdminUrl) for the advisory lock + LISTEN.
- runtime/worker.ts:287 (deliverOnce) and :371 (processMessage) withTenant(envelope.tenantId): one tenant; processed_event insert + handler share the tx.
- runtime/worker.ts:319,327,336 adminDb: delivery_attempt read/upsert/delete (outside handler tx, one message).
- dead-jobs.ts:51 adminDb.transaction (recordDeadJob): dead_job insert + publish() of platform.job.dead into outbox in same admin tx, tenant = envelope's tenant. One tenant's data written on admin DB.
- dead-jobs.ts:82 listDeadJobs (cross-tenant read); :107 retryDeadJob / :149 discardDeadJob via adminTransaction: retry inserts into outbox for the dead envelope's tenant (:114,:123) + platformAudit. Cross-tenant admin action.
- scheduler.ts:71 upsertSchedule adminDb.transaction (+platformAudit); :117 setEnabled, :144 runNow (adminTransaction); :168 schedulerTick adminDb.transaction: selects ALL due schedule rows (for update skip locked) and enqueueJob()s into the outbox with ctx.tx = the SAME admin tx (scheduler.ts:56-64,:180). Cross-tenant.
- audit.ts:79 platformAudit -> (tx ?? adminDb).insert(auditLog), tenant t_platform. Control-plane data. Callers: dead-jobs, scheduler, tenancy tenants.ts:92,238, platform-admins.ts:48,82.
- diagnostics.ts:33 pingResult(id, db=adminDb) control-plane read; :51 testEventRoundTrip withTenant(PLATFORM_TENANT, enqueue ping); ping handler then runs under withTenant(t_platform). There is no workspace DB for t_platform.
- health.ts:40 appDb.execute(select 1) readiness; :130 systemHealth adminDb: relayLag (outbox), dead_job count, schedule list. Cross-tenant.

### http
- http/routes/v1/_lib/v1-route.ts:251 v1Route: withTenant(principal.tenantId, fn); idempotency claim in the same tx.
- v1-route.ts:288 personRoute: admin -> adminDb.transaction(fn) (adminRoute); sessionRoute -> withTenant(t_platform, fn) (only so Idempotency-Key lands under t_platform; handlers use tx for tenancy reads e.g. signInFacts in me/route.ts).
- http/routes/v1/inbound/hubspot/[connectionId]/route.ts:62 withTenant(tenantId) after connectionTenant().
- adminRoute handlers (ctx.tx is an adminDb tx): admin/ai-runs/route.ts:22 + [id]:8 (cross-tenant ai.ai_run reads = WORKSPACE data), admin/health/route.ts:13 (listTenants, systemHealth, listDeadJobs, ai runsSummary), admin/jobs/[id]/route.ts:8,12, admin/platform-admins/route.ts:7,10 + [id]:6, admin/schedules/[id]/route.ts:11,16,21, admin/tenants/route.ts:25,41, admin/tenants/[id]/route.ts:6, admin/test-event/route.ts:9.

### modules (non-tenancy)
- ai-tasks/runner.ts:124 withTenant: writes ai_run in its own tx (one tenant). ai-tasks/services/admin-runs.ts:8-80 allRuns/anyRun/runsSummary: admin tx reads ai.ai_run across tenants = cross-tenant WORKSPACE data.
- integrations/gateway.ts:100,:229 withTenant (connection create / call_log, own tx); services/connections.ts:301 withTenant. One tenant.
- integrations/services/inbound.ts:11 adminDb connectionTenant(connectionId): selects integrations.connection with NO tenant filter = cross-tenant lookup over workspace data (unauthenticated webhook). Needs a control-plane connection_id -> tenant index.
- integrations/jobs.ts:17 adminDb: deletes integrations.credential rows replaced >1h ago across ALL tenants. Scheduled under t_platform (seed.ts:203, cron hourly). Cross-tenant job over workspace data.
- crm: adapters/hubspot/mock.ts:55,89; fixtures.ts:28,75,85,96,106,125,153,168; services/handoff.ts:118,173,216; links.ts:26; undo.ts:139,207: withTenant(ctx.tenantId), own-tx ops. playbooks/services/draft.ts:105 withTenant (attempt count). All one tenant.

### tenancy (control-plane data unless noted)
- auth.ts:111 better-auth drizzleAdapter(adminDb) (user/session/account/verification).
- services/sign-in.ts:30-228 adminDb reads/writes of user/membership/tenant/session. EXCEPTION sign-in.ts:191-215 completeSignIn: one adminDb tx updates membership invited->active across tenants AND calls audit({tenantId: m.tenantId, tx}) writing platform.audit_log rows per tenant = control-plane write plus workspace audit rows.
- services/principal.ts:55 loadAccess (user JOIN tenant JOIN membership JOIN role_permission), :159,:216 session touch, :209 sessionUser.
- services/api-keys.ts:380 createKeyFromCli tenant lookup; :390 withTenant(t.id, createApiKey) and :438 touch() withTenant(tenantId, update api_key): withTenant used on tenancy.api_key (CONTROL-PLANE table). :475 authenticateKey adminDb api_key JOIN tenant.
- services/dev-sign-in.ts:50; members.ts:526 tenantsFor; platform-admins.ts:20,33,70; workspaces.ts:17-49; tenants.ts:53 createTenant, :133 listTenants, :149-182 ensurePlatformAdmin/userIdForEmail/renameHandleUsers, :203 adminTenants (subselects over membership+user only), :229 setTenantStatus. All control plane.

### entry
- cli.ts:109,138,155 and seed.ts:87,159,183,215 withTenant per tenant (tenants found via listTenants()).

## 9. Workspace-code reads of tenancy data (must go through a tenancy index after the split)
No workspace module imports tenancy db/schema or writes raw SQL against tenancy.* (grep outside src/modules/tenancy: none). All coupling is via the tenancy PUBLIC API (src/modules/tenancy/index.ts) taking ctx and querying tenancy tables on ctx.tx (the workspace tx today). After the split these would hit the wrong DB:
- services/members.ts (ctx.tx): members :487 (membership + names), memberRole :469, crmOwnerId :438, userForCrmOwner :453, assignableMembers :752, addMember :238 (insert membership/user + publish memberAdded + audit), removeMember :310, changeMember :330, setCrmOwnerId(s) :397/:419, memberList :573, inviteMembers :659, suspend/reactivate/signOutMemberEverywhere :724-741 (endSessions(ctx.tx) touches tenancy.session).
- services/directory.ts: memberDirectory :8 (membership INNER JOIN user = names of active members), userNames :18 (user.name by id), apiKeyNames :26.
- services/tenants.ts: tenantSummary :111, tenantTimezone :123 (tenancy.tenant on ctx.tx).
- services/preferences.ts: get/set/clearPreference (member_preference on ctx.tx).
- services/api-keys.ts: createApiKey, revokeApiKey, listApiKeys, activeKeysBySource, revokeKeysForSource, createKeyWithAccess, rotateSourceKey, revokeSourceKey, assertSourceExists (api_key on ctx.tx; :106,:111,:254 call the intake SourceValidator (contracts/source-validator.ts, registered in entry/compose.ts:13) with the same ctx.tx, i.e. a tenancy tx calling into workspace data).
- services/audit.ts:61 auditEntries: workspace listAudit(ctx) (platform.audit_log) plus user/membership/api_key lookups on the same ctx.tx (:71-80 `user LEFT JOIN membership`, :104 user names, :109 api_key names): two queries, not one SQL join, but one tx.
- services/sessions.ts signInFacts(tx, ids) (me/route.ts:21,48; memberList :587).
- Workspace callers (file:line of the import): accounts/services/notes.ts:2 (members); crm/fixtures.ts:2, services/activity.ts:3, batches.ts:4 (members, tenantTimezone), follow-through.ts:4 (userForCrmOwner), handoff.ts:6 (crmOwnerId, members, tenantSummary, tenantTimezone), owners.ts:3 (members, crmOwnerId, setCrmOwnerId), preflight.ts:2, undo.ts:4; intake/services/batches-read.ts:3 (apiKeyNames, userNames), caps.ts:2 (tenantTimezone), imports.ts:2 (userNames), source-read.ts:3 (activeKeysBySource, userNames), sources.ts:3 (memberRole, members, revokeKeysForSource), status.ts:3 (members), submit.ts:4 (tenantTimezone), warm-intros.ts:2 (memberRole, userIdForEmail [uses adminDb]); offers/services/offers.ts:7 (tenantSummary), practices.ts:7 (memberRole, userNames); playbooks/services/edit.ts:3 (listApiKeys, members); routing/services/assign.ts:4, lookups.ts:2, pipeline.ts:6, read.ts:5, respond.ts:2 (members, tenantTimezone), sellers.ts:3 (assignableMembers), settings.ts:2 (tenantTimezone), queue.ts:6 (get/set/clearPreference); scoring/services/last-rescore.ts:3, tier.ts:3 (members), score.ts:5 (tenantTimezone).
- HTTP routes using tenancy through ctx.tx / principal: v1/me/route.ts (tenantSummary(ctx), memberRole(ctx), signInFacts(ctx.tx)), members/*, roles/*, api-keys/*, sources/*/keys, audit/route.ts:26, feedback/route.ts:4 (userNames), members/directory/route.ts.
- Access resolution: principal comes from tenancy (adminDb, control plane) in v1Route; platform/access.ts accessWithSources then uses ctx.tx (workspace) for sources.
- Writes that cross the boundary in ONE tx today (need splitting): createTenant (membership + outbox + platform audit, tenants.ts:53-101); addMember/removeMember/changeMember (membership + outbox publish + audit via ctx.tx); createApiKey/revokeApiKey (api_key + publish + audit); completeSignIn (membership activate + per-tenant audit rows, sign-in.ts:191).
- Joins that live ENTIRELY inside tenancy (stay in control plane): principal.ts:55 loadAccess, api-keys.ts:475 api_key JOIN tenant, workspaces.ts:17 tenant JOIN membership, tenants.ts:198-202 adminTenants subselects (membership, user), sign-in.ts membership/tenant subqueries.
- Cross-workspace reads on admin tx: ai-tasks admin-runs (ai.ai_run, all tenants), integrations/services/inbound.ts:11 (connection by id), integrations/jobs.ts:17 (credential cleanup), systemHealth/relayLag (outbox), listDeadJobs, schedule list.
- FKs: no cross-schema foreign keys except tenancy.session/account -> tenancy.user (tenancy migration 0001_better_auth.sql:38-39). Workspace tables store tenant_id and user ids as plain text.

## Gotchas for the split
1. withTenant is also used on control-plane tenancy tables (api-keys.ts:390,:438) and with tenant t_platform (v1-route.ts:288, diagnostics.ts:51, seed/e2e): t_platform has no workspace DB.
2. Scheduler tick, upsertSchedule (from tenant seeders), dead-job retry, createTenant and completeSignIn write outbox/audit/schedule rows for a tenant on the admin (control-plane) tx.
3. Tenancy public API takes workspace ctx.tx and reads tenancy tables on it (about 35 call sites in workspace modules and routes).
4. Relay uses one advisory lock + one LISTEN on one DB (relay.ts:62-109).
5. Test harness = one DB; adminDb used in about 100 test files to read workspace tables and the outbox; runOutbox and the createTenant-then-seed pattern assume one DB.
6. Cross-tenant workspace-data admin paths: ai-runs admin, credentials cleanup job, connectionTenant webhook lookup, delivery_attempt.

## 3. ModuleContext construction (src/platform/context.ts:6-20)
Fields: tenantId, actor, correlationId, causationId?, tx: Tx, environment?, ip?, access?, signal?.
- HTTP tenant routes: v1-route.ts:254 ctx = {tenantId: principal.tenantId, actor, correlationId, tx, environment?, ip?}, then access via accessWithSources(ctx, principal, sourceAccessProvider()) (v1-route.ts:262; platform/access.ts:20, reads intake sources through ctx.tx). tx = withTenant(principal.tenantId) (v1-route.ts:251). Idempotency claimKey/storeResponse (platform/idempotency.ts:81,104) run on that same tx.
- HTTP session routes: v1-route.ts:288-295 handler gets SessionContext {actor, correlationId, tx} (not a ModuleContext). tx = withTenant(t_platform) (sessionRoute) or adminDb.transaction (adminRoute).
- Worker (NATS consumers AND jobs share one path): runtime/worker.ts:252-260 inside runInTx: {tenantId: envelope.tenantId, actor, correlationId, causationId: envelope.id, environment?, tx: guarded.tx, signal}; tx = withTenant(envelope.tenantId) (worker.ts:371; deliverOnce :287) wrapped by guardTx (:247). processed_event insert (:220), lock and statement timeouts, optional advisory lock and the handler all share this tx.
- Scheduler: scheduler.ts:57 enqueueFor: ctx = {tenantId: row.tenantId, actor system/scheduler, correlationId, tx} where tx is the scheduler ADMIN tx or savepoint; only use is enqueueJob (outbox insert). Scheduler outbox writes go to the admin DB today.
- Other: tenancy/services/tenants.ts:90 (createTenant builds ctx on the admin tx; set_config app.tenant_id = new tenant at :80, to insert membership and publish tenantCreated); entry/seed.ts:216 and cli.ts ad hoc ctx inside withTenant; dead-jobs.ts:65 (publish with admin tx); tests: tests/integration/tenancy/helpers.ts:21 inTenant.
- No separate job/consumer wrapper beyond defineJobHandler (runtime/jobs.ts) and defineConsumer (runtime/consumers.ts); ModuleContext reaches them only from the worker.

## 4. Outbox, relay, scheduler, dead jobs, idempotency, processed_event
- Outbox writer: platform/events/outbox.ts:9 publish(ctx, def, data, subject?) inserts into outbox via ctx.tx, kind event (subject eventSubject(tenantId,type)); :40 enqueueJob, kind job. Writes to whatever DB ctx.tx is on. dead-jobs.ts:114,123 insert outbox directly via admin tx. DB trigger notify_outbox does pg_notify scout_outbox (migration 0000:31).
- Relay: relay.ts:42 runRelay; pg advisory lock hashtext(scout_relay) on a dedicated non-pooled connection (relay.ts:62-100, config.databaseAdminUrl), LISTEN scout_outbox on that connection (:109); loop selects unsent rows of platform.outbox ordered by seq limit batch on adminDb (:134), publishes to JetStream with msgID=row.id, then updates sent_at on adminDb (:151). One global outbox; NO tenant iteration. Lock and LISTEN tie to ONE database. relayLagMs (:186) = oldest unsent created_at.
- Scheduler: scheduler.ts:167 schedulerTick: ONE admin tx, due rows (enabled, next_run_at<=now) for update skip locked, per-row savepoint: enqueueJob (outbox) + update schedule. runScheduler (:194) every 15s. No tenant iteration. upsertSchedule/pause/resume/runNow (:67,116,143) are admin-DB operations, also called by tenant seeders (section 5) and seed.ts:203.
- Dead jobs: dead-jobs.ts:43 recordDeadJob (admin tx; dead_job insert + outbox publish of platform.job.dead in same tx), list :81, retry :106, discard :148. All adminDb. Written by worker after retries (worker.ts:424).
- delivery_attempt: worker.ts:318-339 adminDb, outside the handler tx (so failed runs still count).
- processed_event: worker.ts:220 inserts (consumer_name, event_id) on conflict do nothing inside the tenant tx (same DB as the handler). Keyed per consumer+event, no tenant column.
- Idempotency: platform/idempotency.ts:81 claimKey / :104 storeResponse raw SQL on platform.idempotency_key in the request tx; keyed (tenant_id, principal_id, key); RLS forced.
- Audit: platform/audit.ts:67 audit(ctx, entry) inserts via ctx.tx; listAudit :107 reads ctx.tx; platformAudit :75 adminDb for t_platform rows.
- NATS: nats/subjects.ts eventSubject/jobSubject include tenantId in the subject; worker filters by wildcard tenant (worker.ts:165,185).

## 5. Tenant creation and tenancy.tenant.created seeders
- createTenant: modules/tenancy/services/tenants.ts:36. One adminTransaction (:53): checks actor is active platform admin (:54), slug free (:61), inserts tenancy.tenant (:65), user (on conflict do nothing by email, :73), set_config app.tenant_id (:80), owner membership status invited (:82), publish(ctx, tenantCreated) into the outbox on the SAME admin tx (:91), platformAudit tenancy.tenant.created (:92). Returns {tenantId, ownerMembershipId}. Callers: admin/tenants/route.ts:41, cli.ts:263 (tenants:create), seed.ts, 19 test files.
- Event def: modules/tenancy/contracts/events.ts:5 tenancy.tenant.created.
- Consumers (defineConsumer; listed in src/entry/worker.ts:22 consumers[]); each runs in withTenant(new tenant) via the worker:
  - accounts.tenant_defaults -> seedAccountDefaults (accounts/consumers.ts:15; defaults.ts:56): buying roles, exclusion rules, vendor phrases.
  - intake.tenant_defaults -> seedIntakeDefaults (intake/consumers.ts:13; defaults.ts:26): vendor sources, relationship defaults; upsertSchedule x2 (defaults.ts:51,56).
  - scoring.tenant_defaults -> seedScoringDefaults (scoring/consumers.ts:26; defaults.ts:19): default scoring profile; upsertSchedule nightly ageing (defaults.ts:23).
  - routing.tenant_defaults -> seedRoutingDefaults (routing/consumers.ts:12; defaults.ts:102): review statuses, decline reasons, pipeline stages, auto-accept; upsertSchedule hourly (defaults.ts:118).
  - crm.tenant_defaults -> seedCrmDefaults (crm/consumers.ts:15; defaults.ts:35): CRM setting, HubSpot field mapping; upsertSchedule polling (defaults.ts:55).
  - playbooks.tenant_defaults -> seedPlaybooksDefaults (playbooks/consumers.ts:15; defaults.ts:9): sweep schedule (upsertSchedule, defaults.ts:10).
  - Also routing consumes memberRemoved (withdrawForRemovedMember). No tenant_defaults in offers (offers/defaults.ts:200 seedOffers is only called by seed.ts for the taazaa catalogue), integrations (connection rows created lazily, connections.ts:301) or ai-tasks.
- KEY: seeders call upsertSchedule (scheduler.ts:67), which ignores ctx.tx and opens its own adminDb.transaction (+ platformAudit to t_platform). So every seeder, while inside the workspace tx, also writes platform.schedule on the admin DB via a second connection.
- Ordering coupling: createTenant writes the tenantCreated outbox row in the same DB and tx as the membership (control plane today). Under the split the event must land in the new workspace DB outbox after provisioning.

## 6. Test infrastructure
- vitest.config.ts: projects unit (tests/unit) and integration (tests/integration; globalSetup tests/integration/setup.ts; setupFiles close-dbs.ts; pool forks, singleFork; timeout 30s).
- tests/integration/setup.ts:8-26: probes superuser, freshDatabase(scout_test_PID) (:18), sets process.env DATABASE_URL / DATABASE_ADMIN_URL (:19-20), migrateAll({adminUrl}) (:21); teardown drops it. ONE database for the whole run.
- helpers/db.ts: withDatabase(url,name) :9; superuserSql :15 (config.databaseSuperuserUrl); createScratchDatabase :20; dropScratchDatabase :30; freshDatabase :40 (create + bootstrapDatabase(superuser URL for that db); returns {name, adminUrl, appUrl, drop}).
- close-dbs.ts:6 afterAll(closeDbs) per test file (fresh pools per file).
- helpers/run-outbox.ts:32 runOutbox(tenantId): stands in for relay+worker: adminDb select outbox where tenant_id and sent_at null (:37), deliverOnce(consumer or job) from src/entry/worker.ts (:45-46), adminDb update sent_at (:47). 73 test files use it. helpers/publish.ts:12 publishTestEvent = withTenant + publish.
- tenancy/helpers.ts: seedUser :8 (adminDb insert tenancy.user), inTenant(tenantId, actor, fn) :21 (withTenant + builds ModuleContext), uniqueSlug :25.
- Tenants in tests: createTenant(actor, {...}) directly (19 files; v1/session-helpers.ts:27 tenantOwnedBy then adminDb.update(membership) to active); module tests use per-module helpers: intake/helpers.ts freshTenant, routing/helpers.ts:14 routingTenant() = freshTenant + runOutbox (delivers every module tenant_defaults; 40 files use routingTenant, 34 import routing/helpers); also offers/, playbooks/, integrations/ helpers.ts.
- Reference counts in tests/: adminDb 100 files, platform/db/client import 129, withTenant 11, appDb 2, createTenant 19, runOutbox 73. Many tests assert workspace tables via adminDb and delete by tenant_id (crm/one-path.test.ts:145, platform/outbox.test.ts:26 deletes all platform.outbox rows).
- Tests that make their own DBs (freshDatabase/migrateAll): entry/cli.test.ts, platform/migrate.test.ts, routing/pipeline-stages.test.ts, routing/seed-migration.test.ts.
- Platform tests touching relay/worker/NATS/cross-tenant: platform/relay.test.ts, jobs.test.ts, consumers.test.ts (:28 grant on platform.t6_counter), scheduler.test.ts, outbox.test.ts, health.test.ts, system-health.test.ts, rls.test.ts, rls-catalog.test.ts; v1/admin-pool.test.ts, admin-system.test.ts, admin-tenants.test.ts, ai-runs.test.ts.
- e2e: playwright.config.ts: testDir tests/e2e, workers 1, globalSetup tests/e2e/global-setup.ts; webServer 1 runs npx tsx src/entry/cli.ts web (PORT 4240, env e2eEnv), webServer 2 web-ui vite dev on 5273 (SCOUT_BACKEND_URL). tests/e2e/env.ts:31 E2E_DB=scout_e2e; e2eEnv overrides DATABASE_URL / DATABASE_ADMIN_URL to scout_e2e (from env or localhost defaults), AUTH_DEV_SIGNIN, SCOUT_FORCE_MOCK, SCOUT_MASTER_KEY, AUTH_SECRET. global-setup.ts:15 runs prepare-db.ts create (freshDatabase + migrateAll + seed() + seedAiRun via listTenants + withTenant) then startBackground() (background.ts spawns background-main.ts = startWorker + runRelay in one child, READY handshake, purges SCOUT_JOBS ping subject); teardown stops it and runs prepare-db.ts drop. prepare-db.ts dead-job mode calls recordDeadJob with tenant t_platform. e2e needs NATS + one DB; no scheduler process.

## 7. Compose and config
- infra/compose/docker-compose.yml:6-18 x-scout env: DATABASE_URL postgres://scout_app:scout_app@postgres:5432/scout; DATABASE_ADMIN_URL postgres://scout_admin:scout_admin@postgres:5432/scout; DATABASE_SUPERUSER_URL postgres://scout:scout@postgres:5432/scout; NATS_URL; AUTH_DEV_SIGNIN; SCOUT_FORCE_MOCK; APP_PUBLIC_URL; SCOUT_MASTER_KEY (dev only). Services: postgres (postgres:17; POSTGRES_USER/PASSWORD/DB = scout; bootstrap.sql mounted in /docker-entrypoint-initdb.d/10-bootstrap.sql, which only affects the scout DB), nats (nats:2.11-alpine -js), mailpit, migrate (command migrate), web (4240), worker, scheduler, relay (depend on migrate).
- infra/compose/docker-compose.vm.yml: DATABASE_URL (l.16), DATABASE_ADMIN_URL (l.17) with SCOUT_APP_DB_PASSWORD / SCOUT_ADMIN_DB_PASSWORD from /opt/scout/.env; postgres (l.22-30); migrate gets SCOUT_APP_DB_PASSWORD, SCOUT_ADMIN_DB_PASSWORD, DATABASE_SUPERUSER_URL as user scout (l.56-58); backup service nightly pg_dump -Fc 02:00 UTC of PGDATABASE=scout (l.117-128; infra/backup/backup.sh:18; restore-check.sh and ci-check.sh assume one DB, e.g. tenancy.membership at ci-check.sh:19, platform.ci_extra).
- .env.example:6-15,51-55: DATABASE_URL, DATABASE_ADMIN_URL, DATABASE_POOL_MAX (20), DATABASE_SUPERUSER_URL, SCOUT_APP_DB_PASSWORD, SCOUT_ADMIN_DB_PASSWORD.
- src/platform/config.ts: zod env :42-47 SCOUT_APP_DB_PASSWORD, SCOUT_ADMIN_DB_PASSWORD, DATABASE_URL, DATABASE_ADMIN_URL, DATABASE_SUPERUSER_URL (all optional), DATABASE_POOL_MAX (int 2..500, default 20); :104 production requires DATABASE_URL, DATABASE_ADMIN_URL, NATS_URL, AUTH_SECRET, APP_PUBLIC_URL; :125-130 defaults: app postgres://scout_app:scout_app@localhost:5432/scout, admin same DB with scout_admin, superuser postgres://postgres:postgres@localhost:5432/postgres, databasePoolMax. Type fields :10-15. No region registry, admin-URL template or per-workspace pool settings yet.
- runtime/worker.ts:31-35 inFlightCap = floor(databasePoolMax/2): one appDb connection per in-flight message; assumes a single pool.

## 8. CLI commands touching the DB (src/entry/cli.ts)
- migrate (:89): if DATABASE_SUPERUSER_URL set, bootstrapDatabase(); then migrateAll() on DATABASE_ADMIN_URL; prints count.
- seed (:191 -> seed.ts:122): refuses production; ensurePlatformAdmin, createTenant x2, completeSignIn, per tenant withTenant (addMember, seedAccountDefaults, seedOffers (taazaa), seedIntakeDefaults, backfillR1b/R1c/ReviewFlow, seedPlaybooksDefaults, backfillBriefs, person and agent sources, seedMockCrm), renameHandleUsers, upsertSchedule integrations.credentials.cleanup under t_platform (seed.ts:203), dev API key via createApiKey in withTenant(taazaa) (seed.ts:215).
- import SLUG FILE (:105): listTenants (control plane), ensurePlatformAdmin, withTenant -> personSourceFor/registerSource/createImport.
- backfill-r1b, backfill-r1c, backfill-review-flow SLUG (:134): listTenants lookup, ensurePlatformAdmin(system@scout.local), withTenant -> backfill (seed.ts:96-120: seedScoringDefaults/seedRoutingDefaults/seedMissingSignalRules/backfillReviews/requestRescore; seedCrmDefaults/seedIntakeDefaults/backfillCrm; backfillLeadOffers).
- rescore [--tenant SLUG] (:152): listTenants, per active tenant withTenant -> requestRescore(rules_changed), sequential (existing per-workspace loop).
- keys:create (:229 -> api-keys.ts:376 createKeyFromCli): control-plane tenant lookup + withTenant -> createApiKey (api_key is a tenancy table).
- tenants:create (:249): ensurePlatformAdmin(system@scout.local) + createTenant.
- web, worker, scheduler, relay, all-background (:174-187): runRoles / startServer. cli.ts:285 closeDbs on exit. seed.ts:75 backfillDisplayNames loops listTenants + withTenant(renamePersonSources with people from the control plane).
- entry/worker.ts:22,25 hold consumers[] and jobs[]; entry/registry.ts imports all event/job defs; entry/relay.ts and entry/scheduler.ts are thin mains.

(Note: sections appear in file order 1, 2, 9, 3, 4, 5, 6, 7, 8.)
