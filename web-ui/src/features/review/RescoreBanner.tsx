import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import { buttonClass } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { lastRescoreQuery, rescoreQuery } from './api';
import styles from './Review.module.css';

const storageKey = (tenant: string, version: number) => `scout:rescore-banner:${tenant}:${version}`;

function wasDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Storage blocked: it stays dismissed until the page reloads.
  }
}

/**
 * §2 banner after a scoring settings change (Ruling 16): the API's summary, who and when, the weights and how many
 * accounts changed tier, and `Open settings` for those who manage scoring. Dismissed per person and per change.
 * While a rescore runs (Ruling 12) it shows the run's progress instead, asking again every 3 seconds; when the run
 * finishes the summary is loaded again, so it counts what the rescore moved.
 */
export function RescoreBanner({ tenant }: { tenant: string }) {
  const f = useFormat();
  const qc = useQueryClient();
  const { data } = useQuery(lastRescoreQuery(tenant));
  const { data: run } = useQuery(rescoreQuery(tenant));
  const { data: me } = useQuery(meQuery(tenant));
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A run that has found no accounts yet, or has stalled, shows the summary instead.
  const running = !!run && !run.finished_at && !run.stalled && run.total > 0;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: lastRescoreQuery(tenant).queryKey });
    wasRunning.current = running;
  }, [running, qc, tenant]);

  if (running) {
    return (
      <div className={styles.banner} role="region" aria-label="Rescore progress">
        <span className={styles.grow}>
          <strong>{`Rescoring ${run.total === 1 ? '1 account' : `${f.number(run.total)} accounts`}`}</strong>
          <span>{`${f.number(run.done)} of ${f.number(run.total)} rescored`}</span>
        </span>
      </div>
    );
  }
  if (!data) return null;
  const key = storageKey(tenant, data.version);
  if (dismissed === key || wasDismissed(key)) return null;

  const n = data.tier_changed_count;
  const moved = n === 0 ? '' : ` ${n === 1 ? '1 account' : `${f.number(n)} accounts`} changed tier.`;
  return (
    <div className={styles.banner} role="region" aria-label="Scoring change">
      <span className={styles.grow}>
        <strong>{`${data.summary} · ${f.relative(data.changed_at)}${data.changed_by_name ? ` by ${data.changed_by_name}` : ''}`}</strong>
        <span>{`Priorities were recalculated with ${data.weights_text}.${moved}`}</span>
      </span>
      {me && hasScope(me, 'scoring:manage') && (
        <Link to="/t/$tenant/settings/$tab" params={{ tenant, tab: 'scoring-weights' }} className={buttonClass('secondary', 'sm')}>
          Open settings
        </Link>
      )}
      <IconButton
        label="Dismiss"
        onClick={() => {
          remember(key);
          setDismissed(key);
        }}
      >
        <X />
      </IconButton>
    </div>
  );
}
