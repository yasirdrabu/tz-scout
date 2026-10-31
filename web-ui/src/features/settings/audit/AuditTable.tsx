import type { ReactNode } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { Pill } from '../../../ui/Pill';
import table from '../../../ui/Table.module.css';
import styles from '../Settings.module.css';
import { areaLabel, type AuditEntry } from './api';

const whoOf = (e: AuditEntry) => e.actor_name ?? (e.actor_kind === 'system' ? 'Scout' : e.actor_id);

const targetOf = (e: AuditEntry) => [e.subject_type, e.subject_id].filter(Boolean).join(' ');

export function AuditTable({ entries, more }: { entries: AuditEntry[]; more: ReactNode }) {
  const f = useFormat();
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Area</th>
            <th scope="col">What happened</th>
            <th scope="col">IP address</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const target = targetOf(e);
            return (
              <tr key={e.id}>
                <td className={table.muted}>{f.dateTime(e.at)}</td>
                <td>
                  <div className={styles.personText}>
                    <span>{whoOf(e)}</span>
                    {e.support_access && <span className={table.muted}>Support access</span>}
                    {e.api_key_name && e.api_key_name !== e.actor_name && <span className={table.muted}>With key {e.api_key_name}</span>}
                  </div>
                </td>
                <td>
                  <Pill tone="accent">{areaLabel(e.area)}</Pill>
                </td>
                <td>
                  <span className={table.mono}>{e.action}</span>
                  {target && <span className={table.muted}> · {target}</span>}
                </td>
                <td className={table.mono}>{e.ip ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={table.foot}>
        <span>Showing {entries.length} events, newest first</span>
        {more}
      </div>
    </div>
  );
}
