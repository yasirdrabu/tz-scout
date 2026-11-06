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
import { sourcesQuery, statsQuery, TRUST_FILTER, type Source, type SourcesFilters } from './api';
import { parentsIn, SourceTree } from './SourceTree';
import styles from './Sources.module.css';

const route = getRouteApi('/t/$tenant/sources');

/** The rows in a trust band, with their ancestors so the tree keeps its shape (the Type filter keeps a row the same way). */
function withBand(rows: Source[], band: string): Source[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const r of rows) {
    if (r.trust_band !== band) continue;
    let at: Source | undefined = r;
    for (let i = 0; at && i < 10 && !keep.has(at.id); i++) {
      keep.add(at.id);
      at = at.parent_id ? byId.get(at.parent_id) : undefined;
    }
  }
  return rows.filter((r) => keep.has(r.id));
}

/** §10 Sources: the tree with how each sends, trust words and the stats, search and the Type filter in the URL (C10). */
export function SourcesScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const searchId = useId();
  const { data: me } = useQuery(meQuery(tenant));
  const filters: SourcesFilters = { kind: search.kind, q: search.q };
  const trust = TRUST_FILTER.find((o) => o.value === search.trust)?.value;
  const update = (patch: Partial<SourcesFilters & { trust: string }>, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(filters.q ?? '', (q) => update({ q: q || undefined }, true));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const list = useQuery(sourcesQuery(tenant, filters));
  const stats = useQuery({ ...statsQuery(tenant), enabled: !!me && hasScope(me, 'sources:manage') });
  const everyone = list.data?.data ?? [];
  const rows = trust ? withBand(everyone, trust) : everyone;
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
    {
      key: 'trust',
      label: 'Trust',
      pick: 'one',
      options: [{ value: '', label: 'All' }, ...TRUST_FILTER].map((o) => ({ ...o, count: o.value ? everyone.filter((r) => r.trust_band === o.value).length : everyone.length })),
    },
  ];
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const filtered = !!(search.kind || search.q || trust);

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
          value={{ kind: kinds, trust: trust ? [trust] : [] }}
          onChange={(key, values) => update(key === 'trust' ? { trust: values[0] || undefined } : { kind: values.length ? values.join(',') : undefined })}
          onClear={() => update({ kind: undefined, trust: undefined })}
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
              <Button size="sm" variant="secondary" onClick={() => update({ kind: undefined, q: undefined, trust: undefined })}>
                Clear filters
              </Button>
            )
          }
        >
          No sources match. Clear the filters, or add a source.
        </EmptyState>
      ) : (
        <>
          <div className={table.wrap}>
            <SourceTree tenant={tenant} rows={rows} stats={stats.data} collapsed={collapsed} onToggle={toggle} />
          </div>
          <p className={styles.note}>
            Trust is learned nightly from what each source&apos;s accounts became. 80 and up is strong, 60 to 79 is average, below 60 is weak. New sources start at 60.
          </p>
        </>
      )}

      {canManage && meta && <AddSourceDialog open={adding} onOpenChange={setAdding} tenant={tenant} canAddCrm={meta.can_add_crm} />}
    </div>
  );
}
