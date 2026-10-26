import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { audit, listAudit, platformAudit, redact } from '@/platform/audit';
import { adminDb } from '@/platform/db/client';
import { discardDeadJob, retryDeadJob } from '@/platform/dead-jobs';
import { deadJob } from '@/platform/db/schema';
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

  it('pages through rows that share one transaction timestamp without dropping any', async () => {
    const tenant = `t_${newId('t')}`;
    await withTenant(tenant, async (tx) => {
      for (let i = 0; i < 7; i++) await audit(ctxFor(tenant, alice, tx), { action: `x.same_tx_${i}` });
    });
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTenant(tenant, (tx) => listAudit({ tenantId: tenant, tx }, { limit, cursor }));
        seen.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    }
  });

  it('rejects a malformed cursor with a 400', async () => {
    const tenant = `t_${newId('t')}`;
    for (const cursor of ['not-a-cursor', Buffer.from('[1,2]').toString('base64url')]) {
      await expect(withTenant(tenant, (tx) => listAudit({ tenantId: tenant, tx }, { cursor }))).rejects.toMatchObject({
        slug: 'invalid-cursor',
        status: 400,
      });
    }
  });

  it('does not crash on cycles, errors, bigints or dates', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    const out = redact({ loop, err: new Error('bad'), big: 10n, when: new Date('2026-01-01T00:00:00Z') }) as Record<
      string,
      unknown
    >;
    expect(out.loop).toEqual({ a: 1, self: '[circular]' });
    expect(out.err).toEqual({ name: 'Error', message: 'bad' });
    expect(out.big).toBe('10');
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');
  });

  it('filters by api key, source, subject and time range', async () => {
    const tenant = `t_${newId('t')}`;
    const agent: Actor = { kind: 'agent', id: 'agt_1', sourceId: 'src_9' };
    await withTenant(tenant, async (tx) => {
      await audit(ctxFor(tenant, agent, tx), {
        action: 'x.k',
        apiKeyId: 'key_1',
        subject: { type: 'thing', id: 'th_k' },
      });
      await audit(ctxFor(tenant, alice, tx), { action: 'x.plain', subject: { type: 'thing', id: 'th_p' } });
    });
    const q = (f: Parameters<typeof listAudit>[1]) =>
      withTenant(tenant, (tx) => listAudit({ tenantId: tenant, tx }, f)).then((r) => r.rows.map((x) => x.action));
    expect(await q({ apiKeyId: 'key_1' })).toEqual(['x.k']);
    expect(await q({ sourceId: 'src_9' })).toEqual(['x.k']);
    expect(await q({ subjectId: 'th_p' })).toEqual(['x.plain']);
    expect(await q({ from: new Date(Date.now() + 60_000) })).toEqual([]);
    expect(await q({ to: new Date(Date.now() - 3_600_000) })).toEqual([]);
    expect(await q({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) })).toHaveLength(2);
  });

  it('records dead-job retry and discard under t_platform with the subject id', async () => {
    const tenant = `t_${newId('t')}`;
    const admin = { actor: { kind: 'user', id: 'usr_admin' } as const, correlationId: newId('cor') };
    const dead = async () => {
      const id = newId('dead');
      const evtId = newId('evt');
      await adminDb.insert(deadJob).values({
        id,
        tenantId: tenant,
        consumerOrJob: 'audit.test',
        envelope: {
          id: evtId,
          type: 'platform.thing.happened',
          schemaVersion: 1,
          tenantId: tenant,
          occurredAt: new Date().toISOString(),
          actor: { kind: 'system', id: 'system' },
          correlationId: newId('cor'),
          data: {},
        },
        lastError: 'x',
        attempts: 3,
      });
      return id;
    };
    const a = await dead();
    const b = await dead();
    await retryDeadJob(admin, a);
    await discardDeadJob(admin, b);
    for (const [id, action] of [
      [a, 'platform.dead_job.retried'],
      [b, 'platform.dead_job.discarded'],
    ] as const) {
      const [row] = await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, id));
      expect(row).toMatchObject({ tenantId: 't_platform', action, actorId: 'usr_admin', subjectType: 'dead_job' });
      expect(row!.correlationId).toBe(admin.correlationId);
      expect((row!.after as { tenantId: string }).tenantId).toBe(tenant);
    }
  });

  it('platformAudit with a rolled-back transaction leaves no row', async () => {
    const id = newId('job');
    await expect(
      adminDb.transaction(async (tx) => {
        await platformAudit({ action: 'platform.rolled_back', actor: alice, subject: { type: 'job', id } }, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, id))).toHaveLength(0);
  });

  it('the app role cannot update or delete audit rows', async () => {
    const tenant = `t_${newId('t')}`;
    await withTenant(tenant, (tx) => audit(ctxFor(tenant, alice, tx), { action: 'x.keep' }));
    await expect(
      withTenant(tenant, (tx) => tx.execute(sql`update platform.audit_log set action = 'y'`)),
    ).rejects.toThrow();
    await expect(withTenant(tenant, (tx) => tx.execute(sql`delete from platform.audit_log`))).rejects.toThrow();
  });
});
