import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adminDb } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { defineEvent, defineJob } from '@/platform/events/registry';
import type { ModuleContext } from '@/platform/context';

const memberAdded = defineEvent('tenancy.member.added', 1, z.object({ userId: z.string() }));
const rescore = defineJob('scoring.rescore', z.object({ n: z.number() }));

const count = async () => {
  const r = await adminDb.execute(sql`select count(*)::int as n from platform.outbox`);
  return (r[0] as { n: number }).n;
};
const ctxOf = (tx: ModuleContext['tx']): ModuleContext => ({
  tenantId: 't_A',
  actor: { kind: 'system', id: 'system' },
  correlationId: 'cor_test',
  tx,
});

describe('outbox', () => {
  it('leaves no row after rollback (PLT-E1-S1-AC1)', async () => {
    await adminDb.execute(sql`delete from platform.outbox`);
    await expect(
      withTenant('t_A', async (tx) => {
        await publish(ctxOf(tx), memberAdded, { userId: 'usr_1' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count()).toBe(0);
  });

  it('rejects invalid data and rolls back (PLT-E1-S1-AC2)', async () => {
    await adminDb.execute(sql`delete from platform.outbox`);
    await expect(
      withTenant('t_A', (tx) => publish(ctxOf(tx), memberAdded, { wrong: 1 } as never)),
    ).rejects.toThrow(z.ZodError);
    expect(await count()).toBe(0);
  });

  it('writes the subject and envelope', async () => {
    await adminDb.execute(sql`delete from platform.outbox`);
    const env = await withTenant('t_A', (tx) =>
      publish(ctxOf(tx), memberAdded, { userId: 'usr_1' }, { type: 'user', id: 'usr_1' }),
    );
    const rows = await adminDb.execute(sql`select * from platform.outbox`);
    const row = rows[0] as Record<string, unknown>;
    expect(row.nats_subject).toBe('scout.t_A.tenancy.member.added');
    expect(row.kind).toBe('event');
    expect(row.id).toBe(env.id);
    expect(row.sent_at).toBeNull();
    expect((row.payload as { subject: unknown }).subject).toEqual({ type: 'user', id: 'usr_1' });
  });

  it('enqueues a job row', async () => {
    await adminDb.execute(sql`delete from platform.outbox`);
    const id = await withTenant('t_A', (tx) => enqueueJob(ctxOf(tx), rescore, { n: 1 }));
    const row = (await adminDb.execute(sql`select * from platform.outbox`))[0] as Record<string, unknown>;
    expect(row.kind).toBe('job');
    expect(row.nats_subject).toBe('scout.t_A.jobs.scoring.rescore');
    expect(row.id).toBe(id);
    expect((row.payload as { type: string }).type).toBe('jobs.scoring.rescore');
  });
});
