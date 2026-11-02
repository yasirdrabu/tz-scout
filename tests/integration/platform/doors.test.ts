import '@/entry/compose';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTenant } from '@/modules/tenancy';
import { workspaceInfra } from '@/modules/tenancy/db/schema';
import { PLATFORM_TENANT } from '@/platform/audit';
import { adminDb, controlAdminDb, controlDb } from '@/platform/db/client';
import { isControlTx, listWorkspaceDatabases, withWorkspaceAdmin, workspaceDb } from '@/platform/db/doors';
import { withTenant } from '@/platform/db/tenant';
import { seedUser, uniqueSlug } from '../tenancy/helpers';

const dbName = async (db: { execute: typeof controlDb.execute }) =>
  ((await db.execute<{ db: string }>(sql`select current_database() as db`))[0]!).db;

describe('doors in shared mode (D35)', () => {
  it('resolves every workspace to the same pools, on the control plane database', async () => {
    const a = await workspaceDb('t_door_a');
    const b = await workspaceDb('t_door_b');
    expect(a).toBe(b);
    expect(await dbName(a.app)).toBe(await dbName(controlDb));
    expect(await dbName(a.admin)).toBe(await dbName(controlAdminDb));
    expect(await listWorkspaceDatabases()).toEqual([{ tenantId: '*', admin: a.admin }]);
  });

  it('sends t_platform to the control plane and every other tenant to its workspace', async () => {
    expect(await workspaceDb(PLATFORM_TENANT)).toEqual({ app: controlDb, admin: controlAdminDb });
    expect(await withTenant(PLATFORM_TENANT, async (tx) => isControlTx(tx))).toBe(true);
    expect(await withTenant('t_door_a', async (tx) => isControlTx(tx))).toBe(false);
  });

  it('withTenant still sets the tenant for row level security', async () => {
    const [row] = await withTenant('t_door_a', (tx) =>
      tx.execute<{ t: string }>(sql`select current_setting('app.tenant_id', true) as t`),
    );
    expect(row!.t).toBe('t_door_a');
  });
});

describe('the workspace registry (tenancy.workspace_infra)', () => {
  it('a new tenant gets an active row in us-1 on this database', async () => {
    const admin = await seedUser({ admin: true });
    const { tenantId } = await createTenant(admin.actor, {
      slug: uniqueSlug(),
      name: 'Registry',
      currency: 'USD',
      timezone: 'UTC',
      ownerEmail: `${uniqueSlug()}@example.com`,
    });
    const [row] = await adminDb.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId));
    expect(row).toMatchObject({ region: 'us-1', database: await dbName(adminDb), status: 'active', test: false });
    expect(await withTenant(tenantId, async () => 'in')).toBe('in');
  });

  it('refuses a workspace that is not active with 503 workspace-unavailable', async () => {
    const admin = await seedUser({ admin: true });
    const { tenantId } = await createTenant(admin.actor, {
      slug: uniqueSlug(),
      name: 'Provisioning',
      currency: 'USD',
      timezone: 'UTC',
      ownerEmail: `${uniqueSlug()}@example.com`,
    });
    await adminDb.update(workspaceInfra).set({ status: 'provisioning' }).where(eq(workspaceInfra.tenantId, tenantId));
    const refused = { slug: 'workspace-unavailable', status: 503 };
    await expect(withTenant(tenantId, async () => 'in')).rejects.toMatchObject(refused);
    await expect(withWorkspaceAdmin(tenantId, async () => 'in')).rejects.toMatchObject(refused);
  });
});
