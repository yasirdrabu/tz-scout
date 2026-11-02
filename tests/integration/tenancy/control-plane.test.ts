import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  auditEntries,
  changeMember,
  completeSignIn,
  createApiKey,
  createTenant,
  inviteMembers,
  memberList,
  members,
  SYSTEM_GRANTOR,
  tenantTimezone,
} from '@/modules/tenancy';
import { memberActivatedAuditHandler, memberActivatedAuditJob } from '@/modules/tenancy';
import { membership, tenant, workspaceInfra } from '@/modules/tenancy/db/schema';
import { PLATFORM_TENANT } from '@/platform/audit';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { forgetWorkspace } from '@/platform/db/doors';
import { auditLog, outbox } from '@/platform/db/schema';
import { withTenant } from '@/platform/db/tenant';
import type { Envelope } from '@/platform/events/envelope';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { TenancyOnWorkspaceTx } from '../helpers/tenancy-guard';
import { inTenant, seedUser, uniqueSlug } from './helpers';

// The guard is on for the whole integration suite (tenancy-guard-setup.ts); these tests prove it bites
// and that tenancy, called with a workspace context, keeps its SQL on the control plane (D35).

async function newTenant(slug = uniqueSlug()) {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, { slug, name: 'Guarded', currency: 'USD', timezone: 'Asia/Kolkata', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  return { ...t, admin, owner };
}

const outboxCount = async (tenantId: string, type: string) =>
  ((await adminDb.execute<{ n: number }>(
    sql`select count(*)::int as n from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = ${type}`,
  ))[0]!).n;

/** The guard's error, unwrapped from drizzle's query error. */
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (e: { cause?: unknown }) => (e instanceof TenancyOnWorkspaceTx ? e : e.cause),
  );

describe('the workspace transaction guard', () => {
  it('refuses tenancy SQL on a workspace transaction and lets workspace SQL through', async () => {
    expect(await refusal(withTenant('t_guard', (tx) => tx.select().from(membership)))).toBeInstanceOf(TenancyOnWorkspaceTx);
    expect(await refusal(withTenant('t_guard', (tx) => tx.execute(sql`select 1 from tenancy.tenant`)))).toBeInstanceOf(TenancyOnWorkspaceTx);
    expect(await refusal(withTenant('t_guard', (tx) => tx.transaction((sp) => sp.select().from(tenant))))).toBeInstanceOf(TenancyOnWorkspaceTx);
    expect(await withTenant('t_guard', (tx) => tx.select().from(auditLog).limit(1))).toEqual([]);
  });

  it('does not apply to t_platform, which is the control plane', async () => {
    expect(await withTenant(PLATFORM_TENANT, async (tx) => (await tx.select({ id: tenant.id }).from(tenant).limit(1)).length)).toBeGreaterThanOrEqual(0);
  });
});

describe('tenancy with a workspace context', () => {
  it('reads and writes members, keys and the audit log without touching the workspace transaction', async () => {
    const t = await newTenant();
    const res = await inTenant(t.tenantId, t.owner.actor, async (ctx) => {
      const id = await addMember(ctx, { email: `${uniqueSlug()}@example.com`, role: 'seller' });
      await changeMember(ctx, id, { role: 'leader' });
      const invites = await inviteMembers(ctx, { emails: [`${uniqueSlug()}@example.com`, 'not-an-email'], role: 'seller' });
      const key = await createApiKey(ctx, { name: 'k', environment: 'test', scopes: ['accounts:read'] }, SYSTEM_GRANTOR);
      return {
        id,
        invites,
        key,
        list: await memberList(ctx),
        people: await members(ctx),
        timezone: await tenantTimezone(ctx),
        audit: await auditEntries(ctx, { q: 'seller' }),
      };
    });
    expect(res.invites.map((i) => i.ok)).toEqual([true, false]);
    expect(res.list.find((m) => m.id === res.id)?.role).toBe('leader');
    expect(res.people).toHaveLength(3);
    expect(res.timezone).toBe('Asia/Kolkata');
    // Audit rows stay in the workspace; the names behind them come from the control plane.
    const actions = (await adminDb.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.tenantId, t.tenantId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['tenancy.member.added', 'tenancy.member.changed', 'tenancy.api_key.created']));
  });

  it('a refused change leaves neither the membership nor its audit row', async () => {
    const t = await newTenant();
    const email = `${uniqueSlug()}@example.com`;
    await inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email, role: 'seller' }));
    await expect(inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email, role: 'seller' }))).rejects.toMatchObject({ slug: 'already-member' });
    const added = await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, t.tenantId), eq(auditLog.action, 'tenancy.member.added')));
    expect(added).toHaveLength(1);
  });

  it('more requests at once than the workspace pool holds all reach tenancy (no wait on their own pool)', async () => {
    const t = await newTenant();
    const n = config.databasePoolMax + 5;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs = Array.from({ length: n }, () =>
      inTenant(t.tenantId, t.owner.actor, async (ctx) => {
        await gate;
        return (await members(ctx)).length;
      }),
    );
    // Let every transaction that can open do so before tenancy is asked.
    await new Promise((r) => setTimeout(r, 200));
    release();
    expect(await Promise.all(runs)).toEqual(Array(n).fill(1));
  });
});

