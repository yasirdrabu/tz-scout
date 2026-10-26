import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { audit, listAudit, platformAudit, redact } from '@/platform/audit';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { withTenant } from '@/platform/db/tenant';
import type { ModuleContext } from '@/platform/context';
import type { Actor } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';

const ctxFor = (tenantId: string, actor: Actor, tx: ModuleContext['tx']): ModuleContext => ({
  tenantId,
  actor,
  correlationId: newId('cor'),
  tx,
});
const alice: Actor = { kind: 'user', id: 'usr_alice' };
const bob: Actor = { kind: 'user', id: 'usr_bob' };

describe('audit log', () => {
  it('leaves no row when the transaction rolls back', async () => {
    const tenant = `t_${newId('t')}`;
    await expect(
      withTenant(tenant, async (tx) => {
        await audit(ctxFor(tenant, alice, tx), { action: 'x.rolled_back' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await adminDb.select().from(auditLog).where(eq(auditLog.tenantId, tenant));
    expect(rows).toHaveLength(0);
  });

  it('redacts sensitive keys at any depth, including inside arrays', async () => {
    const tenant = `t_${newId('t')}`;
    await withTenant(tenant, (tx) =>
      audit(ctxFor(tenant, alice, tx), {
        action: 'x.changed',
        subject: { type: 'thing', id: 'th_1' },
        before: { token: 'abc', name: 'n' },
        after: { nested: { Password: 'p', list: [{ api_secret: 's', ok: 1 }] }, key_hash: 'h', ciphertext: 'c' },
      }),
    );
    const [row] = await adminDb.select().from(auditLog).where(eq(auditLog.tenantId, tenant));
    expect(row!.before).toEqual({ token: '[redacted]', name: 'n' });
    expect(row!.after).toEqual({
      nested: { Password: '[redacted]', list: [{ api_secret: '[redacted]', ok: 1 }] },
      key_hash: '[redacted]',
      ciphertext: '[redacted]',
    });
    expect(row!.subjectType).toBe('thing');
    expect(redact('plain')).toBe('plain');
  });

  it('lists by actor, newest first, with cursor paging', async () => {
    const tenant = `t_${newId('t')}`;
    for (const [i, actor] of [alice, bob, alice, alice].entries()) {
      await withTenant(tenant, (tx) => audit(ctxFor(tenant, actor, tx), { action: `x.step_${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    const mine = await withTenant(tenant, (tx) => listAudit({ tenantId: tenant, tx }, { actorId: 'usr_alice' }));
    expect(mine.rows.map((r) => r.action)).toEqual(['x.step_3', 'x.step_2', 'x.step_0']);
    expect(mine.nextCursor).toBeNull();

    const p1 = await withTenant(tenant, (tx) => listAudit({ tenantId: tenant, tx }, { limit: 3 }));
    expect(p1.rows.map((r) => r.action)).toEqual(['x.step_3', 'x.step_2', 'x.step_1']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await withTenant(tenant, (tx) =>
      listAudit({ tenantId: tenant, tx }, { limit: 3, cursor: p1.nextCursor! }),
    );
    expect(p2.rows.map((r) => r.action)).toEqual(['x.step_0']);
    expect(p2.nextCursor).toBeNull();
  });

  it("does not show tenant A's rows to tenant B", async () => {
    const a = `t_${newId('t')}`;
    const b = `t_${newId('t')}`;
    await withTenant(a, (tx) => audit(ctxFor(a, alice, tx), { action: 'x.secret_move' }));
    const seenByB = await withTenant(b, (tx) => listAudit({ tenantId: b, tx }));
    expect(seenByB.rows).toHaveLength(0);
    // Even asking for A's id from B's session returns nothing (row level security).
    const spoof = await withTenant(b, (tx) => listAudit({ tenantId: a, tx }));
    expect(spoof.rows).toHaveLength(0);
  });

  it('writes platform rows under t_platform through adminDb', async () => {
    const id = newId('job');
    await platformAudit({
      action: 'platform.test',
      actor: { kind: 'system', id: 'system' },
      subject: { type: 'job', id },
    });
    const [row] = await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, id));
    expect(row!.tenantId).toBe('t_platform');
  });
});
