import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useId } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useSearchText } from '../../lib/useSearchText';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { FilterPopover, type FilterCategory } from '../../ui/FilterPopover';
import { Tabs } from '../../ui/Tabs';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { directoryQuery, sourcesQuery } from '../sources/api';
import { batchesQuery, type BatchesFilters, type BatchStatusKey } from './api';
import styles from './Batches.module.css';
import { BatchesTable } from './BatchesTable';

const route = getRouteApi('/t/$tenant/batches');

const STATUS_ORDER: BatchStatusKey[] = ['complete', 'in_progress', 'needs_attention', 'failed'];
const RUN_DATES = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
];
const KEYS = { status: 'status', source: 'source', sentBy: 'sentBy', runDate: 'runDate' } as const;

/** §13 Batches and imports: the attention banner, search and filters in the URL (C10), and the table. */
export function BatchesScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const go = useNavigate();
  const searchId = useId();
  const { data: me } = useQuery(meQuery(tenant));
  const filters: BatchesFilters = { status: search.status, source: search.source, sentBy: search.sentBy, runDate: search.runDate, q: search.q };
  const update = (patch: Partial<BatchesFilters>, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(filters.q ?? '', (q) => update({ q: q || undefined }, true));

  const list = useInfiniteQuery(batchesQuery(tenant, filters));
  const sources = useQuery(sourcesQuery(tenant));
  const members = useQuery({ ...directoryQuery(tenant), enabled: !!me && (hasScope(me, 'imports:run') || hasScope(me, 'sources:manage') || hasScope(me, 'members:read')) });
  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const canImport = !!me && hasScope(me, 'imports:run');

  const categories: FilterCategory[] = [
    {
      key: KEYS.status,
      label: 'Status',
      pick: 'any',
      options: first ? STATUS_ORDER.map((k) => ({ value: k, label: first.meta.status_labels[k], count: first.meta.counts_by_status[k] })) : [],
    },
    { key: KEYS.source, label: 'Source', pick: 'one', options: (sources.data?.data ?? []).map((s) => ({ value: s.id, label: s.name })) },
    { key: KEYS.sentBy, label: 'Sent by', pick: 'one', options: (members.data ?? []).map((m) => ({ value: m.user_id, label: m.name })) },
    { key: KEYS.runDate, label: 'Run date', pick: 'one', options: RUN_DATES },
  ];
  const value = {
    status: search.status ? search.status.split(',') : [],
    source: search.source ? [search.source] : [],
    sentBy: search.sentBy ? [search.sentBy] : [],
    runDate: search.runDate ? [search.runDate] : [],
  };
  const onFilter = (key: string, values: string[]) => {
    const joined = values.length ? values.join(',') : undefined;
    update({ [key]: joined } as Partial<BatchesFilters>);
  };
  const clear = () => update({ status: undefined, source: undefined, sentBy: undefined, runDate: undefined, q: undefined });
  const filtered = !!(search.status || search.source || search.sentBy || search.runDate || search.q);
  const attention = first?.meta.attention;

  const tabs = [
    { id: 'batches', label: 'Batches', ...(first ? { count: first.total } : {}) },
    ...(canImport ? [{ id: 'import', label: 'Import a list' }] : []),
  ];

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Batches and imports</h1>
        <p className={page.sub}>Every delivery from a source or a list you bring in. Scout matches each account, scores it and sends it to review.</p>
      </div>
      <Tabs label="Batches and imports" tabs={tabs} value="batches" onChange={(id) => id === 'import' && void go({ to: '/t/$tenant/batches/import', params: { tenant } })} />

      {attention && attention.count > 0 && (
        <div className={styles.banner} role="status">
          <div>
            <p className={styles.bannerTitle}>{attention.count === 1 ? '1 batch needs attention' : `${attention.count} batches need attention`}</p>
            {attention.issues.length > 0 && <p className={styles.bannerText}>{attention.issues.join(' ')}</p>}
          </div>
          <Button size="sm" variant="secondary" onClick={() => update({ status: 'needs_attention,failed' })}>
            Show them
          </Button>
        </div>
      )}

      <div className={styles.controls}>
        <label htmlFor={searchId} className="sr-only">
          Find by batch, file or notes
        </label>
        <input id={searchId} type="search" className={`input ${styles.search}`} placeholder="Find by batch, file or notes" value={text} onChange={(e) => setText(e.target.value)} />
        <FilterPopover categories={categories} value={value} onChange={onFilter} onClear={() => update({ status: undefined, source: undefined, sentBy: undefined, runDate: undefined })} />
      </div>

      {list.isPending ? (
        <LoadingRows>Loading batches</LoadingRows>
      ) : list.isError ? (
        <LoadFailed title="Batches didn't load" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No batches match"
            actions={
              <Button size="sm" variant="secondary" onClick={clear}>
                Clear filters
              </Button>
            }
          >
            Try another status or source, or clear the filters.
          </EmptyState>
        ) : (
          <EmptyState title="No batches yet">Batches appear when a source sends accounts or someone imports a list.</EmptyState>
        )
      ) : (
        <>
          <BatchesTable tenant={tenant} rows={rows} canRetry={canImport} />
          {list.hasNextPage && (
            <Button variant="secondary" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Show more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
