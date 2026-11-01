import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { useSearchText } from '../../../lib/useSearchText';
import type { SourcePageSearch } from '../../../routes/workspace';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { FilterPopover, type FilterCategory } from '../../../ui/FilterPopover';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import { sourceAccountFacetsQuery, sourceAccountsQuery, type SourceAccountsFilters, type SourceDetail } from '../api';
import styles from '../Sources.module.css';

/** The source's accounts with search and Stage and Tier filters from the API, in the URL (C10). */
export function AccountsTab({ tenant, source: s }: { tenant: string; source: SourceDetail }) {
  const f = useFormat();
  const searchId = useId();
  const search: SourcePageSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const filters: SourceAccountsFilters = { q: search.q, stage: search.stage, tier: search.tier };
  const update = (patch: Partial<SourceAccountsFilters>, replace = false) =>
    void navigate({ to: '/t/$tenant/sources/$id/$tab', params: { tenant, id: s.id, tab: 'accounts' }, search: (prev: SourcePageSearch) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(filters.q ?? '', (q) => update({ q: q || undefined }, true));
  const list = useInfiniteQuery(sourceAccountsQuery(tenant, s.id, filters));
  const facets = useQuery(sourceAccountFacetsQuery(tenant, s.id, filters));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.total ?? rows.length;
  const categories: FilterCategory[] = [
    { key: 'stage', label: 'Stage', pick: 'one', options: facets.data?.stages.map((x) => ({ value: x.key, label: x.label, count: x.count })) ?? [] },
    { key: 'tier', label: 'Tier', pick: 'one', options: facets.data?.tiers ?? [] },
  ];
  const filtered = !!(search.q || search.stage || search.tier);

  return (
    <div className={styles.section}>
      <div className={styles.controls}>
        <label htmlFor={searchId} className="sr-only">
          Find an account
        </label>
        <input id={searchId} type="search" className={`input ${styles.search}`} placeholder="Find an account" value={text} onChange={(e) => setText(e.target.value)} />
        <FilterPopover
          categories={categories}
          value={{ stage: search.stage ? [search.stage] : [], tier: search.tier ? [search.tier] : [] }}
          onChange={(key, values) => update({ [key]: values[0] || undefined })}
          onClear={() => update({ stage: undefined, tier: undefined })}
        />
      </div>
      {list.isPending ? (
        <LoadingRows>Loading accounts</LoadingRows>
      ) : list.isError ? (
        <LoadFailed title="Accounts didn't load" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No accounts match"
            actions={
              <Button size="sm" variant="secondary" onClick={() => update({ q: undefined, stage: undefined, tier: undefined })}>
                Clear filters
              </Button>
            }
          >
            Try another stage or tier, or clear the filters.
          </EmptyState>
        ) : (
          <EmptyState title="No accounts yet">Accounts this source sends will show here with their stage and owner.</EmptyState>
        )
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Stage</th>
                <th scope="col">Tier</th>
                <th scope="col" className={table.num}>
                  Priority
                </th>
                <th scope="col">Best offer</th>
                <th scope="col">Came in through</th>
                <th scope="col">Owner</th>
                <th scope="col">Arrived</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account_id}>
                  <td>
                    <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: r.account_id }} search={{ from: 'all' }} className={styles.link}>
                      {r.name}
                    </Link>
                  </td>
                  <td>{r.stage_label ?? <span className={table.muted}>None</span>}</td>
                  <td>{r.tier_label ?? <span className={table.muted}>Not scored</span>}</td>
                  <td className={table.num}>{r.priority ?? <span className={table.muted}>Not scored</span>}</td>
                  <td>{r.lead_offer?.name ?? <span className={table.muted}>None yet</span>}</td>
                  <td>
                    {r.first_arrival ? [r.first_arrival.batch_name, r.first_arrival.source_name].filter(Boolean).join(' · ') : <span className={table.muted}>None</span>}
                  </td>
                  <td>{r.owner_name ?? <span className={table.muted}>None</span>}</td>
                  <td>{f.date(r.first_arrival?.at ?? r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={table.foot}>
            <span>{`Showing ${rows.length} of ${f.number(total)}`}</span>
            {list.hasNextPage && (
              <Button size="sm" variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Show more
              </Button>
            )}
            <span>Newest first</span>
          </div>
        </div>
      )}
    </div>
  );
}
