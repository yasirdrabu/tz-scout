import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cx } from '../../../lib/cx';
import { useFormat } from '../../../lib/useFormat';
import page from '../../../routes/Page.module.css';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import table from '../../../ui/Table.module.css';
import { errorText, LoadFailed, LoadingRows, useRun } from '../../settings/shared';
import styles from '../Admin.module.css';
import {
  discardJob,
  healthQuery,
  pauseSchedule,
  resumeSchedule,
  retryJob,
  runScheduleNow,
  sendTestEvent,
  type DeadJob,
  type Health,
  type Schedule,
} from './api';

/** Relay lag at or over this is shown amber (target under 5 s). */
const LAG_TARGET_MS = 5_000;
/** A queue whose oldest message is older than this is shown amber. */
const OLD_MS = 5 * 60_000;

/** §24 System health: tiles, pending work by queue, dead jobs, schedules and the test event. */
export function HealthScreen() {
  const health = useQuery(healthQuery());
  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>System health</h1>
          <p className={page.sub}>All tenants · refreshed every 15 seconds</p>
        </div>
        <span className={styles.grow} />
        <TestEvent />
      </div>
      {health.data ? (
        <Body health={health.data} />
      ) : health.isError ? (
        <LoadFailed title="System health didn't load" error={health.error} onRetry={() => void health.refetch()} />
      ) : (
        <LoadingRows>Loading system health</LoadingRows>
      )}
    </div>
  );
}

function TestEvent() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const { round_trip_ms } = await sendTestEvent();
      setResult({ ok: true, text: `Round trip ${round_trip_ms} ms. Relay, queue and worker all answered.` });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.stack}>
      <Button variant="dark" onClick={() => void send()} disabled={busy}>
        Send test event
      </Button>
      <p role="status" className={cx(styles.note, result && !result.ok && styles.bad)}>
        {result?.text}
      </p>
    </div>
  );
}

function Body({ health }: { health: Health }) {
  const f = useFormat();
  const queues = health.queues.length;
  return (
    <>
      <div className={styles.tiles}>
        <Tile
          label="Relay lag"
          value={f.duration(health.relay_lag_ms)}
          note="Target under 5 s"
          warn={health.relay_lag_ms >= LAG_TARGET_MS}
        />
        <Tile
          label="Pending work"
          value={f.number(health.pending_total)}
          note={health.queues_available ? `Across ${queues} ${queues === 1 ? 'queue' : 'queues'}` : 'Queues unavailable'}
        />
        <Tile
          label="Dead jobs"
          value={f.number(health.dead_job_count)}
          note={health.dead_job_count > 0 ? 'Need a decision' : 'None'}
          warn={health.dead_job_count > 0}
        />
        <Tile label="AI spend today" value={f.money(health.ai_spend_today_cents)} note="All tenants" />
      </div>
      <Queues health={health} />
      <DeadJobs jobs={health.dead_jobs} total={health.dead_job_count} />
      <Schedules schedules={health.schedules} />
    </>
  );
}

function Tile({ label, value, note, warn = false }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={cx(styles.tileValue, warn && styles.warn)}>{value}</div>
      <div className={styles.tileNote}>{note}</div>
    </div>
  );
}

