import { useQuery } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { Pill } from '../../../ui/Pill';
import table from '../../../ui/Table.module.css';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { integrationsQuery, type Integration } from './api';
import { ManagePanel } from './ManagePanel';
import { callsText, modeText, statusOf, summaryOf } from './words';

/** §21b Integrations: the summary, services by group, and the manage panel for the open one. */
export function IntegrationsTab({ tenant, open, setOpen }: TabProps) {
  const list = useQuery(integrationsQuery(tenant));
  if (list.isPending) return <LoadingRows>Loading integrations</LoadingRows>;
  if (list.isError) return <LoadFailed title="Integrations didn't load" error={list.error} onRetry={() => void list.refetch()} />;
  const rows = list.data;
  if (rows.length === 0) {
    return (
      <EmptyState title="No services to connect" icon={<Plug />}>
        Scout has no services for this workspace yet.
      </EmptyState>
    );
  }

  const { line, issues } = summaryOf(rows);
  const groups = [...new Set(rows.map((r) => r.group))];
  const selected = open ? rows.find((r) => r.key === open) : undefined;
  return (
    <>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{line}</h2>
        {issues.length > 0 && (
          <ul className={styles.note}>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
      {groups.map((g) => (
        <Group key={g} name={g} rows={rows.filter((r) => r.group === g)} onOpen={setOpen} />
      ))}
      {selected && <ManagePanel service={selected} tenant={tenant} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function Group({ name, rows, onOpen }: { name: string; rows: Integration[]; onOpen: (key: string) => void }) {
  const f = useFormat();
  return (
    <section className={styles.section} aria-label={name}>
      <h3 className={styles.group}>{name}</h3>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Mode</th>
              <th scope="col">Status</th>
              <th scope="col">Last call</th>
              <th scope="col" className={table.num}>
                Calls today
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const status = statusOf(s);
              return (
                <tr key={s.key}>
                  <td>
                    <div className={styles.person}>
                      <span className={styles.logo} aria-hidden="true">
                        {s.name.charAt(0)}
                      </span>
                      <div className={styles.personText}>
                        <strong>{s.name}</strong>
                        <span className={table.muted}>{s.used_for}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Pill tone={s.mode === 'live' ? 'accent' : 'neutral'}>{modeText(s)}</Pill>
                  </td>
                  <td>
                    <Pill tone={status.tone}>{status.text}</Pill>
                  </td>
                  <td className={table.muted}>{s.last_call_at ? f.relative(s.last_call_at) : 'Never'}</td>
                  <td className={table.num}>{callsText(s, f.number)}</td>
                  <td className={table.actions}>
                    <Button size="sm" variant="secondary" aria-label={`${s.credentials.length > 0 ? 'Manage' : 'Connect'} ${s.name}`} onClick={() => onOpen(s.key)}>
                      {s.credentials.length > 0 ? 'Manage' : 'Connect'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
