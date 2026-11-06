import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useFormat } from '../../lib/useFormat';
import { Card } from '../../ui/Card';
import table from '../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { bySourceQuery } from './api';
import styles from './Costs.module.css';

const DASH = '—';

/** "Cost by source" (R3b-1 Ruling 12): top-level sources over the last 90 days, then Shared costs; a row opens the funnel drill. */
export function CostBySource({ tenant }: { tenant: string }) {
  const f = useFormat();
  const by = useQuery(bySourceQuery(tenant));
  const money = (cents: number | null | undefined) => (cents == null ? DASH : f.money(cents));
  return (
    <Card title="Cost by source">
      {by.isPending ? (
        <LoadingRows rows={3}>Loading cost by source</LoadingRows>
      ) : by.isError ? (
        <LoadFailed title="Cost by source didn't load" error={by.error} onRetry={() => void by.refetch()} />
      ) : (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col" className={table.num}>
                    Spend
                  </th>
                  <th scope="col" className={table.num}>
                    Share
                  </th>
                  <th scope="col" className={table.num}>
                    Per account sent
                  </th>
                  <th scope="col" className={table.num}>
                    Per assigned
                  </th>
                  <th scope="col" className={table.num}>
                    Per won account
                  </th>
                  <th scope="col" className={table.num}>
                    Return
                  </th>
                </tr>
              </thead>
              <tbody>
                {by.data.rows.map((r) => (
                  <tr key={r.source_id ?? 'shared'}>
                    <td>
                      {r.source_id ? (
                        <Link to="/t/$tenant/funnel/$sourceId" params={{ tenant, sourceId: r.source_id }} className={table.open}>
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </td>
                    <td className={table.num}>{f.money(r.spend_cents)}</td>
                    <td className={table.num}>{r.share_pct == null ? DASH : `${r.share_pct}%`}</td>
                    <td className={table.num}>{money(r.per_sent_cents)}</td>
                    <td className={table.num}>{money(r.per_assigned_cents)}</td>
                    <td className={table.num}>{money(r.per_won_cents)}</td>
                    <td className={table.num}>{r.return_ratio == null ? DASH : `${r.return_ratio}x`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>Return is the value of won deals divided by spend. Won value is what each deal closed at.</p>
        </>
      )}
    </Card>
  );
}
