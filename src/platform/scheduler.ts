import { and, eq, lte } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import type { controlAdminDb } from './db/client';
import { assertWorkspaceOpen, inDatabaseHolding, platformDatabases, withControlAdmin, withWorkspaceAdmin, workspaceOpen, type PlatformDatabase } from './db/doors';
import { schedule } from './db/schema';
import { PLATFORM_TENANT, platformAudit, type AuditEntry } from './audit';
import type { AdminCtx } from './dead-jobs';
import { ScoutError } from './errors';
import type { ModuleContext } from './context';
import { enqueueJob } from './events/outbox';
import { jobDef } from './events/registry';
import { newId } from './ids';
import { log as rootLog } from './log';
import { errorText } from './scrub-error';

const log = rootLog.child({ role: 'scheduler' });

const reported = new Set<string>();
/** Logs a bad row once per process per (row id, reason), so a stuck row does not flood the log. */
function logOnce(row: ScheduleRow, reason: string): void {
  const key = row.id + '|' + reason;
  if (reported.has(key)) return;
  reported.add(key);
  log.error({ scheduleId: row.id, jobName: row.jobName, err: reason }, 'schedule skipped');
}

type Tx = Parameters<Parameters<typeof controlAdminDb.transaction>[0]>[0];
type ScheduleRow = typeof schedule.$inferSelect;

export type ScheduleInput = {
  tenantId: string;
  jobName: string;
  cron: string;
  timezone: string;
  payload: unknown;
};

const bad = (title: string, detail: string) => new ScoutError({ slug: 'invalid-schedule', status: 422, title, detail });
const notFound = (id: string) =>
  new ScoutError({ slug: 'not-found', status: 404, title: 'Schedule not found', detail: `No schedule ${id}` });

/** Next fire time strictly after `from`, in the given timezone. Throws a ScoutError on a bad cron or timezone. */
export function nextRun(cron: string, timezone: string, from: Date): Date {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch (e) {
    throw bad('Invalid schedule', `Cannot read cron "${cron}" in ${timezone}: ${(e as Error).message}`);
  }
}

function jobFor(name: string) {
  const def = jobDef(name);
  if (!def) throw bad('Unknown job', `No job named ${name} is registered`);
  return def;
}

async function enqueueFor(tx: Tx, row: ScheduleRow, correlationId = newId('cor')): Promise<string> {
  const ctx: ModuleContext = {
    tenantId: row.tenantId,
    actor: { kind: 'system', id: 'scheduler' },
    correlationId,
    tx,
  };
  return enqueueJob(ctx, jobFor(row.jobName), row.payload);
}

/**
 * Writes a platform audit entry: in `tx` when the change is on the control plane, else on its own (a
 * workspace schedule's change is in its workspace database; the platform audit log is the control plane's).
 */
async function auditScheduleChange(entry: AuditEntry & { actor: AdminCtx['actor']; correlationId?: string }, tx: Tx, onControl: boolean) {
  await platformAudit(entry, onControl ? tx : undefined);
}

/**
 * Creates or updates the schedule for (tenant, job). Computes `next_run_at` from `now`. Returns the id.
 * Written where the tenant's jobs run: `t_platform` on the control plane, a workspace's in its own
 * database, in `adminCtx.tx` when given (a seeder passes its workspace transaction, so the schedule
 * commits with the defaults), else in a transaction of its own.
 */
export async function upsertSchedule(adminCtx: AdminCtx, input: ScheduleInput, now = new Date()): Promise<string> {
  const def = jobFor(input.jobName);
  const payload = def.data.parse(input.payload ?? {}) as object;
  const nextRunAt = nextRun(input.cron, input.timezone, now);
  const onControl = input.tenantId === PLATFORM_TENANT;
  const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    adminCtx.tx ? adminCtx.tx.transaction(fn) : onControl ? withControlAdmin(fn) : withWorkspaceAdmin(input.tenantId, fn);
  return inTx(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schedule)
      .where(and(eq(schedule.tenantId, input.tenantId), eq(schedule.jobName, input.jobName)))
      .for('update');
    let id: string;
    if (existing) {
      id = existing.id;
      const timingChanged = existing.cron !== input.cron || existing.timezone !== input.timezone;
      await tx
        .update(schedule)
        .set({
          cron: input.cron,
          timezone: input.timezone,
          payload,
          ...(timingChanged ? { nextRunAt } : {}),
        })
        .where(eq(schedule.id, id));
    } else {
      id = newId('sch');
      await tx.insert(schedule).values({
        id,
        tenantId: input.tenantId,
        jobName: input.jobName,
        cron: input.cron,
        timezone: input.timezone,
        payload,
        nextRunAt,
      });
    }
    await auditScheduleChange(
      {
        action: 'platform.schedule.upserted',
        actor: adminCtx.actor,
        correlationId: adminCtx.correlationId,
        subject: { type: 'schedule', id },
        after: { tenantId: input.tenantId, jobName: input.jobName, cron: input.cron, timezone: input.timezone },
      },
      tx,
      onControl,
    );
    return id;
  });
}

