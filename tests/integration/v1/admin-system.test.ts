import { and, eq, gt, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as health } from '@/http/routes/v1/admin/health/route';
import { POST as jobAction } from '@/http/routes/v1/admin/jobs/[id]/route';
import { POST as scheduleAction } from '@/http/routes/v1/admin/schedules/[id]/route';
import { POST as testEvent } from '@/http/routes/v1/admin/test-event/route';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { recordDeadJob } from '@/platform/dead-jobs';
import { adminDb } from '@/platform/db/client';
import { auditLog, deadJob, outbox, pingResult, schedule } from '@/platform/db/schema';
import type { Envelope } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import '@/platform/diagnostics';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

let admin: Person;
let owner: Person;
let acme: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};
let keySecret: string;

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  acme = await tenantOwnedBy(admin, owner.email, 'Health Co');
  for (const p of [admin, owner]) cookies[p.id] = await signedIn(p.id);
  keySecret = (
    await inTenant(acme.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['accounts:read'] }, SYSTEM_GRANTOR),
    )
  ).secret;
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person) => ({ cookies: cookies[p.id] });
type Opts = Parameters<typeof v1Req>[1];

async function refusesNonAdmins(call: (opts: Opts) => Promise<Response>, extra: Opts = {}) {
  expect((await call({ ...extra, ...as(owner) })).status).toBe(403);
  expect((await call({ ...extra, headers: { authorization: `Bearer ${keySecret}` } })).status).toBe(403);
  expect((await call({ ...extra })).status).toBe(401);
}

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

async function deadJobIn(tenantId: string): Promise<string> {
  await recordDeadJob({ name: 'platform.ping', envelope: envelope(tenantId), error: 'boom for ana@example.com', attempts: 3 });
  const [row] = await adminDb.select({ id: deadJob.id }).from(deadJob).where(eq(deadJob.tenantId, tenantId));
  return row!.id;
}

const auditFor = (action: string, subjectId: string) =>
  adminDb.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));

