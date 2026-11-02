# Per-workspace infrastructure (decision D35, web-ui Decision 23)

Status: proposed 2026-11-01. Replaces "one database with row level security" (data-conventions.md,
module-boundaries.md) for workspace data. Platform release; the Tenants screen sections it unlocks are
hidden until it lands.

## Why

Customers (and Taazaa's own practices) want their data apart: their own database, their own key, their
own backups, an export they can take away, and a delete that really deletes. RLS keeps rows apart in
one database; it can't give a per-workspace backup, restore, export, key or delete.

## Decisions (the user, 2026-11-01)

1. **Own database per workspace on a shared Postgres server.** A control-plane database keeps users,
   sign-in and the workspace list. RLS stays inside each workspace database as a second guard.
2. **One region now**, with a region field per workspace, so a second region is another Postgres
   server and bucket picked at provisioning.
3. **Envelope encryption per workspace**: each workspace has its own data key, wrapped by a master key
   in a KMS (Azure Key Vault in the cloud, a local key file in development). Deleting a workspace
   destroys its key.

## Shape

```
                   ┌──────────────────────────── Postgres server (region us-1) ───────────────┐
 web / worker ──►  │ scout            control plane: platform.*, tenancy.*                    │
   │               │ scout_t_<id>     workspace: integrations, ai, offers, accounts, crm,     │
   │               │ scout_t_<id2>      intake, scoring, routing, playbooks, platform.outbox…  │
   │               └──────────────────────────────────────────────────────────────────────────┘
   └──► object storage (region us-1): tenants/<id>/backups, tenants/<id>/exports, tenants/<id>/files
   └──► KMS: master key versions (wrap and unwrap only)
```

### Control plane (database `scout`)

- `tenancy` stays here whole: users, accounts, sessions, platform admins, tenants, memberships, role
  permissions, member preferences, API keys. Sign-in, `/me` and the workspace switcher need nothing
  from a workspace database.
- New `tenancy.workspace_infra` (one row per tenant): `region`, `database` (name), `status`
  (`provisioning`, `active`, `suspended`, `exporting`, `deleting`, `deleted`, `failed`),
  `schema_versions` (jsonb per module), `data_key_wrapped`, `data_key_version`, `master_key_version`,
  `seats`, `quotas` (jsonb), `test` (bool), `last_backup_at`, `support_access_until`,
  `support_access_by`.
- `platform` tables that span tenants stay here: `schedule` (platform jobs), `ping_result`, dead jobs
  for platform jobs, and the platform audit log.
- `region` registry in config: region → Postgres admin URL, app URL template, bucket, KMS key id.

### Workspace database (`scout_t_<tenant id>`)

- Every module schema except `tenancy` (above), plus the tenant-scoped `platform` tables: `outbox`,
  `processed_event`, `idempotency_key`, `dead_job` (workspace jobs), `delivery_attempt`, workspace
  `schedule` rows and the workspace audit log.
- The same roles (`scout_app` subject to RLS, `scout_admin`) and the same RLS policies, so a bug that
  sends a query to the wrong database still sees nothing (`app.tenant_id` mismatch).
- Files stay in the workspace database (intake keeps import files as `bytea` today), so they are
  inside its backups and export with no extra storage. Moving large files to
  `tenants/<id>/files` is a later change if size needs it.

### Connections

- `withTenant(tenantId, fn)` is already the single door for tenant work. It resolves the workspace's
  pool from `workspace_infra` (cached, 60 s) and runs `fn` there, still setting `app.tenant_id`.
- Pools are created lazily per workspace with a small `max` (default 3) and closed after 10 minutes
  idle, with a global cap (default 60 connections per process); over the cap the least recently used
  pool closes first.
- `adminDb` keeps meaning the control plane. Cross-tenant jobs (relay, scheduler, nightly ageing,
  admin AI runs) loop over active workspaces and open each one's admin pool in turn.
- A workspace not `active` (or `suspended` for writes) refuses requests the way a suspended tenant
  does today.

### Events and jobs

- Each workspace database has its own outbox. The relay polls active workspaces round-robin (one
  batch each per turn) and publishes to the same NATS subjects, which already carry `tenantId`.
- Consumers resolve the database from `tenantId` through `withTenant`. `processed_event` moves with the
  workspace, so idempotency stays per workspace.

### Migrations

- `scout migrate` migrates the control plane, then every workspace database (in parallel, 4 at a
  time), recording each module's version in `workspace_infra.schema_versions`. A workspace that fails
  is marked `failed` with the error and the others continue; the command exits non-zero.
- `scout migrate --tenant <slug>` for one workspace. The Tenants screen shows each workspace's version
  and "Behind" when it trails the code.

### Provisioning (create)

`POST /api/v1/admin/tenants` stays, but creation becomes a job: insert tenant and `workspace_infra`
(`provisioning`) → create the database and grant roles → run migrations → generate and wrap a data
key → seed defaults (the `tenancy.tenant.created` consumers run against the new database) → `active`.
Each step is idempotent so a retry resumes. A failure leaves `failed` with the step and error and a
`Retry` admin action.

### Keys

- Data key: 32 random bytes per workspace, AES-256-GCM, wrapped by the KMS master key (the wrap is
  bound to the master key version and the tenant id as AAD). Unwrapped keys live in memory only, for
  at most 10 minutes.
- Uses: integration credentials (integrations already seals each secret with a wrapped data key; the
  wrapping key becomes the workspace data key instead of the global key), backups and exports
  (encrypted before upload).
- Rotate (admin action): new data key version; re-seal integration secrets in one transaction; new
  backups use the new key; old backups keep their key version until they expire.
- The KMS adapter has two implementations behind one port: Azure Key Vault (`wrapKey`/`unwrapKey`) and
  a local file key for laptops and tests.

### Backups and restore

- Nightly `pg_dump -Fc` of each workspace database, encrypted with its data key, to
  `tenants/<id>/backups/<date>.dump.enc`, kept 35 days. `last_backup_at` and size on the Tenants screen.
- The server runs WAL archiving for whole-server point-in-time recovery (disaster recovery, a runbook,
  not a button).
- **Restore a workspace** (admin action): to a chosen nightly backup, into a new database
  `scout_t_<id>_r<n>`, migrated to the current version; the admin then switches the workspace to it
  (the old one is kept 7 days). Point-in-time restore of a single workspace between nightly backups
  is not offered in this version.

### Export and delete

- **Export** (owner or platform admin): a job dumps the workspace database to an encrypted file in
  `tenants/<id>/exports/`, with a signed download link valid 24 hours. Owners get the decryption
  passphrase shown once.
- **Delete** (platform admin, typed confirmation): status `deleting` for 30 days (sign-in refused,
  undo possible), then drop the database, delete `tenants/<id>/`, destroy the wrapped data key (backups
  become unreadable), keep a tombstone row and the control-plane audit entries.

### Seats, quotas, test flag

- `seats`: active plus invited members; inviting past it is refused ("This workspace has {n} seats.
  Ask Taazaa for more.").
- `quotas`: `accounts` (max live accounts; arrivals past it wait with "Account limit reached"),
  `ai_spend_cents_month` (the AI cap reads it). Empty means no limit.
- `test`: excluded from platform metrics and billing; shown as a chip.

### Support access

Platform admins no longer have standing access to workspace data. An owner grants "Taazaa support"
access for 24 hours (Settings > Members), recorded in `workspace_infra.support_access_until` and the
audit log; a platform admin acts in the workspace only while it is open. Infrastructure actions
(suspend, migrate, backup, restore, rotate, delete) need no grant; they don't read workspace data.

## Moving existing workspaces

`scout tenant split <slug>` (one workspace at a time, during a short write pause for it): provision
its database, copy every row with its `tenant_id` from the shared database module by module in
dependency order (`COPY ... WHERE tenant_id = ...`), verify row counts, switch `workspace_infra` to it,
then delete its rows from the shared database. The shared database becomes the control plane once no
workspace rows remain.

## Delivery (one plan each, in order)

1. **Split:** control plane and workspace databases, `workspace_infra`, connection routing, per-tenant
   migrate, outbox and relay per workspace, provisioning job, `tenant split`.
2. **Keys:** KMS port (Key Vault, local), data keys, integration secrets re-sealed, rotate.
3. **Backups, restore, export, delete.**
4. **Seats, quotas, test flag, support access**, and the Tenants screen sections (§22) that show them.

## What doesn't change

Module boundaries, the API, events and their subjects, and RLS policies inside each database.
