import { afterAll, describe, expect, it } from 'vitest';
import { closeDbs } from '@/platform/db/client';
import { discardDeadJob, listDeadJobs, recordDeadJob } from '@/platform/dead-jobs';
import type { Envelope } from '@/platform/events/envelope';
import { systemHealth } from '@/platform/health';
import { newId } from '@/platform/ids';

afterAll(async () => {
  await closeDbs();
});

const envelope = (tenantId: string): Envelope => ({
  id: newId('job'),
  type: 'jobs.platform.ping',
  schemaVersion: 1,
  tenantId,
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system', id: 'system' },
  correlationId: newId('cor'),
  data: { sentAt: new Date().toISOString() },
});

describe('systemHealth', () => {
  it('counts dead jobs and reports relay lag, consumers and schedules (PLT-E4-S1-AC1)', async () => {
    const before = (await systemHealth()).deadJobs;
    const tenantId = newId('t');
    expect(await recordDeadJob({ name: 'platform.ping', envelope: envelope(tenantId), error: 'boom', attempts: 3 })).toBe(true);
    const h = await systemHealth();
    expect(h.deadJobs).toBe(before + 1);
    expect(h.relayLagMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(h.schedules)).toBe(true);
    expect(h.consumersAvailable).toBe(true);
    for (const c of h.consumers) {
      expect(typeof c.name).toBe('string');
      expect(c.pending).toBeGreaterThanOrEqual(0);
      expect(c.ackPending).toBeGreaterThanOrEqual(0);
    }
    const mine = (await listDeadJobs()).find((d) => d.tenantId === tenantId)!;
    await discardDeadJob({ actor: { kind: 'system', id: 'system' } }, mine.id);
    expect((await systemHealth()).deadJobs).toBe(before);
  });

  it('still answers with the database numbers when NATS is down', async () => {
    const h = await systemHealth({ natsUrl: 'nats://127.0.0.1:1' });
    expect(h.consumersAvailable).toBe(false);
    expect(h.consumers).toEqual([]);
    expect(typeof h.deadJobs).toBe('number');
  });
});
