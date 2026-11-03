import { useQuery } from '@tanstack/react-query';
import { accountRequestsQuery, RUNNING_REFRESH_MS } from './api';
import styles from './Enrichment.module.css';
import { isRunning, shownInNotice } from './words';

/** The notice under the account card: one line per open or recent request, refreshed while one runs. */
export function AccountEnrichment({ tenant, id }: { tenant: string; id: string }) {
  const requests = useQuery({
    ...accountRequestsQuery(tenant, id),
    refetchInterval: (q) => (q.state.data?.data.some(isRunning) ? RUNNING_REFRESH_MS : false),
  });
  const shown = (requests.data?.data ?? []).filter((r) => shownInNotice(r));
  if (shown.length === 0) return null;
  return (
    <ul className={styles.notice} aria-label="Enrichment">
      {shown.map((r) => (
        <li key={r.id}>{`${r.kind_label} from ${r.provider_name}: ${r.status_text}`}</li>
      ))}
    </ul>
  );
}