function Queues({ health }: { health: Health }) {
  const f = useFormat();
  return (
    <section className={styles.section} aria-labelledby="queues">
      <h2 id="queues" className={styles.sectionTitle}>
        Pending work by queue
      </h2>
      {!health.queues_available ? (
        <p className={styles.note}>Queue details are unavailable right now.</p>
      ) : health.queues.length === 0 ? (
        <p className={styles.note}>No queues yet.</p>
      ) : (
        <ul className={styles.list}>
          {health.queues.map((q) => {
            const count = q.pending + q.ack_pending;
            const old = q.oldest_age_ms !== null && q.oldest_age_ms > OLD_MS;
            return (
              <li key={q.name} className={styles.item}>
                <span className={cx(table.mono, styles.grow)}>{q.name}</span>
                <strong>{f.number(count)}</strong>
                <span className={cx(styles.note, old && styles.warn)}>
                  {count === 0 ? 'Empty' : q.oldest_age_ms === null ? 'Oldest unknown' : `Oldest ${f.duration(q.oldest_age_ms)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DeadJobs({ jobs, total }: { jobs: DeadJob[]; total: number }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [discarding, setDiscarding] = useState<DeadJob | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: healthQuery().queryKey });

  async function discard(job: DeadJob) {
    const ok = await run(async () => {
      await discardJob(job.id);
      await refresh();
    }, `${job.id} discarded`);
    if (ok) setDiscarding(null);
  }

  return (
    <section className={styles.section} aria-labelledby="dead-jobs">
      <h2 id="dead-jobs" className={styles.sectionTitle}>
        Dead jobs
      </h2>
      {jobs.length === 0 ? (
        <p className={styles.note}>No dead jobs. Jobs that fail every try show here so you can retry or discard them.</p>
      ) : (
        <>
          <ul className={styles.list}>
            {jobs.map((j) => (
              <li key={j.id} className={styles.item}>
                <div className={cx(styles.stack, styles.grow)}>
                  <span className={table.mono}>{j.id}</span>
                  <span className={styles.note}>
                    {j.name} · {j.tenant_name ?? j.tenant_id} · {f.dateTime(j.dead_at)}
                  </span>
                  <span className={styles.note}>Failed {j.attempts} times and stopped retrying</span>
                  {j.last_error && <span>{j.last_error}</span>}
                </div>
                <div className={styles.row}>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Retry ${j.id}`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await retryJob(j.id);
                        await refresh();
                      }, `${j.id} sent back to ${j.name}`)
                    }
                  >
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Discard ${j.id}`} disabled={busy} onClick={() => setDiscarding(j)}>
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {total > jobs.length && (
            <p className={styles.note}>
              Showing the newest {jobs.length} of {f.number(total)}
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={discarding !== null}
        onOpenChange={(o) => !o && setDiscarding(null)}
        title={`Discard ${discarding?.id ?? 'this job'}?`}
        description="Scout deletes the job and never runs it again."
        confirmLabel="Discard"
        busy={busy}
        onConfirm={() => discarding && void discard(discarding)}
      />
    </section>
  );
}

function Schedules({ schedules }: { schedules: Schedule[] }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const act = (action: () => Promise<unknown>, done: string) =>
    void run(async () => {
      await action();
      await queryClient.invalidateQueries({ queryKey: healthQuery().queryKey });
    }, done);

  return (
    <section className={styles.section} aria-labelledby="schedules">
      <h2 id="schedules" className={styles.sectionTitle}>
        Schedules
      </h2>
      {schedules.length === 0 ? (
        <p className={styles.note}>No schedules yet.</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Cadence</th>
                <th scope="col">Next run</th>
                <th scope="col">Last run</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => {
                const where = s.tenant_name ?? s.tenant_id;
                return (
                  <tr key={s.id}>
                    <td>
                      <div className={styles.stack}>
                        <strong>{s.job_name}</strong>
                        <span className={table.muted}>{where}</span>
                      </div>
                    </td>
                    <td>
                      <span className={table.mono}>{s.cron}</span> <span className={table.muted}>{s.timezone}</span>
                    </td>
                    <td className={table.muted}>{!s.enabled ? 'Paused' : s.next_run_at ? f.dateTime(s.next_run_at) : 'Not planned'}</td>
                    <td className={table.muted}>{s.last_run_at ? f.dateTime(s.last_run_at) : 'Never'}</td>
                    <td>
                      <div className={table.actions}>
                        {s.enabled ? (
                          <Button size="sm" variant="secondary" aria-label={`Pause ${s.job_name} for ${where}`} disabled={busy} onClick={() => act(() => pauseSchedule(s.id), `${s.job_name} paused`)}>
                            Pause
                          </Button>
                        ) : (
                          <Button size="sm" variant="secondary" aria-label={`Resume ${s.job_name} for ${where}`} disabled={busy} onClick={() => act(() => resumeSchedule(s.id), `${s.job_name} resumed`)}>
                            Resume
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Run ${s.job_name} for ${where} now`} disabled={busy} onClick={() => act(() => runScheduleNow(s.id), `${s.job_name} started`)}>
                          Run now
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