/**
 * Runs `fn` on the schedule row `id`, locked, in the database that holds it: the caller's control
 * transaction (`adminCtx.tx`) or a new one first, then each workspace database. 404 when none has it.
 */
async function onScheduleRow<T>(
  adminCtx: AdminCtx,
  id: string,
  fn: (tx: Tx, row: ScheduleRow, db: PlatformDatabase) => Promise<T>,
): Promise<T> {
  const found = await inDatabaseHolding(adminCtx.tx, async (tx, db) => {
    const [row] = await tx.select().from(schedule).where(eq(schedule.id, id)).for('update');
    if (!row) return undefined;
    // A workspace being made, moved or suspended is not changed under it (D35).
    await assertWorkspaceOpen(tx, row.tenantId);
    return { value: await fn(tx, row, db) };
  });
  if (!found) throw notFound(id);
  return found.value;
}

async function setEnabled(adminCtx: AdminCtx, id: string, enabled: boolean, now = new Date()): Promise<void> {
  await onScheduleRow(adminCtx, id, async (tx, row, db) => {
    if (row.enabled === enabled) return;
    await tx
      .update(schedule)
      .set(enabled ? { enabled, nextRunAt: nextRun(row.cron, row.timezone, now) } : { enabled })
      .where(eq(schedule.id, id));
    await auditScheduleChange(
      {
        action: enabled ? 'platform.schedule.resumed' : 'platform.schedule.paused',
        actor: adminCtx.actor,
        correlationId: adminCtx.correlationId,
        subject: { type: 'schedule', id },
        after: { tenantId: row.tenantId, jobName: row.jobName },
      },
      tx,
      db.control,
    );
  });
}

export const pauseSchedule = (adminCtx: AdminCtx, id: string) => setEnabled(adminCtx, id, false);
/** Resuming recomputes `next_run_at` from now, so a long pause does not fire a backlog. */
export const resumeSchedule = (adminCtx: AdminCtx, id: string) => setEnabled(adminCtx, id, true);

/** Publishes the job now. Leaves `next_run_at` and `last_run_at` alone. Returns the job id. */
export async function runNow(adminCtx: AdminCtx, id: string): Promise<string> {
  return onScheduleRow(adminCtx, id, async (tx, row, db) => {
    // Into the outbox of the database that holds the schedule: where the tenant's jobs are relayed from.
    const jobId = await enqueueFor(tx, row, adminCtx.correlationId);
    await auditScheduleChange(
      {
        action: 'platform.schedule.run_now',
        actor: adminCtx.actor,
        correlationId: adminCtx.correlationId,
        subject: { type: 'schedule', id },
        after: { tenantId: row.tenantId, jobName: row.jobName, jobId },
      },
      tx,
      db.control,
    );
    return jobId;
  });
}

/**
 * Publishes every due schedule in one transaction. Rows are claimed with `for update skip locked`,
 * so concurrent ticks (several scheduler processes) never publish the same run twice.
 * A row whose job is not registered or whose cron is unreadable is logged and left alone.
 * Each database (`platformDatabases`) is ticked in turn and its due jobs go into its own outbox; a
 * database that fails is logged and the others still tick.
 */
export async function schedulerTick(now: Date): Promise<number> {
  let published = 0;
  for (const db of await platformDatabases()) {
    try {
      published += await tickDatabase(db, now);
    } catch (e) {
      log.error({ database: db.name, err: errorText(e) }, 'scheduler tick failed for a database');
    }
  }
  return published;
}

async function tickDatabase(db: PlatformDatabase, now: Date): Promise<number> {
  return db.admin.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedule)
      .where(and(eq(schedule.enabled, true), lte(schedule.nextRunAt, now)))
      .orderBy(schedule.nextRunAt)
      .for('update', { skipLocked: true });
    let published = 0;
    for (const row of due) {
      // A workspace not open (being made, moved, suspended) runs nothing: its schedule stays due until it opens.
      if (!(await workspaceOpen(row.tenantId))) continue;
      try {
        const next = nextRun(row.cron, row.timezone, now);
        // Savepoint: a SQL failure rolls back only this row.
        await tx.transaction(async (sp) => {
          await enqueueFor(sp, row);
          await sp.update(schedule).set({ lastRunAt: row.nextRunAt, nextRunAt: next }).where(eq(schedule.id, row.id));
        });
        published++;
      } catch (e) {
        logOnce(row, errorText(e));
      }
    }
    return published;
  });
}

/** Ticks every `everyMs` until aborted. A failed tick is logged and retried on the next one. */
export async function runScheduler(opts: { signal: AbortSignal; everyMs?: number }): Promise<void> {
  const { signal, everyMs = 15_000 } = opts;
  while (!signal.aborted) {
    try {
      const n = await schedulerTick(new Date());
      if (n > 0) log.info({ published: n }, 'scheduler tick');
    } catch (e) {
      log.error({ err: errorText(e) }, 'scheduler tick failed');
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, everyMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
