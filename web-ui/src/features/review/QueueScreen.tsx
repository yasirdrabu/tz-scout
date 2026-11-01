import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, isPlatformAdmin, meQuery, type Me } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import { useHeldRows } from '../../lib/useHeldRows';
import page from '../../routes/Page.module.css';
import { Button, buttonClass } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { FilterPopover, type FilterCategory } from '../../ui/FilterPopover';
import { LoadingLine } from '../../ui/LoadingLine';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { errorText } from '../settings/shared';
import { columnsQuery, facetsQuery, queueQuery, statusesQuery, type QueueFilters, type QueueRow } from './api';
import { AssignDialog } from './AssignDialog';
import { ColumnsPopover } from './ColumnsPopover';
import { PeekDrawer } from './PeekDrawer';
import { QueueTable } from './QueueTable';
import { RescoreBanner } from './RescoreBanner';
import styles from './Review.module.css';
import { SendBackDialog } from './SendBackDialog';

const route = getRouteApi('/t/$tenant/queue');

/** The API's bulk limit. */
const BULK_MAX = 50;

/** Search params the Filter popover owns, by category key. */
const FILTER_KEYS = ['practice', 'offer', 'source', 'status'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

type Refused = { account_id: string; name: string; message: string };

/** §2 Review queue. Filters, tier and the peek live in the URL (C10); rows refresh every 30 s behind the updates bar (C14). */
export function QueueScreen() {
  const { tenant } = route.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  if (!me) return null;
  return <Queue tenant={tenant} me={me} />;
}

function Queue({ tenant, me }: { tenant: string; me: Me }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const filters: QueueFilters = { tier: search.tier, practice: search.practice, offer: search.offer, source: search.source, status: search.status };
  const view = JSON.stringify(filters);

  const rowsQ = useInfiniteQuery(queueQuery(tenant, filters));
  const facets = useQuery(facetsQuery(tenant, filters));
  const columns = useQuery(columnsQuery(tenant));
  const statuses = useQuery(statusesQuery(tenant));

  const latest = useMemo(() => rowsQ.data?.pages.flatMap((p) => p.data), [rowsQ.data]);
  const held = useHeldRows(latest, view, (r: QueueRow) => r.account_id);
  const rows = held.rows;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [capped, setCapped] = useState(false);
  const [refused, setRefused] = useState<Refused[]>([]);
  const [sendBack, setSendBack] = useState<QueueRow[] | null>(null);
  const [assigning, setAssigning] = useState<QueueRow[] | null>(null);

  const update = (patch: Partial<typeof search>, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const setPeek = (id: string | undefined) => update({ peek: id });

  /** After the person's own change: the next rows show at once, counts and badges refresh. */
  async function refresh() {
    held.follow();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['review-queue', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['me-counts', tenant] }),
    ]);
  }

  const selectedRows = rows.filter((r) => selected.has(r.account_id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < BULK_MAX) next.add(id);
      return next;
    });
  function toggleAll() {
    const first = rows.slice(0, BULK_MAX);
    if (first.length > 0 && first.every((r) => selected.has(r.account_id))) {
      setSelected(new Set());
      setCapped(false);
      return;
    }
    setSelected(new Set(first.map((r) => r.account_id)));
    setCapped(rows.length > BULK_MAX);
  }
  const clearSelection = () => {
    setSelected(new Set());
    setCapped(false);
    setRefused([]);
  };

  /** Bulk or single result: what went stays out of the selection; what the API refused stays selected and listed. */
  function finished(done: string[], refusedNow: { account_id: string; message: string }[], from: QueueRow[]) {
    const names = new Map(from.map((r) => [r.account_id, r.name]));
    setSelected((s) => new Set([...s].filter((id) => !done.includes(id))));
    setRefused(refusedNow.map((r) => ({ ...r, name: names.get(r.account_id) ?? r.account_id })));
    // Assigned or sent back: it leaves the queue view now, before the API's read model catches up.
    held.drop(done);
    setCapped(false);
    if (search.peek && done.includes(search.peek)) {
      const i = rows.findIndex((r) => r.account_id === search.peek);
      const next = rows.slice(i + 1).find((r) => !done.includes(r.account_id)) ?? rows.slice(0, i).reverse().find((r) => !done.includes(r.account_id));
      update({ peek: next?.account_id }, true);
    }
    void refresh();
  }

  // Filter popover: categories and option counts from the API.
  const fx = facets.data;
  const categories: FilterCategory[] = [
    { key: 'practice', label: 'Practice', pick: 'one', options: fx?.practices ?? [] },
    { key: 'offer', label: 'Best offer', pick: 'one', options: fx?.offers ?? [] },
    { key: 'source', label: 'Source', pick: 'one', options: fx?.sources ?? [] },
    { key: 'status', label: 'Review status', pick: 'any', options: fx?.statuses ?? [] },
  ];
  const filterValue = Object.fromEntries(FILTER_KEYS.map((k) => [k, k === 'status' ? (search.status?.split(',').filter(Boolean) ?? []) : search[k] ? [search[k]!] : []]));
  const setFilter = (key: string, values: string[]) =>
    update({ [key as FilterKey]: (key === 'status' ? values.join(',') : values[0]) || undefined, peek: undefined });
  const clearFilters = () => update({ practice: undefined, offer: undefined, source: undefined, status: undefined, tier: undefined, peek: undefined });
  const filtered = !!(search.tier || search.practice || search.offer || search.source || search.status);

  // Tier tabs: All, every tier, and the lowest only when it has accounts (screens.md §2).
  const tiers = fx?.tiers ?? [];
  const tierTabs = [
    // "All" counts every tier: the API's total without the tier filter.
    { id: '', label: 'All', ...(fx ? { count: fx.total_all_tiers } : {}) },
    ...tiers.filter((t, i) => i < tiers.length - 1 || t.count > 0 || t.value === search.tier).map((t) => ({ id: t.value, label: t.label, count: t.count })),
  ];

  const total = fx?.total_all_tiers;
  const sources = fx?.source_count ?? 0;
  const loadingLine = sources === 0 ? 'Loading accounts' : `Loading accounts from ${sources === 1 ? '1 source' : `${f.number(sources)} sources`}`;
  const subtitle =
    total === undefined
      ? 'Loading accounts'
      : total === 0
        ? 'Nothing waiting for a decision.'
        : `${total === 1 ? '1 account' : `${f.number(total)} accounts`} waiting for a decision.${fx?.oldest_arrived_at ? ` Oldest arrived ${f.relative(fx.oldest_arrived_at)}.` : ''}`;

  const peekIndex = search.peek ? rows.findIndex((r) => r.account_id === search.peek) : -1;
  const peekRow = peekIndex >= 0 ? rows[peekIndex]! : null;
  const canImport = hasScope(me, 'imports:run');

  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>Review queue</h1>
          <p className={page.sub}>{subtitle}</p>
        </div>
        {canImport && (
          <Link to="/t/$tenant/batches" params={{ tenant }} className={buttonClass('secondary', 'sm')}>
            Import a list
          </Link>
        )}
      </div>

      <div className={styles.controls}>
        <Tabs label="Tier" variant="segmented" tabs={tierTabs} value={search.tier ?? ''} onChange={(id) => update({ tier: id || undefined, peek: undefined })} />
        <span className={styles.divider} aria-hidden="true" />
        <FilterPopover categories={categories} value={filterValue} onChange={setFilter} onClear={clearFilters} />
        <span className={styles.grow} />
        {columns.data && <ColumnsPopover tenant={tenant} columns={columns.data} />}
      </div>

      <RescoreBanner tenant={tenant} />

      {held.updates > 0 && (
        <div className={styles.updates} role="status">
          <span className={styles.grow}>{held.updates === 1 ? '1 update' : `${held.updates} updates`}</span>
          <Button size="sm" variant="secondary" onClick={held.apply}>
            Show
          </Button>
        </div>
      )}

      <div className={styles.card}>
        {selected.size > 0 && (
          <div className={styles.bulk} role="region" aria-label="Bulk actions">
            <span className={styles.bulkCount}>{`${selected.size} selected`}</span>
            {hasScope(me, 'assign:act') && (
              <Button size="sm" onClick={() => setAssigning(selectedRows)}>
                Assign to an AE
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setSendBack(selectedRows)}>
              Send back
            </Button>
            {capped && <span className={styles.muted}>Selected the first 50. Bulk actions take 50 accounts at a time.</span>}
            <button type="button" className={`${styles.textButton} ${styles.pushRight}`} onClick={clearSelection}>
              Clear selection
            </button>
          </div>
        )}
        {refused.length > 0 && (
          <div className={styles.refused} role="alert">
            {refused.length === 1 ? 'Scout could not do this for 1 account:' : `Scout could not do this for ${refused.length} accounts:`}
            <ul>
              {refused.map((r) => (
                <li key={r.account_id}>{`${r.name}: ${r.message}`}</li>
              ))}
            </ul>
          </div>
        )}

        {rowsQ.isError && !latest ? (
          <QueueError error={rowsQ.error} failedAt={rowsQ.errorUpdatedAt} me={me} onRetry={() => void rowsQ.refetch()} />
        ) : rowsQ.isPending || !columns.data ? (
          <div className={styles.loading}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={14} soft={i % 2 === 1} />
            ))}
            <LoadingLine>{loadingLine}</LoadingLine>
          </div>
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No accounts match these filters"
              actions={
                <Button size="sm" variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="The queue is clear"
              actions={
                <>
                  {canImport && (
                    <Link to="/t/$tenant/batches" params={{ tenant }} className={buttonClass('primary', 'sm')}>
                      Import a list
                    </Link>
                  )}
                  {hasScope(me, 'sources:manage') && (
                    <Link to="/t/$tenant/sources" params={{ tenant }} className={buttonClass('secondary', 'sm')}>
                      Manage sources
                    </Link>
                  )}
                </>
              }
              note={fx?.last_reviewed_at ? `Last account reviewed ${f.relative(fx.last_reviewed_at)}.` : undefined}
            >
              New accounts land here when a source sends them or someone imports a list. Each one arrives with a score, a best offer and a draft brief ready
              for your decision.
            </EmptyState>
          )
        ) : (
          <>
            <QueueTable
              rows={rows}
              columns={columns.data.columns}
              tiers={tiers}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              peek={search.peek}
              onOpen={(id) => setPeek(id)}
            />
            <div className={styles.foot}>
              <span>{`Showing ${rows.length} of ${f.number(facets.data?.total ?? rows.length)}`}</span>
              {rowsQ.hasNextPage && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={rowsQ.isFetchingNextPage}
                  onClick={() => {
                    held.follow();
                    void rowsQ.fetchNextPage();
                  }}
                >
                  Show more
                </Button>
              )}
              <span>Sorted by priority, highest first</span>
            </div>
          </>
        )}
      </div>

      {search.peek && (rowsQ.data || rowsQ.isError) && (
        <PeekDrawer
          tenant={tenant}
          me={me}
          accountId={search.peek}
          filters={filters}
          row={peekRow}
          position={peekRow ? { index: peekIndex + 1, total: facets.data?.total ?? rows.length } : null}
          onPrev={peekIndex > 0 ? () => update({ peek: rows[peekIndex - 1]!.account_id }, true) : undefined}
          onNext={peekIndex >= 0 && peekIndex < rows.length - 1 ? () => update({ peek: rows[peekIndex + 1]!.account_id }, true) : undefined}
          onClose={() => setPeek(undefined)}
          onAssign={(r) => setAssigning([r])}
          onSendBack={(r) => setSendBack([r])}
          onChanged={() => void refresh()}
          tiers={tiers}
          statuses={statuses.data?.data ?? []}
        />
      )}

      {sendBack && (
        <SendBackDialog
          tenant={tenant}
          accounts={sendBack}
          onClose={() => setSendBack(null)}
          onDone={(sent, refusedNow) => {
            setSendBack(null);
            finished(sent, refusedNow, sendBack);
          }}
        />
      )}
      {assigning && (
        <AssignDialog
          tenant={tenant}
          me={me}
          accounts={assigning}
          onClose={() => setAssigning(null)}
          onDone={(done, refusedNow) => {
            setAssigning(null);
            finished(done, refusedNow, assigning);
          }}
        />
      )}
    </div>
  );
}

function QueueError({ error, failedAt, me, onRetry }: { error: unknown; failedAt: number; me: Me; onRetry: () => void }) {
  const f = useFormat();
  const ref = error instanceof ApiError ? error.ref : null;
  return (
    <ErrorState
      title="The review queue didn't load"
      onRetry={onRetry}
      {...(ref ? { errorRef: `${ref} · ${f.dateTime(failedAt)}` } : {})}
      {...(isPlatformAdmin(me)
        ? {
            actions: (
              <Link to="/admin/health" className={buttonClass('secondary', 'sm')}>
                Open System health
              </Link>
            ),
          }
        : {})}
    >
      {`Scout couldn't reach its account store. Nothing was lost, and no decisions were changed. Try again in a moment. If it keeps failing, System health shows which queue is stuck.`}
      {error instanceof ApiError && error.status !== 0 && error.status < 500 ? ` ${errorText(error)}` : ''}
    </ErrorState>
  );
}
