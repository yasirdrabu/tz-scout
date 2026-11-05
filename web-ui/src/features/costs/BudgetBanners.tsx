import { useQuery } from '@tanstack/react-query';
import { hasScope, meQuery } from '../../api/me';
import { bannerLines, summaryQuery } from './api';
import styles from './Costs.module.css';

/** Budget alerts and pauses for people who can see costs: on the Costs screen and Settings › Integrations. */
export function BudgetBanners({ tenant }: { tenant: string }) {
  const me = useQuery(meQuery(tenant));
  const allowed = !!me.data && hasScope(me.data, 'costs:read');
  const summary = useQuery(summaryQuery(tenant, allowed));
  if (!allowed || !summary.data) return null;
  const lines = bannerLines(summary.data);
  if (lines.length === 0) return null;
  return (
    <ul className={styles.banners} aria-label="Budget alerts">
      {lines.map((l) => (
        <li key={l.key} className={l.paused ? styles.bannerPaused : styles.bannerAlert} role={l.paused ? 'alert' : 'status'}>
          {l.text}
        </li>
      ))}
    </ul>
  );
}
