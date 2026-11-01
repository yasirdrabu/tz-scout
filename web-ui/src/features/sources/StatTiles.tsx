import { useFormat } from '../../lib/useFormat';
import type { SourceStat } from './api';
import styles from './Sources.module.css';

/** Sent, Reviewed, Assigned, Won and Trust, with the API's percentages (C8). Cost per win is R3, so it is left out (C9). */
export function StatTiles({ stat, trustLabel }: { stat: SourceStat | undefined; trustLabel: string }) {
  const f = useFormat();
  const tile = (label: string, value: number | undefined, sub: string | null) => (
    <li className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value === undefined ? '' : f.number(value)}</span>
      {sub && <span className={styles.note}>{sub}</span>}
    </li>
  );
  const pct = (n: number | null | undefined, of: string) => (n === null || n === undefined ? null : `${n}% of ${of}`);
  return (
    <ul className={styles.tiles} aria-label="Source numbers">
      {tile('Sent', stat?.sent, 'All time')}
      {tile('Reviewed', stat?.reviewed, pct(stat?.reviewed_pct, 'sent'))}
      {tile('Assigned', stat?.assigned, pct(stat?.assigned_pct, 'reviewed'))}
      {tile('Won', stat?.won, pct(stat?.won_pct, 'assigned'))}
      <li className={styles.stat}>
        <span className={styles.statLabel}>Trust</span>
        <span className={styles.statValueWords}>{trustLabel}</span>
      </li>
    </ul>
  );
}
