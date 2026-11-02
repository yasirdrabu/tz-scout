import { TEST_TEMPLATE, dropAfter } from '../helpers/per-workspace';
import '@/entry/compose';
import { consumers } from '@/entry/worker';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { reviewStatusDef } from '@/modules/routing/db/schema';
import { createTenant, migrateWorkspaces, provisionWorkspace, retryProvisioning, workspaceDatabaseName } from '@/modules/tenancy';
import { workspaceInfra } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { openWorkspacePools, platformDatabases, withWorkspaceAdmin } from '@/platform/db/doors';
import { codeSchemaVersions, createDatabase, databaseExists, migrateWorkspaceDatabase, WORKSPACE_MODULES } from '@/platform/db/migrate';
import { deadJob } from '@/platform/db/schema';
import { withTenant } from '@/platform/db/tenant';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { listDeadJobs } from '@/platform/dead-jobs';
import type { Envelope } from '@/platform/events/envelope';
import { publish } from '@/platform/events/outbox';
import { defineEvent } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { outboxSource, relayTurn, type OutboxRow } from '@/platform/relay';
import { deliverOnce } from '@/platform/runtime/worker';
import { z } from 'zod';
import { seedUser, uniqueSlug } from '../tenancy/helpers';

// D35 Phase B: SCOUT_WORKSPACE_DATABASES=per_workspace for this file (helpers/per-workspace.ts).

async function newTenant() {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, { slug: uniqueSlug(), name: 'Own DB', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  dropAfter(workspaceDatabaseName(t.tenantId));
  return { ...t, admin, owner };
}

const infra = async (tenantId: string) => (await adminDb.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId)))[0]!;

async function activeTenant() {
  const t = await newTenant();
  expect(await provisionWorkspace(t.tenantId)).toBe('active');
  return t;
}

/** Runs `statements` as scout_admin in workspace database `database`. */
async function inDatabase(database: string, statements: string) {
  const sqlc = postgres(urlForDatabase(config.databaseAdminUrl, database), { max: 1, onnotice: () => {} });
  try {
    await sqlc.unsafe(statements);
  } finally {
    await sqlc.end();
  }
}

