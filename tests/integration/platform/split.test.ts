import { dropAfter } from '../helpers/per-workspace';
import '@/entry/compose';
import { consumers } from '@/entry/worker';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '@/entry/cli';
import { GET as buyingRoles } from '@/http/routes/v1/buying-roles/route';
import { GET as stages } from '@/http/routes/v1/stages/route';
import { createTenant, provisionWorkspace, splitWorkspace, workspaceDatabaseName, workspaceInfo, workspaceList } from '@/modules/tenancy';
import postgres from 'postgres';
import { tenant, workspaceInfra } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { forgetWorkspace, registerWorkspaceLookup, withWorkspaceAdmin } from '@/platform/db/doors';
import { discardDeadJob, retryDeadJob } from '@/platform/dead-jobs';
import { createDatabase, databaseExists, migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { deadJob, schedule } from '@/platform/db/schema';
import { pauseSchedule, runNow, schedulerTick } from '@/platform/scheduler';
import { copyTenantRows, countTenantRows, deleteTenantRows, type TableCount } from '@/platform/db/move';
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

// An install from before D35: the shared database (the control plane's) holds every module's tables.
beforeAll(() => migrateWorkspaceDatabase(sharedUrl));

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
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('already in its own database') });
  });

  it('while it moves its requests get 503 with Retry-After', async () => {
    const t = await sharedWorkspace();
    const cookies = await signedIn(t.owner.id);
    await adminDb.update(workspaceInfra).set({ status: 'moving' }).where(eq(workspaceInfra.tenantId, t.tenantId));
    const res = await buyingRoles(v1Req('/buying-roles', { cookies, tenant: t.slug }));
    // The row may be cached as active for this instance; a split waits that out (settleMs). Here: forget it.
    if (res.status === 200) {
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

describe('a split that stopped part way is finished by running it again', () => {
  const own = (tenantId: string) => workspaceDatabaseName(tenantId);
  const ownUrl = (tenantId: string) => urlForDatabase(config.databaseAdminUrl, own(tenantId));
  const setRow = async (tenantId: string, set: Partial<typeof workspaceInfra.$inferInsert>) => {
    await adminDb.update(workspaceInfra).set(set).where(eq(workspaceInfra.tenantId, tenantId));
    forgetWorkspace(tenantId);
  };
  /** The workspace database made and fully copied into, as a crashed split could have left it. */
  const copiedAlready = async (tenantId: string) => {
    await createDatabase(own(tenantId));
    await migrateWorkspaceDatabase(ownUrl(tenantId));
    await copyTenantRows(sharedUrl, ownUrl(tenantId), tenantId);
  };
  const movedCleanly = async (tenantId: string, counts: Record<string, number>) => {
    expect(await infra(tenantId)).toMatchObject({ status: 'active', database: own(tenantId) });
    expect(nonEmpty(await countTenantRows(sharedUrl, tenantId))).toEqual({});
    expect((await withTenant(tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from routing.review_status_def`)))[0]!.n).toBe(
      counts['routing.review_status_def'],
    );
  };

  it('stopped once it was moving, before its database was made', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    await setRow(t.tenantId, { status: 'moving' });
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'moved' });
    await movedCleanly(t.tenantId, counts);
  });

  it('stopped during or after the copy, before the switch: the copy is dropped and made again, not doubled', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    await setRow(t.tenantId, { status: 'moving' });
    await copiedAlready(t.tenantId);
    const r = await splitWorkspace(t.tenantId, { settleMs: 0 });
    expect(r).toMatchObject({ outcome: 'moved' });
    expect(nonEmpty(r.outcome === 'moved' ? r.copied : [])).toEqual(counts);
    await movedCleanly(t.tenantId, counts);
  });

  it('stopped after the switch, part way through deleting from the shared database', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    await setRow(t.tenantId, { status: 'moving' });
    await copiedAlready(t.tenantId);
    await setRow(t.tenantId, { status: 'active', database: own(t.tenantId) });
    // Part of the delete happened: the outbox's per-event rows and one table.
    await adminDb.execute(sql`delete from routing.review_status_def where tenant_id = ${t.tenantId}`);
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'cleaned' });
    await movedCleanly(t.tenantId, counts);
  });

  it('deletes from the shared database in batches, each statement on its own', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    await setRow(t.tenantId, { status: 'moving' });
    await copiedAlready(t.tenantId);
    await setRow(t.tenantId, { status: 'active', database: own(t.tenantId) });
    const deleted = nonEmpty(await deleteTenantRows(sharedUrl, t.tenantId, 2));
    expect(deleted).toEqual(counts);
    expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual({});
  });

  it('scout tenant split prints what it did, and fails for an unknown workspace', async () => {
    const t = await sharedWorkspace();
    const lines: string[] = [];
    const out = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    try {
      expect(await run(['tenant', 'split', t.slug, '--settle-seconds', '0'])).toBe(0);
      expect(await run(['tenant', 'split', t.slug, '--settle-seconds', '0'])).toBe(0);
    } finally {
      out.mockRestore();
    }
    expect(lines[0]).toMatch(new RegExp(`^Workspace ${t.slug}: moved to ${own(t.tenantId)}, \\d+ rows in \\d+ tables\\.$`));
    expect(lines[1]).toBe(`Workspace ${t.slug}: left as it is, it is already in its own database (${own(t.tenantId)}).`);
    await expect(run(['tenant', 'split', 'no-such-workspace', '--settle-seconds', '0'])).rejects.toThrow('No workspace with the slug "no-such-workspace"');
    await expect(run(['tenant', 'split'])).rejects.toThrow('Name a workspace or pass --all.');
  });
});

describe('tenant split: no write is lost (Task 6 review)', () => {
  const ownUrl = (tenantId: string) => urlForDatabase(config.databaseAdminUrl, workspaceDatabaseName(tenantId));
  const setRow = async (tenantId: string, set: Partial<typeof workspaceInfra.$inferInsert>) => {
    await adminDb.update(workspaceInfra).set(set).where(eq(workspaceInfra.tenantId, tenantId));
    forgetWorkspace(tenantId);
  };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('waits for a transaction already running in the shared database, and its writes arrive in the new one', async () => {
    const t = await sharedWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let written = '';
    // Began before the split: it holds the move lock shared until it commits.
    const work = withTenant(t.tenantId, async (tx) => {
      written = (await publish({ tenantId: t.tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, probe, { n: 42 })).id;
      await gate;
    });
    await tick(100);
    let finished = false;
    const split = splitWorkspace(t.tenantId, { settleMs: 0 }).finally(() => (finished = true));
    // Longer than a whole split takes: without the lock it would have copied (missing the uncommitted
    // row), switched and deleted by now.
    await tick(6000);
    expect(finished).toBe(false);
    expect(await infra(t.tenantId)).toMatchObject({ status: 'moving', database: shared });
    release();
    await work;
    expect(await split).toMatchObject({ outcome: 'moved' });
    const moved = postgres(ownUrl(t.tenantId), { max: 1, onnotice: () => {} });
    try {
      expect(await moved`select id from platform.outbox where id = ${written}`).toHaveLength(1);
    } finally {
      await moved.end();
    }
  });

  it('a request that reaches the shared database while a split holds the workspace is 503, not written', async () => {
    const t = await sharedWorkspace();
    const held = postgres(config.databaseAdminUrl, { max: 1, onnotice: () => {} });
    try {
      await held`select pg_advisory_lock(hashtext(${`ws:${t.tenantId}`}))`;
      // This instance's cache still says active: the lock refuses it.
      await expect(withTenant(t.tenantId, async () => 'in')).rejects.toMatchObject({ slug: 'workspace-unavailable', status: 503 });
    } finally {
      await held.end();
    }
    expect(await withTenant(t.tenantId, async () => 'in')).toBe('in');
  });

  it('a transaction routed to the shared database before the switch and started after it is refused, and writes nothing there', async () => {
    const t = await sharedWorkspace();
    const write = (n: number) =>
      withTenant(t.tenantId, (tx) => publish({ tenantId: t.tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, probe, { n }));
    // Another process (the API, while the split runs from the CLI): its cached row still says the shared database.
    registerWorkspaceLookup(async (id) => (id === t.tenantId ? { status: 'active', database: shared } : workspaceInfo(id)), workspaceList);
    try {
      expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'moved' });
      await expect(write(77)).rejects.toMatchObject({ slug: 'workspace-unavailable', status: 503 });
      expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual({});
    } finally {
      registerWorkspaceLookup(workspaceInfo, workspaceList);
    }
    // With the real row, the retry goes to its own database.
    await write(78);
    expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual({});
  });

  it('workspaces not moved out yet use the shared pools at full size, not a small workspace pool', async () => {
    const a = await sharedWorkspace();
    const b = await sharedWorkspace();
    // More at once than a workspace pool admits (SCOUT_WORKSPACE_POOL_MAX - 1), fewer than the shared pool does.
    const n = config.workspacePoolMax + 1;
    expect(n).toBeLessThan(config.databasePoolMax);
    let inside = 0;
    let open!: () => void;
    const all = new Promise<void>((r) => (open = r));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`only ${inside} of ${n} got in`)), 5000));
    const one = (tenantId: string) =>
      withTenant(tenantId, async () => {
        if (++inside === n) open();
        await Promise.race([all, timeout]);
      });
    await Promise.all(Array.from({ length: n }, (_, i) => one(i % 2 ? a.tenantId : b.tenantId)));
    expect(inside).toBe(n);
  });

  it('admin actions on its schedules and dead jobs are refused while it moves', async () => {
    const t = await sharedWorkspace();
    const deadId = newId('dead');
    await withWorkspaceAdmin(t.tenantId, (tx) =>
      tx.insert(deadJob).values({ id: deadId, tenantId: t.tenantId, consumerOrJob: 'test.consumer', envelope: { id: deadId }, lastError: 'boom', attempts: 3 }),
    );
    const [sch] = await adminDb.select().from(schedule).where(eq(schedule.tenantId, t.tenantId)).limit(1);
    await setRow(t.tenantId, { status: 'moving' });
    const admin = { actor: { kind: 'user', id: 'usr_admin' } as const };
    const refused = { slug: 'workspace-unavailable' };
    await expect(retryDeadJob(admin, deadId)).rejects.toMatchObject(refused);
    await expect(discardDeadJob(admin, deadId)).rejects.toMatchObject(refused);
    await expect(pauseSchedule(admin, sch!.id)).rejects.toMatchObject(refused);
    await expect(runNow(admin, sch!.id)).rejects.toMatchObject(refused);
    expect(await adminDb.select().from(deadJob).where(eq(deadJob.id, deadId))).toHaveLength(1);
    await setRow(t.tenantId, { status: 'active' });
  });

  it('when its row changes during the move (scout migrate marks it failed), nothing is switched or deleted', async () => {
    const t = await sharedWorkspace();
    const counts = nonEmpty(await countTenantRows(sharedUrl, t.tenantId));
    const split = splitWorkspace(t.tenantId, { settleMs: 400 });
    await tick(150);
    await adminDb.update(workspaceInfra).set({ status: 'failed', failedStep: 'migrate' }).where(eq(workspaceInfra.tenantId, t.tenantId));
    await expect(split).rejects.toThrow('Its registry row changed during the move');
    expect(await infra(t.tenantId)).toMatchObject({ status: 'failed', database: shared });
    expect(nonEmpty(await countTenantRows(sharedUrl, t.tenantId))).toEqual(counts);
    expect(await databaseExists(workspaceDatabaseName(t.tenantId))).toBe(false);
  });

  it('leaves a workspace made in its own database alone, and the control plane rows under its id', async () => {
    const admin = await seedUser({ admin: true });
    const owner = await seedUser({ signedIn: true });
    const t = await createTenant(admin.actor, { slug: uniqueSlug(), name: 'Own from the start', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
    dropAfter(workspaceDatabaseName(t.tenantId));
    expect(await provisionWorkspace(t.tenantId)).toBe('active');
    const before = await countTenantRows(sharedUrl, t.tenantId);
    expect(await splitWorkspace(t.tenantId, { settleMs: 0 })).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('already in its own database') });
    expect(await countTenantRows(sharedUrl, t.tenantId)).toEqual(before);
  });

  it('--settle-seconds takes a whole number; under 65 it warns', async () => {
    await expect(run(['tenant', 'split', 'x', '--settle-seconds', 'soon'])).rejects.toThrow('--settle-seconds takes a whole number');
    await expect(run(['tenant', 'split', 'x', '--settle-seconds=-5'])).rejects.toThrow('--settle-seconds takes a whole number');
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
    try {
      await expect(run(['tenant', 'split', 'no-such-workspace', '--settle-seconds', '5'])).rejects.toThrow('No workspace');
    } finally {
      warn.mockRestore();
    }
    expect(warned[0]).toContain('under 65');
    expect(warned[0]).toContain('Only safe when no API or worker is running.');
  });
});
