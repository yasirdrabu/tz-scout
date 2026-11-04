import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EmptyState } from '../../ui/EmptyState';
import { buttonClass } from '../../ui/Button';
import { Pill } from '../../ui/Pill';
import table from '../../ui/Table.module.css';
import { offersQuery } from '../offers/api';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { NotYet } from './NotYet';
import { mix, playbooksQuery, span, STATUS_WORD, statusTone, TIER_WORD } from './api';
import styles from './Playbooks.module.css';

/** §20 list: every playbook, any status, with what it runs on. Rates are R3. */
export function PlaybookList({ tenant, canManage }: { tenant: string; canManage: boolean }) {
  const playbooks = useQuery(playbooksQuery(tenant));
  const offers = useQuery(offersQuery(tenant));

  if (playbooks.isPending) return <LoadingRows>Loading playbooks</LoadingRows>;
  if (playbooks.isError) return <LoadFailed title="Playbooks didn't load" error={playbooks.error} onRetry={() => void playbooks.refetch()} />;
  if (!playbooks.data.length) {
    return (
      <EmptyState
        title="No playbooks yet"
        actions={
          canManage ? (
            <Link to="/t/$tenant/playbooks" params={{ tenant }} search={{ edit: 'new' }} className={buttonClass()}>
              New playbook
            </Link>
          ) : undefined
        }
      >
        {canManage ? 'Add a playbook, then pick it for an offer and tier.' : 'Playbooks show here once someone adds them.'}
      </EmptyState>
    );
  }
  const offerName = (id: string) => offers.data?.find((o) => o.id === id)?.name ?? 'Unknown offer';

  return (
    <>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Playbook</th>
              <th scope="col">Status</th>
              <th scope="col">Steps</th>
              <th scope="col">Runs on</th>
              <th scope="col" className={table.num}>
                Running
              </th>
              <th scope="col" className={table.num}>
                Reply rate
              </th>
              <th scope="col" className={table.num}>
                Meeting rate
              </th>
            </tr>
          </thead>
          <tbody>
            {playbooks.data.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to="/t/$tenant/playbooks/$id" params={{ tenant, id: p.id }} className={styles.name}>
                    {p.name}
                  </Link>
                  {p.description && <div className={styles.meta}>{p.description}</div>}
                </td>
                <td>
                  <Pill tone={statusTone(p.status)}>{STATUS_WORD[p.status]}</Pill>
                </td>
                <td>
                  <div>{span(p.steps, p.days)}</div>
                  <div className={styles.meta}>{mix(p.channels)}</div>
                </td>
                <td>
                  {p.runs_on.length ? (
                    <ul className={styles.runsOn}>
                      {p.runs_on.map((r) => (
                        <li key={`${r.offer_id}:${r.tier}`}>
                          {offers.isPending ? '' : `${offerName(r.offer_id)} · `}{TIER_WORD[r.tier]}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={table.muted}>Not assigned</span>
                  )}
                </td>
                <td className={table.num}>{p.running}</td>
                <td className={table.num}>
                  <NotYet />
                </td>
                <td className={table.num}>
                  <NotYet />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>Reply and meeting rates are for accounts that finished the playbook in the last 90 days.</p>
    </>
  );
}
