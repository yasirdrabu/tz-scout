import { dropAfter } from '../helpers/per-workspace';
import '@/entry/compose';
import { consumers } from '@/entry/worker';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { GET as buyingRoles } from '@/http/routes/v1/buying-roles/route';
import { GET as stages } from '@/http/routes/v1/stages/route';
import { createTenant, splitWorkspace, workspaceDatabaseName } from '@/modules/tenancy';
import { tenant, workspaceInfra } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { databaseExists } from '@/platform/db/migrate';
import { schedule } from '@/platform/db/schema';
import { schedulerTick } from '@/platform/scheduler';
import { countTenantRows, type TableCount } from '@/platform/db/move';
import { withTenant } from '@/platform/db/tenant';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import type { Envelope } from '@/platform/events/envelope';
import { publish } from '@/platform/events/outbox';
import { defineEvent } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { deliverOnce } from '@/platform/runtime/worker';
import { z } from 'zod';
import { seedUser, uniqueSlug } from '../tenancy/helpers';
import { signedIn, v1Req } from '../v1/session-helpers';

// D35 Task 6, in per_workspace mode: a workspace made in the shared database (before the split) is
// moved into its own, and the shared database keeps none of its rows.

const shared = decodeURIComponent(new URL(config.databaseAdminUrl).pathname.slice(1));
const sharedUrl = urlForDatabase(config.databaseAdminUrl, shared);
const probe = defineEvent('platform.split_probe.moved', 1, z.object({ n: z.number() }));

const infra = async (tenantId: string) => (await adminDb.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId)))[0]!;
const nonEmpty = (counts: TableCount[]) => Object.fromEntries(counts.filter((c) => c.rows > 0).map((c) => [c.table, c.rows]));

/** A workspace as it was before D35: its rows in the shared database, seeded, with some activity. */
async function sharedWorkspace() {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, { slug: uniqueSlug(), name: 'Shared era', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  dropAfter(workspaceDatabaseName(t.tenantId));
  await adminDb.update(workspaceInfra).set({ database: shared, status: 'active' }).where(eq(workspaceInfra.tenantId, t.tenantId));
  const [created] = (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'tenancy.tenant.created'`,
  )) as unknown as { payload: Envelope }[];
  for (const c of consumers) if (c.event.type === 'tenancy.tenant.created') await deliverOnce(c, created!.payload);
  await withTenant(t.tenantId, async (tx) => {
    for (let n = 0; n < 3; n++) await publish({ tenantId: t.tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, probe, { n });
  });
  const [slug] = await adminDb.select({ slug: tenant.slug }).from(tenant).where(eq(tenant.id, t.tenantId));
  return { ...t, slug: slug!.slug, owner };
}

describe('tenant split (D35 "Moving existing workspaces")', () => {
  it('moves every row into the workspace database, every read answers the same, the shared database keeps none', async () => {
    const t = await sharedWorkspace();
    const neighbour = await sharedWorkspace();
    const cookies = await signedIn(t.owner.id);
    const read = async () =>
      Promise.all(
        [buyingRoles(v1Req('/buying-roles', { cookies, tenant: t.slug })), stages(v1Req('/stages', { cookies, tenant: t.slug }))].map(async (r) => {
          const res = await r;
          expect(res.status).toBe(200);
          return res.json();
        }),
      );
    const before = await read();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    expect(Object.keys(counts)).toEqual(expect.arrayContaining(['platform.outbox', 'platform.processed_event', 'platform.schedule', 'routing.review_status_def']));
    const neighbourBefore = nonEmpty(await countTenantRows(sharedUrl, neighbour.tenantId));

    const r = await splitWorkspace(t.tenantId, { settleMs: 0 });
    expect(r).toMatchObject({ outcome: 'moved', database: workspaceDatabaseName(t.tenantId) });
    expect(await infra(t.tenantId)).toMatchObject({ status: 'active', database: workspaceDatabaseName(t.tenantId) });
    // Every table copied whole, checked against the target as it went.
    expect(nonEmpty(r.outcome === 'moved' ? r.copied : [])).toEqual(counts);
    expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual({});
    expect(nonEmpty(await countTenantRows(sharedUrl, neighbour.tenantId))).toEqual(neighbourBefore);
    expect(await read()).toEqual(before);
    // Tenancy's own events stay in the control plane's outbox.
    const [kept] = await adminDb.execute<{ n: number }>(
      sql`select count(*)::int as n from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'tenancy.tenant.created'`,
    );
    expect(kept!.n).toBe(1);
    // The sequence goes on after the copied rows: a new event is written fine.
    await withTenant(t.tenantId, (tx) => publish({ tenantId: t.tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, probe, { n: 9 }));
    // Again: nothing left to do.
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'cleaned', deleted: expect.any(Array) });
  });

  it('while it moves its requests get 503 with Retry-After', async () => {
    const t = await sharedWorkspace();
    const cookies = await signedIn(t.owner.id);
    await adminDb.update(workspaceInfra).set({ status: 'moving' }).where(eq(workspaceInfra.tenantId, t.tenantId));
    const res = await buyingRoles(v1Req('/buying-roles', { cookies, tenant: t.slug }));
    // The row may be cached as active for this instance; a split waits that out (settleMs). Here: forget it.
    if (res.status === 200) {
      const { forgetWorkspace } = await import('@/platform/db/doors');
      forgetWorkspace(t.tenantId);
    }
    const refused = await buyingRoles(v1Req('/buying-roles', { cookies, tenant: t.slug }));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('30');
    // Its schedules wait too: nothing is enqueued for it while it moves, so its rows hold still.
    await adminDb.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.tenantId, t.tenantId));
    const jobs = async () =>
      ((await adminDb.execute<{ n: number }>(sql`select count(*)::int as n from platform.outbox where tenant_id = ${t.tenantId} and kind = 'job'`))[0]!).n;
    const queued = await jobs();
    await schedulerTick(new Date());
    expect(await jobs()).toBe(queued);
    await adminDb.update(workspaceInfra).set({ status: 'active' }).where(eq(workspaceInfra.tenantId, t.tenantId));
  });

  it('refuses rows it cannot attribute, and leaves the workspace where it was, untouched', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    await adminDb.execute(sql`create table intake.zz_split_no_tenant (x int)`);
    try {
      await expect(splitWorkspace(t.tenantId, { settleMs: 0 })).rejects.toThrow('intake.zz_split_no_tenant');
    } finally {
      await adminDb.execute(sql`drop table intake.zz_split_no_tenant`);
    }
    expect(await infra(t.tenantId)).toMatchObject({ status: 'active', database: shared });
    expect(await databaseExists(workspaceDatabaseName(t.tenantId))).toBe(false);
    expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual(counts);
    expect(await withTenant(t.tenantId, async () => 'open')).toBe('open');
    // Then it moves.
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'moved' });
    expect(await infra(t.tenantId)).toMatchObject({ database: workspaceDatabaseName(t.tenantId) });
    const left = await adminDb.select().from(workspaceInfra).where(and(eq(workspaceInfra.tenantId, t.tenantId), eq(workspaceInfra.database, shared)));
    expect(left).toEqual([]);
  });
});
