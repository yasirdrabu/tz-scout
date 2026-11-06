import { useFormat } from '../../lib/useFormat';
import type { SourceStat } from './api';
import styles from './Sources.module.css';

/** Sent, Reviewed, Assigned, Won, Trust and (with costs:read) Cost per win, with the API's percentages (C8). */
export function StatTiles({ stat, trust, showCost }: { stat: SourceStat | undefined; trust: string; showCost: boolean }) {
  const f = useFormat();
  const costPerWin = !stat ? '' : stat.spend_cents === 0 ? 'Not tracked' : stat.won === 0 || stat.cost_per_won_cents === null ? 'None yet' : f.money(stat.cost_per_won_cents);
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
        <span className={styles.statValueWords}>{trust}</span>
      </li>
      {showCost && (
        <li className={styles.stat}>
          <span className={styles.statLabel}>Cost per win</span>
          <span className={styles.statValueWords}>{costPerWin}</span>
        </li>
      )}
    </ul>
  );
}
