import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { hasScope, meQuery } from '../../api/me';
import page from '../../routes/Page.module.css';
import { Tabs } from '../../ui/Tabs';
import { LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { usePause } from './hooks';
import { sourceBatchesQuery } from '../batches/api';
import { childTab, sourceQuery, statsQuery, syncSource } from './api';
import { SourceHeader } from './SourceHeader';
import { StatTiles } from './StatTiles';
import { AccountsTab } from './tabs/AccountsTab';
import { BatchesTab } from './tabs/BatchesTab';
import { ChildrenTab } from './tabs/ChildrenTab';
import { OverviewTab } from './tabs/OverviewTab';
import { SettingsTab } from './tabs/SettingsTab';

/** §11 Source page: header, tiles and the tabs; the URL carries the tab (C10). */
export function SourcePage() {
  const params = useParams({ strict: false });
  const tenant = params.tenant!;
  const id = params.id!;
  const tab = params.tab ?? 'overview';
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery(tenant));
  const one = useQuery(sourceQuery(tenant, id));
  const stats = useQuery(statsQuery(tenant));
  const batches = useInfiniteQuery(sourceBatchesQuery(tenant, id));
  const pause = usePause(tenant, one.data);
  const sync = useRun();

  if (one.isPending) return <div className={page.page}><LoadingRows>Loading the source</LoadingRows></div>;
  if (one.isError) {
    return (
      <div className={page.page}>
        <LoadFailed title="This source didn't load" error={one.error} onRetry={() => void one.refetch()} />
      </div>
    );
  }
  const s = one.data;
  const stat = stats.data?.get(s.id);
  const canManage = !!me && hasScope(me, 'sources:manage');
  const kids = s.children_count > 0 ? childTab(s.kind) : null;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'accounts', label: 'Accounts', ...(stat ? { count: stat.sent } : {}) },
    { id: 'batches', label: 'Batches', ...(batches.data?.pages[0] ? { count: batches.data.pages[0].total } : {}) },
    ...(kids ? [kids] : []),
    { id: 'settings', label: 'Settings' },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview';
  const go = (next: string) =>
    void (next === 'overview'
      ? navigate({ to: '/t/$tenant/sources/$id', params: { tenant, id } })
      : navigate({ to: '/t/$tenant/sources/$id/$tab', params: { tenant, id, tab: next } }));

  return (
    <div className={page.page}>
      <SourceHeader
        tenant={tenant}
        source={s}
        canAct={canManage}
        canFunnel={!!me && hasScope(me, 'analytics:read')}
        busy={pause.busy || sync.busy}
        onPause={() => void pause.toggle()}
        onSync={() => void sync.run(() => syncSource(tenant, s.id), 'Sync started.')}
      />
      <StatTiles stat={stat} trust={s.trust_label ?? String(s.trust)} showCost={!!me && hasScope(me, 'costs:read')} />
      <Tabs label="Source" tabs={tabs} value={current} onChange={go}>
        {current === 'overview' && <OverviewTab tenant={tenant} source={s} stat={stat} />}
        {current === 'accounts' && <AccountsTab tenant={tenant} source={s} />}
        {current === 'batches' && <BatchesTab tenant={tenant} batches={batches} canRetry={!!me && hasScope(me, 'imports:run')} />}
        {current === kids?.id && <ChildrenTab tenant={tenant} source={s} />}
        {current === 'settings' && <SettingsTab tenant={tenant} source={s} me={me} />}
      </Tabs>
    </div>
  );
}
