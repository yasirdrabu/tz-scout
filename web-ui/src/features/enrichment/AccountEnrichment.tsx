import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { accountRequestsQuery, RUNNING_REFRESH_MS } from './api';
import styles from './Enrichment.module.css';
import { isRunning, shownInNotice } from './words';

/**
 * The notice under the account card: one line per open or recent request, refreshed while one runs. When a request
 * stops running, the rest of the account (its people, facts and score) is read again, so what it found shows.
 */
export function AccountEnrichment({ tenant, id }: { tenant: string; id: string }) {
  const queryClient = useQueryClient();
  const requests = useQuery({
    ...accountRequestsQuery(tenant, id),
    refetchInterval: (q) => (q.state.data?.data.some(isRunning) ? RUNNING_REFRESH_MS : false),
  });
  const running = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!requests.data) return;
    const now = new Set(requests.data.data.filter(isRunning).map((r) => r.id));
    const finished = [...running.current].some((r) => !now.has(r));
    running.current = now;
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: ['account', tenant, id], predicate: (q) => q.queryKey[3] !== 'enrichment-requests' });
    }
  }, [requests.data, queryClient, tenant, id]);

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