describe('a database per workspace (D35)', () => {
  it('a new tenant is provisioning until its database is made, migrated and seeded, then active', async () => {
    const t = await newTenant();
    expect(t.status).toBe('provisioning');
    const before = await infra(t.tenantId);
    expect(before).toMatchObject({ status: 'provisioning', database: workspaceDatabaseName(t.tenantId), region: 'us-1' });
    const job = await adminDb.execute(
      sql`select 1 from platform.outbox where tenant_id = 't_platform' and payload->>'type' = 'jobs.tenancy.workspace_provision' and payload->'data'->>'tenantId' = ${t.tenantId}`,
    );
    expect(job).toHaveLength(1);
    await expect(withTenant(t.tenantId, async () => 1)).rejects.toMatchObject({ slug: 'workspace-unavailable', status: 503 });

    expect(await provisionWorkspace(t.tenantId)).toBe('active');
    expect(await databaseExists(before.database)).toBe(true);
    const after = await infra(t.tenantId);
    expect(after).toMatchObject({ status: 'active', failedStep: null, schemaVersions: codeSchemaVersions(WORKSPACE_MODULES) });
    // Opened at once: provisioning dropped the cached "provisioning" row.
    const statuses = await withTenant(t.tenantId, (tx) => tx.select().from(reviewStatusDef));
    expect(statuses.length).toBeGreaterThan(0);
    const [where] = await withWorkspaceAdmin(t.tenantId, (tx) =>
      tx.execute<{ db: string; membership: string | null }>(sql`select current_database() as db, to_regclass('tenan' || 'cy.membership')::text as membership`),
    );
    expect(where).toEqual({ db: before.database, membership: null });
    // The tenant.created consumers ran here; their later NATS delivery is a duplicate.
    const [created] = (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'tenancy.tenant.created'`,
    )) as unknown as { payload: Envelope }[];
    const seeders = consumers.filter((c) => c.event.type === 'tenancy.tenant.created');
    expect(seeders.length).toBeGreaterThan(0);
    for (const c of seeders) expect(await deliverOnce(c, created!.payload)).toBe('duplicate');
    expect(await provisionWorkspace(t.tenantId)).toBe('skipped');
  });

  it('copies a new workspace from the template database when there is one', async () => {
    await createDatabase(TEST_TEMPLATE);
    await migrateWorkspaceDatabase(urlForDatabase(config.databaseAdminUrl, TEST_TEMPLATE));
    const t = await activeTenant();
    expect((await infra(t.tenantId)).schemaVersions).toEqual(codeSchemaVersions(WORKSPACE_MODULES));
    expect((await withTenant(t.tenantId, (tx) => tx.select().from(reviewStatusDef))).length).toBeGreaterThan(0);
  });

  it('a failure part way marks the workspace failed with the step; a retry resumes and opens it at once', async () => {
    const t = await newTenant();
    const database = workspaceDatabaseName(t.tenantId);
    // A database that is there but cannot be migrated: provisioning gets past "database", stops at "migrate".
    await createDatabase(database);
    await inDatabase(database, 'create schema platform; create table platform.outbox (x int)');
    expect(await provisionWorkspace(t.tenantId)).toBe('failed');
    expect(await infra(t.tenantId)).toMatchObject({ status: 'failed', failedStep: 'migrate', failedError: expect.stringContaining('already exists') });
    await expect(withTenant(t.tenantId, async () => 1)).rejects.toMatchObject({ slug: 'workspace-unavailable' });
    expect(await provisionWorkspace(t.tenantId)).toBe('skipped'); // a failed one waits for an admin

    const by = { actor: t.admin.actor, correlationId: newId('cor') };
    await retryProvisioning(by, t.tenantId);
    expect((await infra(t.tenantId)).status).toBe('provisioning');
    await expect(retryProvisioning(by, t.tenantId)).rejects.toMatchObject({ slug: 'not-failed', status: 409 });
    const jobs = await adminDb.execute(
      sql`select 1 from platform.outbox where payload->>'type' = 'jobs.tenancy.workspace_provision' and payload->'data'->>'tenantId' = ${t.tenantId}`,
    );
    expect(jobs).toHaveLength(2);

    await inDatabase(database, 'drop table platform.outbox');
    expect(await provisionWorkspace(t.tenantId)).toBe('active');
    // The 503 above cached the row as not open; the status change dropped it (forgetWorkspace), so no 60 s wait.
    expect(await withTenant(t.tenantId, async () => 'open')).toBe('open');
  });

  it("two workspaces cannot see each other's rows, even as scout_admin with row level security off", async () => {
    const a = await activeTenant();
    const b = await activeTenant();
    const seen = await withWorkspaceAdmin(a.tenantId, (tx) => tx.selectDistinct({ tenantId: reviewStatusDef.tenantId }).from(reviewStatusDef));
    expect(seen).toEqual([{ tenantId: a.tenantId }]);
    const inB = await withWorkspaceAdmin(b.tenantId, (tx) => tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, a.tenantId)));
    expect(inB).toEqual([]);
    expect(openWorkspacePools()).toEqual(expect.arrayContaining([workspaceDatabaseName(a.tenantId), workspaceDatabaseName(b.tenantId)]));
  });

  it('the relay reads each workspace outbox; dead jobs are kept and listed per database', async () => {
    const a = await activeTenant();
    const b = await activeTenant();
    const probe = defineEvent('platform.split_probe.relayed', 1, z.object({}));
    const sent = await withTenant(a.tenantId, (tx) => publish({ tenantId: a.tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, probe, {}));
    const databases = await platformDatabases();
    expect(databases.map((d) => d.name)).toEqual(expect.arrayContaining(['control', workspaceDatabaseName(a.tenantId), workspaceDatabaseName(b.tenantId)]));
    const published: OutboxRow[] = [];
    await relayTurn(databases.map(outboxSource), new Map(), async (row) => void published.push(row), { batchSize: 1000 });
    expect(published.map((r) => r.id)).toContain(sent.id);

    const deadIn = async (tenantId: string) => {
      const id = newId('dead');
      await withWorkspaceAdmin(tenantId, (tx) =>
        tx.insert(deadJob).values({ id, tenantId, consumerOrJob: 'test.consumer', envelope: { id }, lastError: 'boom', attempts: 3 }),
      );
      return id;
    };
    const ids = [await deadIn(a.tenantId), await deadIn(b.tenantId)];
    expect((await listDeadJobs()).map((d) => d.id)).toEqual(expect.arrayContaining(ids));
    const inA = await withWorkspaceAdmin(a.tenantId, (tx) => tx.select().from(deadJob).where(and(eq(deadJob.tenantId, b.tenantId))));
    expect(inA).toEqual([]);
  });

  it('scout migrate migrates each workspace database, records its versions, and marks one that fails', async () => {
    const t = await activeTenant();
    const database = workspaceDatabaseName(t.tenantId);
    expect(await migrateWorkspaces({ tenantId: t.tenantId })).toEqual([{ tenantId: t.tenantId, database, applied: 0 }]);
    // Forget the platform migrations: they run again and find their tables there.
    await inDatabase(database, 'drop table platform.__migrations');
    const [failed] = await migrateWorkspaces({ tenantId: t.tenantId });
    expect(failed).toMatchObject({ tenantId: t.tenantId, error: expect.stringContaining('already exists') });
    expect(await infra(t.tenantId)).toMatchObject({ status: 'failed', failedStep: 'migrate' });
    await expect(withTenant(t.tenantId, async () => 1)).rejects.toMatchObject({ slug: 'workspace-unavailable' });
    // Put right, the next migrate brings it back.
    await inDatabase(database, 'drop schema platform cascade');
    const [again] = await migrateWorkspaces({ tenantId: t.tenantId });
    expect(again).toMatchObject({ tenantId: t.tenantId, applied: codeSchemaVersions(['platform']).platform });
    expect(await infra(t.tenantId)).toMatchObject({ status: 'active', failedStep: null, schemaVersions: codeSchemaVersions(WORKSPACE_MODULES) });
    expect(await withTenant(t.tenantId, async () => 'open')).toBe('open');
  });
});
