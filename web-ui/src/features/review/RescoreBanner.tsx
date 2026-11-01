import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useFormat } from '../../lib/useFormat';
import { IconButton } from '../../ui/IconButton';
import { lastRescoreQuery } from './api';
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
 * accounts changed tier. Dismissed per person and per change. No `Open settings`: the Scoring weights tab is hidden.
 */
export function RescoreBanner({ tenant }: { tenant: string }) {
  const f = useFormat();
  const { data } = useQuery(lastRescoreQuery(tenant));
  const [dismissed, setDismissed] = useState<string | null>(null);
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
