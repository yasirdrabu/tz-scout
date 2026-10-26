import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adminDb } from '@/platform/db/client';
import { schedule } from '@/platform/db/schema';
import { defineJob } from '@/platform/events/registry';
import { pauseSchedule, resumeSchedule, runNow, schedulerTick, upsertSchedule } from '@/platform/scheduler';

const job = defineJob('platform.sched_test', z.object({ n: z.number().optional() }));
const admin = { actor: { kind: 'user', id: 'usr_admin' } as const };

const jobCount = async () => {
  const r = await adminDb.execute(sql`select count(*)::int as n from platform.outbox where kind = 'job'`);
  return (r[0] as { n: number }).n;
};
const row = async (id: string) => (await adminDb.select().from(schedule).where(eq(schedule.id, id)))[0]!;

async function dueRow(): Promise<string> {
  const id = await upsertSchedule(admin, {
    tenantId: 't_platform',
    jobName: job.name,
    cron: '*/5 * * * *',
    timezone: 'UTC',
    payload: { n: 1 },
  });
  await adminDb
    .update(schedule)
    .set({ nextRunAt: new Date(Date.now() - 60_000) })
    .where(eq(schedule.id, id));
  return id;
}

describe('scheduler', () => {
  beforeEach(async () => {
    await adminDb.execute(sql`delete from platform.schedule`);
    await adminDb.execute(sql`delete from platform.outbox`);
  });

  it('publishes a due row once and moves next_run_at forward (PLT-E2-S1-AC1)', async () => {
    const id = await dueRow();
    const before = await row(id);
    const now = new Date();
    expect(await schedulerTick(now)).toBe(1);
    expect(await jobCount()).toBe(1);
    const after = await row(id);
    expect(after.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(after.lastRunAt?.getTime()).toBe(before.nextRunAt.getTime());
    expect(await schedulerTick(now)).toBe(0);
    expect(await jobCount()).toBe(1);
  });

  it('two concurrent ticks publish one job in total', async () => {
    await dueRow();
    const now = new Date();
    const [a, b] = await Promise.all([schedulerTick(now), schedulerTick(now)]);
    expect(a + b).toBe(1);
    expect(await jobCount()).toBe(1);
  });

  it('skips paused rows; runNow publishes without moving next_run_at (PLT-E2-S1-AC2)', async () => {
    const id = await dueRow();
    await pauseSchedule(admin, id);
    expect(await schedulerTick(new Date())).toBe(0);
    expect(await jobCount()).toBe(0);
    const before = await row(id);
    await runNow(admin, id);
    expect(await jobCount()).toBe(1);
    expect((await row(id)).nextRunAt.getTime()).toBe(before.nextRunAt.getTime());
    await resumeSchedule(admin, id);
    const resumed = await row(id);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('computes next_run_at from the cron and timezone', async () => {
    const id = await upsertSchedule(
      admin,
      { tenantId: 't_platform', jobName: job.name, cron: '0 11 * * 1', timezone: 'UTC', payload: {} },
      new Date('2026-10-25T12:00:00Z'),
    );
    expect((await row(id)).nextRunAt.toISOString()).toBe('2026-10-26T11:00:00.000Z');
  });

  it('upsert keeps one row per tenant and job, and rejects bad cron or payload', async () => {
    const a = await dueRow();
    const b = await upsertSchedule(admin, {
      tenantId: 't_platform',
      jobName: job.name,
      cron: '0 3 * * *',
      timezone: 'UTC',
      payload: {},
    });
    expect(b).toBe(a);
    await expect(
      upsertSchedule(admin, { tenantId: 't_platform', jobName: job.name, cron: 'nope', timezone: 'UTC', payload: {} }),
    ).rejects.toThrow();
    await expect(
      upsertSchedule(admin, { tenantId: 't_platform', jobName: job.name, cron: '* * * * *', timezone: 'UTC', payload: { n: 'x' } }),
    ).rejects.toThrow();
  });

  it('a row whose enqueue fails in SQL does not stop the other due row', async () => {
    const failing = defineJob('platform.sched_fail', z.object({}));
    await adminDb.execute(sql`create or replace function platform.sched_test_fail() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end $$`);
    await adminDb.execute(sql`create trigger sched_test_fail before insert on platform.outbox for each row when (new.nats_subject like '%sched_fail%') execute function platform.sched_test_fail()`);
    try {
      const good = await dueRow();
      const bad = await upsertSchedule(admin, {
        tenantId: 't_platform', jobName: failing.name, cron: '*/5 * * * *', timezone: 'UTC', payload: {},
      });
      await adminDb.update(schedule).set({ nextRunAt: new Date(Date.now() - 120_000) }).where(eq(schedule.id, bad));
      expect(await schedulerTick(new Date())).toBe(1);
      expect(await jobCount()).toBe(1);
      expect((await row(good)).nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect((await row(bad)).lastRunAt).toBeNull();
    } finally {
      await adminDb.execute(sql`drop trigger if exists sched_test_fail on platform.outbox`);
    }
  });

  it('upsert with unchanged cron keeps next_run_at; resume of an enabled row is a no-op', async () => {
    const id = await dueRow();
    const before = await row(id);
    await upsertSchedule(admin, { tenantId: 't_platform', jobName: job.name, cron: '*/5 * * * *', timezone: 'UTC', payload: { n: 2 } });
    expect((await row(id)).nextRunAt.getTime()).toBe(before.nextRunAt.getTime());
    await resumeSchedule(admin, id);
    expect((await row(id)).nextRunAt.getTime()).toBe(before.nextRunAt.getTime());
  });
});