describe('GET /v1/admin/health', () => {
  it('gives relay lag, queues with oldest age, dead jobs with tenant names, schedules and AI spend', async () => {
    const deadId = await deadJobIn(acme.tenantId);
    const scheduleId = await upsertSchedule(
      { actor: admin.actor },
      { tenantId: acme.tenantId, jobName: 'platform.ping', cron: '0 3 * * *', timezone: 'UTC', payload: { sentAt: new Date().toISOString() } },
    );
    const res = await health(v1Req('/admin/health', as(admin)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relay_lag_ms).toBeGreaterThanOrEqual(0);
    expect(body.queues_available).toBe(true);
    expect(typeof body.pending_total).toBe('number');
    for (const q of body.queues) expect(Object.keys(q).sort()).toEqual(['ack_pending', 'name', 'oldest_age_ms', 'pending']);
    expect(body.dead_job_count).toBeGreaterThanOrEqual(1);
    expect(body.dead_jobs.find((d: { id: string }) => d.id === deadId)).toMatchObject({
      tenant_id: acme.tenantId,
      tenant_name: 'Health Co',
      name: 'platform.ping',
      attempts: 3,
    });
    expect(body.schedules.find((s: { id: string }) => s.id === scheduleId)).toMatchObject({
      job_name: 'platform.ping',
      tenant_name: 'Health Co',
      cron: '0 3 * * *',
      enabled: true,
    });
    expect(typeof body.ai_spend_today_cents).toBe('number');
  });

  it('refuses a tenant owner, an API key and anonymous callers', async () => {
    await refusesNonAdmins((o) => health(v1Req('/admin/health', o)));
  });
});

describe('POST /v1/admin/jobs/{id}:retry and :discard', () => {
  it('retry sends the job again and audits it', async () => {
    const t = newId('t');
    const id = await deadJobIn(t);
    const res = await jobAction(v1Req(`/admin/jobs/${id}:retry`, { ...as(admin), method: 'POST' }));
    expect(res.status).toBe(200);
    const { sent_id } = await res.json();
    expect(sent_id).toMatch(/^job_/);
    expect(await adminDb.select().from(outbox).where(eq(outbox.id, sent_id))).toHaveLength(1);
    expect(await adminDb.select().from(deadJob).where(eq(deadJob.id, id))).toHaveLength(0);
    expect(await auditFor('platform.dead_job.retried', id)).toEqual([expect.objectContaining({ actorId: admin.id, tenantId: 't_platform' })]);
  });

  it('discard removes the job and audits it', async () => {
    const id = await deadJobIn(newId('t'));
    const res = await jobAction(v1Req(`/admin/jobs/${id}:discard`, { ...as(admin), method: 'POST' }));
    expect(res.status).toBe(204);
    expect(await adminDb.select().from(deadJob).where(eq(deadJob.id, id))).toHaveLength(0);
    expect(await auditFor('platform.dead_job.discarded', id)).toHaveLength(1);
  });

  it('gives 404 for an unknown job or action, and refuses non-admins', async () => {
    expect((await jobAction(v1Req('/admin/jobs/dead_nope:retry', { ...as(admin), method: 'POST' }))).status).toBe(404);
    const id = await deadJobIn(newId('t'));
    expect((await jobAction(v1Req(`/admin/jobs/${id}:explode`, { ...as(admin), method: 'POST' }))).status).toBe(404);
    for (const a of ['retry', 'discard']) await refusesNonAdmins((o) => jobAction(v1Req(`/admin/jobs/${id}:${a}`, { ...o, method: 'POST' })));
    expect(await adminDb.select().from(deadJob).where(eq(deadJob.id, id))).toHaveLength(1);
  });
});

describe('POST /v1/admin/schedules/{id}:pause, :resume and :run-now', () => {
  let id: string;
  beforeAll(async () => {
    id = await upsertSchedule(
      { actor: { kind: 'system', id: 'system' } },
      { tenantId: newId('t'), jobName: 'platform.ping', cron: '*/5 * * * *', timezone: 'UTC', payload: { sentAt: new Date().toISOString() } },
    );
  });
  const enabled = async () => (await adminDb.select({ e: schedule.enabled }).from(schedule).where(eq(schedule.id, id)))[0]!.e;

  it('pauses and resumes, audited', async () => {
    expect((await scheduleAction(v1Req(`/admin/schedules/${id}:pause`, { ...as(admin), method: 'POST' }))).status).toBe(204);
    expect(await enabled()).toBe(false);
    expect(await auditFor('platform.schedule.paused', id)).toHaveLength(1);
    expect((await scheduleAction(v1Req(`/admin/schedules/${id}:resume`, { ...as(admin), method: 'POST' }))).status).toBe(204);
    expect(await enabled()).toBe(true);
    expect(await auditFor('platform.schedule.resumed', id)).toHaveLength(1);
  });

  it('run now enqueues the job and audits it', async () => {
    const res = await scheduleAction(v1Req(`/admin/schedules/${id}:run-now`, { ...as(admin), method: 'POST' }));
    expect(res.status).toBe(200);
    const { job_id } = await res.json();
    expect(await adminDb.select().from(outbox).where(eq(outbox.id, job_id))).toHaveLength(1);
    expect(await auditFor('platform.schedule.run_now', id)).toEqual([expect.objectContaining({ actorId: admin.id })]);
  });

  it('gives 404 for an unknown schedule or action, and refuses non-admins', async () => {
    expect((await scheduleAction(v1Req('/admin/schedules/sch_nope:pause', { ...as(admin), method: 'POST' }))).status).toBe(404);
    expect((await scheduleAction(v1Req(`/admin/schedules/${id}:delete`, { ...as(admin), method: 'POST' }))).status).toBe(404);
    for (const a of ['pause', 'resume', 'run-now']) {
      await refusesNonAdmins((o) => scheduleAction(v1Req(`/admin/schedules/${id}:${a}`, { ...o, method: 'POST' })));
    }
    expect(await enabled()).toBe(true);
  });
});

describe('POST /v1/admin/test-event', () => {
  it('gives the round trip once the worker has handled the ping', async () => {
    const since = new Date();
    // Stand in for the relay and worker: answer the ping as soon as it is in the outbox.
    const worker = (async () => {
      for (let i = 0; i < 100; i++) {
        const [job] = await adminDb
          .select({ id: outbox.id })
          .from(outbox)
          .where(and(eq(outbox.tenantId, 't_platform'), gt(outbox.createdAt, since), sql`${outbox.payload}->>'type' = 'jobs.platform.ping'`));
        if (job) {
          await adminDb.insert(pingResult).values({ id: job.id, tenantId: 't_platform', sentAt: new Date(Date.now() - 42) });
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const res = await testEvent(v1Req('/admin/test-event', { ...as(admin), method: 'POST' }));
    await worker;
    expect(res.status).toBe(200);
    const { round_trip_ms } = await res.json();
    expect(round_trip_ms).toBeGreaterThanOrEqual(42);
    expect(round_trip_ms).toBeLessThan(10_000);
  });

  it('refuses non-admins and cross-site writes', async () => {
    await refusesNonAdmins((o) => testEvent(v1Req('/admin/test-event', { ...o, method: 'POST' })));
    const evil = await testEvent(v1Req('/admin/test-event', { ...as(admin), method: 'POST', headers: { origin: 'https://evil.example' } }));
    expect(evil.status).toBe(403);
  });
});
