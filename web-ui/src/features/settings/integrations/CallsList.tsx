import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import table from '../../../ui/Table.module.css';
import { Tabs } from '../../../ui/Tabs';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { callsQuery } from './api';

/** Last 50 calls: All or Errors only, with time, operation, result, status code and ms. */
export function CallsList({ tenant, serviceKey }: { tenant: string; serviceKey: string }) {
  const [view, setView] = useState('all');
  const errorsOnly = view === 'errors';
  return (
    <section className={styles.section} aria-label="Last 50 calls">
      <h3 className={styles.sectionTitle}>Last 50 calls</h3>
      <Tabs
        label="Calls"
        size="sm"
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'errors', label: 'Errors only' },
        ]}
        value={view}
        onChange={setView}
      >
        <Calls tenant={tenant} serviceKey={serviceKey} errorsOnly={errorsOnly} />
      </Tabs>
    </section>
  );
}

function Calls({ tenant, serviceKey, errorsOnly }: { tenant: string; serviceKey: string; errorsOnly: boolean }) {
  const f = useFormat();
  const calls = useQuery(callsQuery(tenant, serviceKey, errorsOnly));
  if (calls.isPending) return <LoadingRows rows={2}>Loading calls</LoadingRows>;
  if (calls.isError) return <LoadFailed title="Calls didn't load" error={calls.error} onRetry={() => void calls.refetch()} />;
  if (calls.data.length === 0) return <p className={styles.note}>{errorsOnly ? 'No errors in the last 50 calls.' : 'No calls yet.'}</p>;
  return (
    <table className={table.table}>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Operation</th>
          <th scope="col">Result</th>
          <th scope="col" className={table.num}>
            Code
          </th>
          <th scope="col" className={table.num}>
            ms
          </th>
        </tr>
      </thead>
      <tbody>
        {calls.data.map((c) => (
          <tr key={c.id}>
            <td className={table.muted}>{f.dateTime(c.at)}</td>
            <td>
              <span className={table.mono}>{c.operation}</span>
              {c.error_message && <div className={styles.danger}>{c.error_message}</div>}
            </td>
            <td>{c.outcome}</td>
            <td className={table.num}>{c.status_code ?? ''}</td>
            <td className={table.num}>{c.duration_ms === null ? '' : f.number(c.duration_ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
