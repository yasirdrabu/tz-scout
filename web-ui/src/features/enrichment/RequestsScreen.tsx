import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { hasScope, meQuery } from '../../api/me';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import table from '../../ui/Table.module.css';
import { Tabs } from '../../ui/Tabs';
import { LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { approveRequest, requestsQuery, type EnrichmentRequest } from './api';
import { DeclineDialog } from './DeclineDialog';
import styles from './Enrichment.module.css';
import { ageText, ALL_EMPTY, approvedText, WAITING_EMPTY } from './words';

const route = getRouteApi('/t/$tenant/enrichment');

const TABS = [
  { id: 'waiting', label: 'Waiting for approval' },
  { id: 'all', label: 'All' },
];

/** §22 Enrichment requests: what sellers and agents asked for, and for an approver Approve and Decline. */
export function RequestsScreen() {
  const { tenant } = route.useParams();
  const queryClient = useQueryClient();
  const approve = useRun();
  const { data: me } = useQuery(meQuery(tenant));
  const [tab, setTab] = useState('waiting');
  const [declining, setDeclining] = useState<EnrichmentRequest | null>(null);
  const waiting = tab === 'waiting';
  const list = useInfiniteQuery(requestsQuery(tenant, waiting ? 'flagged' : undefined));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const canDecide = !!me && me.kind === 'user' && hasScope(me, 'enrichment:approve');
  const actions = canDecide && waiting;

  async function approveRow(r: EnrichmentRequest) {
    const ok = await approve.run(() => approveRequest(tenant, r.id), approvedText(r.account_name ?? 'the account'));
    if (ok) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['enrichment-requests', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['account', tenant, r.account_id] }),
      ]);
    }
  }

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Enrichment</h1>
        <p className={page.sub}>Requests to find people, facts and signals for an account. A leader approves the ones that cost real credits.</p>
      </div>
      <Tabs label="Enrichment requests" tabs={TABS} value={tab} onChange={setTab} />

      {list.isPending ? (
        <LoadingRows>Loading enrichment requests</LoadingRows>
      ) : list.isError ? (
        <LoadFailed title="Enrichment requests didn't load" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={waiting ? 'Nothing waiting' : 'No requests'}>{waiting ? WAITING_EMPTY : ALL_EMPTY}</EmptyState>
      ) : (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">What</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Estimate</th>
                  <th scope="col">{waiting ? 'Age' : 'Status'}</th>
                  {actions && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: r.account_id }} className={styles.link}>
                        {r.account_name ?? r.account_id}
                      </Link>
                    </td>
                    <td>{r.kind_label}</td>
                    <td>{r.provider_name}</td>
                    <td>{r.requested_by_label}</td>
                    <td>{r.reason}</td>
                    <td>{r.estimate?.text}</td>
                    <td>{waiting ? ageText(r.created_at) : r.status_text}</td>
                    {actions && (
                      <td>
                        <div className={styles.rowActions}>
                          <Button size="sm" disabled={approve.busy} onClick={() => void approveRow(r)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setDeclining(r)}>
                            Decline
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.hasNextPage && (
            <Button variant="secondary" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </>
      )}
      {declining && <DeclineDialog tenant={tenant} request={declining} onClose={() => setDeclining(null)} />}
    </div>
  );
}
