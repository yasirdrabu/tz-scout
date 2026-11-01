import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import table from '../../ui/Table.module.css';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import { errorText, LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { batchItemsQuery, batchQuery, downloadFile, saveBlob, skipWaiting, type ItemTab } from './api';
import styles from './Batches.module.css';
import { sentByText } from './BatchesTable';
import { WaitingForm } from './WaitingForms';

const route = getRouteApi('/t/$tenant/batches/$id');
const TABS: ItemTab[] = ['all', 'waiting', 'resolved', 'rejected'];

/** §14 Batch detail: the summary, the items by tab (in the URL, C10) and the forms for the waiting rows. */
export function BatchDetail() {
  const { tenant, id } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const tab: ItemTab = TABS.find((t) => t === search.tab) ?? 'all';
  const { data: me } = useQuery(meQuery(tenant));
  const batch = useQuery(batchQuery(tenant, id));
  const items = useInfiniteQuery(batchItemsQuery(tenant, id, tab));
  const skip = useRun();
  const [skipping, setSkipping] = useState(false);
  const canResolve = !!me && hasScope(me, 'imports:run');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['batches', tenant] });

  if (batch.isPending) return <div className={page.page}><LoadingRows>Loading the batch</LoadingRows></div>;
  if (batch.isError) {
    return (
      <div className={page.page}>
        <LoadFailed title="This batch didn't load" error={batch.error} onRetry={() => void batch.refetch()} />
      </div>
    );
  }
  const b = batch.data;
  const file = b.files[0];
  const sub = [sentByText(b), `Run ${f.date(b.run_at)}`, file?.file_name].filter(Boolean).join(' · ');
  const rows = items.data?.pages.flatMap((p) => p.data) ?? [];
  const tabs = [
    { id: 'all', label: 'All', count: b.item_count },
    { id: 'waiting', label: 'Waiting', count: b.stages.waiting },
    { id: 'resolved', label: 'Resolved', count: b.stages.resolved },
    { id: 'rejected', label: 'Rejected', count: b.stages.rejected },
  ];

  async function getFile() {
    if (!file) return;
    try {
      saveBlob(await downloadFile(tenant, b.id, file.id), file.file_name);
    } catch (e) {
      toast.show(errorText(e));
    }
  }

  async function skipRows() {
    const ok = await skip.run(() => skipWaiting(tenant, b.id), (r) => `Skipped ${r.skipped} rows.`);
    setSkipping(false);
    if (ok) refresh();
  }

  return (
    <div className={page.page}>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>
            <Link to="/t/$tenant/batches" params={{ tenant }}>
              Batches
            </Link>
          </li>
          <li aria-current="page">{b.id}</li>
        </ol>
      </nav>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{b.notes ?? b.name}</h1>
          <p className={styles.meta}>{sub}</p>
        </div>
        {file && (
          <Button size="sm" variant="secondary" onClick={() => void getFile()}>
            Download file
          </Button>
        )}
      </div>
      <ul className={styles.summary} aria-label="Batch summary">
        <li>{`${f.number(b.stages.resolved)} resolved`}</li>
        <li>{`${f.number(b.stages.rejected)} rejected`}</li>
        <li>{`${f.number(b.stages.waiting)} waiting on you`}</li>
        {b.in_queue !== null && <li>{`${f.number(b.in_queue)} in the review queue`}</li>}
      </ul>
      {b.issue && <p className={styles.issue}>{b.issue}</p>}

      <Tabs label="Rows" tabs={tabs} value={tab} onChange={(next) => void navigate({ search: (prev) => ({ ...prev, tab: next === 'all' ? undefined : next }), replace: true })}>
        {items.isPending ? (
          <LoadingRows>Loading rows</LoadingRows>
        ) : items.isError ? (
          <LoadFailed title="The rows didn't load" error={items.error} onRetry={() => void items.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here">{tab === 'waiting' ? 'No rows are waiting on you.' : 'No rows in this tab.'}</EmptyState>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Website</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={table.num}>
                    Priority
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>
                        {r.account_id && r.account_name ? (
                          <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: r.account_id }} className={styles.link}>
                            {r.account_name}
                          </Link>
                        ) : (
                          (r.company_name ?? '')
                        )}
                      </td>
                      <td>{r.website ?? ''}</td>
                      <td>{r.outcome_label}</td>
                      <td className={table.num}>{r.priority === null ? '' : f.number(r.priority)}</td>
                    </tr>
                    {canResolve && r.outcome === 'waiting' && (
                      <tr>
                        <td colSpan={4}>
                          <WaitingForm tenant={tenant} item={r} onResolved={refresh} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items.hasNextPage && (
          <Button variant="secondary" size="sm" disabled={items.isFetchingNextPage} onClick={() => void items.fetchNextPage()}>
            Show more
          </Button>
        )}
      </Tabs>

      <div className={styles.head}>
        <p className={styles.foot}>Rows still waiting after 30 days are rejected.</p>
        {canResolve && b.stages.waiting > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSkipping(true)}>
            Skip the waiting rows
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={skipping}
        onOpenChange={setSkipping}
        title={`Skip ${b.stages.waiting} waiting rows?`}
        description="They're rejected and won't reach review."
        confirmLabel="Skip the waiting rows"
        busy={skip.busy}
        onConfirm={() => void skipRows()}
      />
    </div>
  );
}
