import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { formatMoney } from '../../lib/format';
import { useFormat } from '../../lib/useFormat';
import { useSearchText } from '../../lib/useSearchText';
import page from '../../routes/Page.module.css';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { FilterPopover, type FilterCategory } from '../../ui/FilterPopover';
import table from '../../ui/Table.module.css';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import { kindAndPlace } from '../review/parts';
import { errorText, LoadFailed, LoadingRows } from '../settings/shared';
import { accountFacetsQuery, accountsQuery, activityText, exportAccounts, type AccountRow, type AccountsFilters } from './api';
import styles from './Accounts.module.css';

const route = getRouteApi('/t/$tenant/accounts');

/** Hands the CSV to the browser as a download. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** §8 All accounts: stage tabs and counts from the API, search, filters and Export CSV; the URL carries them (C10). */
export function AllAccountsScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const f = useFormat();
  const toast = useToast();
  const searchId = useId();
  const [exporting, setExporting] = useState(false);
  const filters: AccountsFilters = { stage: search.stage, q: search.q, owner: search.owner, practice: search.practice, source: search.source };
  const update = (patch: Partial<AccountsFilters>, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(filters.q ?? '', (q) => update({ q: q || undefined }, true));

  const list = useInfiniteQuery(accountsQuery(tenant, filters));
  const facets = useQuery(accountFacetsQuery(tenant, filters));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.total;
  const fx = facets.data;

  const categories: FilterCategory[] = [
    { key: 'owner', label: 'Owner', pick: 'one', options: fx?.owners ?? [] },
    { key: 'practice', label: 'Practice', pick: 'one', options: fx?.practices ?? [] },
    { key: 'source', label: 'Source', pick: 'one', options: fx?.sources ?? [] },
  ];
  const value = { owner: search.owner ? [search.owner] : [], practice: search.practice ? [search.practice] : [], source: search.source ? [search.source] : [] };
  const clearFilters = () => update({ stage: undefined, q: undefined, owner: undefined, practice: undefined, source: undefined });
  const filtered = !!(search.stage || search.q || search.owner || search.practice || search.source);

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, count } = await exportAccounts(tenant, filters);
      save(blob, 'scout-accounts.csv');
      toast.show(count === 1 ? 'Exported 1 account to scout-accounts.csv.' : `Exported ${f.number(count)} accounts to scout-accounts.csv.`);
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setExporting(false);
    }
  }

  const subtitle = fx
    ? `${fx.total === 1 ? '1 account' : `${f.number(fx.total)} accounts`} across every stage. ${f.number(fx.won_this_year)} won this year.`
    : 'Every account in this workspace you can see.';

  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>All accounts</h1>
          <p className={page.sub}>{subtitle}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
          Export CSV
        </Button>
      </div>

      {fx && (
        <Tabs
          label="Stage"
          variant="segmented"
          value={search.stage ?? ''}
          onChange={(id) => update({ stage: id || undefined })}
          tabs={[{ id: '', label: 'All', count: fx.total }, ...fx.stages.map((s) => ({ id: s.key, label: s.label, count: s.count }))]}
        />
      )}

      <div className={styles.controls}>
        <label htmlFor={searchId} className="sr-only">
          Find an account
        </label>
        <input id={searchId} type="search" className={`input ${styles.search}`} placeholder="Find an account" value={text} onChange={(e) => setText(e.target.value)} />
        <FilterPopover
          categories={categories}
          value={value}
          onChange={(key, values) => update({ [key]: values[0] || undefined })}
          onClear={() => update({ owner: undefined, practice: undefined, source: undefined })}
        />
      </div>

      {list.isPending ? (
        <LoadingRows>Loading accounts</LoadingRows>
      ) : list.isError ? (
        <LoadFailed title="All accounts didn't load" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No accounts match these filters"
            actions={
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            Try another stage or owner, or clear the filters to see every account in this workspace.
          </EmptyState>
        ) : (
          <EmptyState title="No accounts yet">Accounts show here once a source sends them or someone imports a list.</EmptyState>
        )
      ) : (
        <div className={table.wrap}>
          <Table tenant={tenant} rows={rows} />
          <div className={table.foot}>
            <span>{`Showing ${rows.length} of ${f.number(total ?? rows.length)}`}</span>
            {list.hasNextPage && (
              <Button size="sm" variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Show more
              </Button>
            )}
            <span>Sorted by stage, then priority</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Table({ tenant, rows }: { tenant: string; rows: AccountRow[] }) {
  const f = useFormat();
  const navigate = useNavigate();
  return (
    <table className={table.table}>
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col">Stage</th>
          <th scope="col">Owner</th>
          <th scope="col">Best offer</th>
          <th scope="col" className={table.num}>
            Priority
          </th>
          <th scope="col">Source</th>
          <th scope="col">Last activity</th>
          <th scope="col" className={table.num}>
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.account_id} className={styles.clickable} onClick={() => void navigate({ to: '/t/$tenant/accounts/$id', params: { tenant, id: r.account_id } })}>
            <td>
              <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: r.account_id }} className={styles.accountLink} onClick={(e) => e.stopPropagation()}>
                {r.name}
              </Link>
              {kindAndPlace(r) && <div className={styles.sub}>{kindAndPlace(r)}</div>}
            </td>
            <td>{r.stage_label && <span className={styles.stage}>{r.stage_label}</span>}</td>
            <td>
              {r.owner_name ? (
                <span className={styles.owner}>
                  <Avatar name={r.owner_name} size="sm" decorative />
                  {r.owner_name}
                </span>
              ) : (
                <span className={table.muted}>Unassigned</span>
              )}
            </td>
            <td>
              {r.lead_offer?.name ?? <span className={table.muted}>None yet</span>}
              {r.lead_offer?.practice_name && <div className={styles.sub}>{r.lead_offer.practice_name}</div>}
            </td>
            <td className={table.num}>{r.priority ?? <span className={table.muted}>Not scored</span>}</td>
            <td>
              {r.source?.name ?? <span className={table.muted}>None</span>}
              {r.source?.via && <div className={styles.sub}>{r.source.via}</div>}
            </td>
            <td>
              {r.last_activity ? (
                <>
                  {activityText(r.last_activity)}
                  <div className={styles.sub}>{f.relative(r.last_activity.at)}</div>
                </>
              ) : (
                <span className={table.muted}>No activity yet</span>
              )}
            </td>
            <td className={table.num}>
              {r.value && r.value.amount_cents !== null ? (
                <>
                  {r.value.currency ? formatMoney(r.value.amount_cents, r.value.currency) : f.money(r.value.amount_cents)}
                  <div className={styles.sub}>{r.value.kind === 'won' ? 'Won' : 'Open deal'}</div>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
