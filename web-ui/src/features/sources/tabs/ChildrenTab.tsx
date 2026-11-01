import { useQuery } from '@tanstack/react-query';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import { sourcesQuery, statsQuery, type SourceDetail } from '../api';
import { SourceTree } from '../SourceTree';

/** Runs (a person) or Pulls from (an agent or vendor): the sources directly under this one, with their numbers. */
export function ChildrenTab({ tenant, source: s }: { tenant: string; source: SourceDetail }) {
  const all = useQuery(sourcesQuery(tenant));
  const stats = useQuery(statsQuery(tenant));
  if (all.isPending) return <LoadingRows>Loading sources</LoadingRows>;
  if (all.isError) return <LoadFailed title="Sources didn't load" error={all.error} onRetry={() => void all.refetch()} />;
  const rows = all.data.data.filter((c) => c.parent_id === s.id);
  return (
    <div className={table.wrap}>
      <SourceTree tenant={tenant} rows={rows} stats={stats.data} collapsed={new Set()} onToggle={() => {}} columns="children" />
    </div>
  );
}
