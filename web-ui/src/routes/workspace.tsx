import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, notFound } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { SETTINGS_TABS, visibleSettingsTabs } from '../app/nav';
import { Placeholder } from './Placeholder';
import styles from './Placeholder.module.css';
import { SCREENS } from './screens';
import { tenantRoute } from './tenant';

// Placeholders for every workspace screen. Each feature plan replaces one with the real screen.

export const queueRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'queue',
  component: () => <Placeholder screen={SCREENS.queue} />,
});

export const myRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'my',
  component: () => <Placeholder screen={SCREENS.my} />,
});

export const accountsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'accounts',
  component: () => <Placeholder screen={SCREENS.accounts} />,
});

export const accountRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'accounts/$id',
  component: function AccountPlaceholder() {
    const { id } = accountRoute.useParams();
    return <Placeholder screen={SCREENS.account} subtitle={`Account ${id}. This screen is not built yet.`} />;
  },
});

export const overviewRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'overview',
  component: () => <Placeholder screen={SCREENS.overview} />,
});

export const sourcesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'sources',
  component: () => <Placeholder screen={SCREENS.sources} />,
});

export const batchesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'batches',
  component: () => <Placeholder screen={SCREENS.batches} />,
});

export const offersRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'offers',
  component: () => <Placeholder screen={SCREENS.offers} />,
});

export const playbooksRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'playbooks',
  component: () => <Placeholder screen={SCREENS.playbooks} />,
});

export const funnelRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'funnel',
  component: () => <Placeholder screen={SCREENS.funnel} />,
});

export const costsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'costs',
  component: () => <Placeholder screen={SCREENS.costs} />,
});

export const profileRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'profile',
  component: () => <Placeholder screen={SCREENS.profile} />,
});

export const settingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/$tab',
  beforeLoad: ({ params }) => {
    if (!SETTINGS_TABS.some((t) => t.tab === params.tab)) throw notFound();
  },
  component: SettingsPlaceholder,
});

function SettingsPlaceholder() {
  const { tenant, tab } = settingsRoute.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  const current = SETTINGS_TABS.find((t) => t.tab === tab);
  if (!me || !current) return null;
  return (
    <Placeholder
      screen={{ title: 'Settings', section: current.section, tag: current.tag }}
      subtitle={`${current.label}. This tab is not built yet.`}
    >
      <nav aria-label="Settings" className={styles.tabs}>
        {visibleSettingsTabs(me).map((t) => (
          <Link key={t.tab} to="/t/$tenant/settings/$tab" params={{ tenant, tab: t.tab }} className={styles.tab}>
            {t.label}
          </Link>
        ))}
      </nav>
    </Placeholder>
  );
}
