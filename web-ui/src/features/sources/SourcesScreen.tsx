import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useSearchText } from '../../lib/useSearchText';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { FilterPopover, type FilterCategory } from '../../ui/FilterPopover';
import table from '../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { AddSourceDialog } from './AddSourceDialog';
import { sourcesQuery, statsQuery, type SourcesFilters } from './api';
import { parentsIn, SourceTree } from './SourceTree';
import styles from './Sources.module.css';

const route = getRouteApi('/t/$tenant/sources');

/** §10 Sources: the tree with how each sends, trust words and the stats, search and the Type filter in the URL (C10). */
export function SourcesScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const searchId = useId();
  const { data: me } = useQuery(meQuery(tenant));
  const filters: SourcesFilters = { kind: search.kind, q: search.q };
  const update = (patch: Partial<SourcesFilters>, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(filters.q ?? '', (q) => update({ q: q || undefined }, true));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const list = useQuery(sourcesQuery(tenant, filters));
  const stats = useQuery({ ...statsQuery(tenant), enabled: !!me && hasScope(me, 'sources:manage') });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const canManage = !!me && hasScope(me, 'sources:manage');

  const kinds = search.kind ? search.kind.split(',') : [];
  const categories: FilterCategory[] = [
    {
      key: 'kind',
      label: 'Type',
      pick: 'any',
      options: meta ? Object.entries(meta.counts_by_kind).map(([value, count]) => ({ value, label: meta.kind_labels[value] ?? value, count })) : [],
    },
  ];
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const filtered = !!(search.kind || search.q);

  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>Sources</h1>
          <p className={page.sub}>
            Every account traces back to a person, the agent they run and the data vendor behind it. Trust decides how much Scout relies on what a source says.
          </p>
        </div>
        {canManage && (
          <Button icon={<Plus />} onClick={() => setAdding(true)}>
            Add a source
          </Button>
        )}
      </div>

      <div className={styles.controls}>
        <label htmlFor={searchId} className="sr-only">
          Find a source
        </label>
        <input id={searchId} type="search" className={`input ${styles.search}`} placeholder="Find a source" value={text} onChange={(e) => setText(e.target.value)} />
        <FilterPopover
          categories={categories}
          value={{ kind: kinds }}
          onChange={(_key, values) => update({ kind: values.length ? values.join(',') : undefined })}
          onClear={() => update({ kind: undefined })}
        />
        <span className={styles.grow} />
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
          Expand all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(parentsIn(rows))}>
          Collapse all
        </Button>
      </div>

      {list.isPending ? (
        <LoadingRows>Loading sources</LoadingRows>
      ) : list.isError ? (
        <LoadFailed title="Sources didn't load" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sources"
          actions={
            filtered && (
              <Button size="sm" variant="secondary" onClick={() => update({ kind: undefined, q: undefined })}>
                Clear filters
              </Button>
            )
          }
        >
          No sources match. Clear the filters, or add a source.
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <SourceTree tenant={tenant} rows={rows} stats={stats.data} collapsed={collapsed} onToggle={toggle} />
        </div>
      )}

      {canManage && meta && <AddSourceDialog open={adding} onOpenChange={setAdding} tenant={tenant} canAddCrm={meta.can_add_crm} />}
    </div>
  );
}
