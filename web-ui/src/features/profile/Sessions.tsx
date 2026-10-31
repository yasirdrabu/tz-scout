import { useQuery } from '@tanstack/react-query';
import { useFormat } from '../../lib/useFormat';
import table from '../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../settings/shared';
import styles from '../settings/Settings.module.css';
import { sessionsQuery } from './api';

/** The person's sessions still within the idle and age limits, newest activity first. */
export function Sessions() {
  const f = useFormat();
  const sessions = useQuery(sessionsQuery());
  if (sessions.isPending) return <LoadingRows rows={2}>Loading your sessions</LoadingRows>;
  if (sessions.isError) return <LoadFailed title="Your sessions didn't load" error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (sessions.data.length === 0) return <p className={styles.note}>No active sessions.</p>;
  return (
    <table className={table.table}>
      <thead>
        <tr>
          <th scope="col">Device</th>
          <th scope="col">IP address</th>
          <th scope="col">Signed in</th>
          <th scope="col">Last active</th>
        </tr>
      </thead>
      <tbody>
        {sessions.data.map((s) => (
          <tr key={s.id}>
            <td>
              <div className={styles.personText}>
                <span>{s.user_agent ?? 'Unknown device'}</span>
                {s.current && <span className={table.muted}>This device</span>}
              </div>
            </td>
            <td className={table.mono}>{s.ip ?? ''}</td>
            <td className={table.muted}>{f.dateTime(s.created_at)}</td>
            <td className={table.muted}>{s.last_active_at ? f.relative(s.last_active_at) : 'Not recorded'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