describe('writes that span the control plane and a workspace (Review Focus 2)', () => {
  it('tenant creation publishes tenancy.tenant.created exactly once across a failed attempt and a retry', async () => {
    const admin = await seedUser({ admin: true });
    const slug = uniqueSlug();
    const input = { slug, name: 'Retry', currency: 'USD', timezone: 'UTC', ownerEmail: `${uniqueSlug()}@example.com` };
    // A first attempt that fails after the tenant's writes: everything rolls back with it.
    await expect(
      adminDb.transaction(async (tx) => {
        await createTenant(admin.actor, input, tx);
        throw new Error('the request failed');
      }),
    ).rejects.toThrow('the request failed');
    expect(await adminDb.select().from(tenant).where(eq(tenant.slug, slug))).toEqual([]);

    const { tenantId } = await createTenant(admin.actor, input);
    await expect(createTenant(admin.actor, input)).rejects.toMatchObject({ slug: 'slug-taken' });
    expect(await outboxCount(tenantId, 'tenancy.tenant.created')).toBe(1);
  });

  it('sign-in activates on the control plane and audits in each workspace through a job: a failed delivery retries, a repeat adds nothing', async () => {
    const a = await newTenant();
    const b = await newTenant();
    const person = await seedUser();
    for (const t of [a, b]) {
      await inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email: person.email, role: 'seller' }));
    }
    await completeSignIn(person.id);
    const statuses = await adminDb.select({ status: membership.status }).from(membership).where(eq(membership.userId, person.id));
    expect(statuses.map((m) => m.status)).toEqual(['active', 'active']);
    const rows = () =>
      adminDb
        .select({ tenantId: auditLog.tenantId })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'tenancy.member.activated'), eq(auditLog.actorId, person.id)));
    // Enqueued on the control plane with the activation; nothing written in the workspaces yet.
    expect(await rows()).toEqual([]);
    const jobs = async (tenantId: string) =>
      (await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.kind, 'job'))))
        .map((r) => r.payload as Envelope)
        .filter((e) => e.type === `jobs.${memberActivatedAuditJob.name}`);
    const [jobA] = await jobs(a.tenantId);
    expect(await jobs(b.tenantId)).toHaveLength(1);

    // Workspace a is down: the delivery fails and nothing is written; the worker retries it later.
    await adminDb.update(workspaceInfra).set({ status: 'suspended' }).where(eq(workspaceInfra.tenantId, a.tenantId));
    forgetWorkspace(a.tenantId);
    await expect(deliverOnce(memberActivatedAuditHandler, jobA!)).rejects.toMatchObject({ slug: 'workspace-unavailable' });
    await adminDb.update(workspaceInfra).set({ status: 'active' }).where(eq(workspaceInfra.tenantId, a.tenantId));
    forgetWorkspace(a.tenantId);
    expect(await deliverOnce(memberActivatedAuditHandler, jobA!)).toBe('handled');
    expect(await deliverOnce(memberActivatedAuditHandler, jobA!)).toBe('duplicate');
    await runOutbox(b.tenantId);
    expect((await rows()).map((r) => r.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });
});
