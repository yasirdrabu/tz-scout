import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { pickStrings } from '../lib/search';
import { Placeholder } from './Placeholder';
import { SCREENS } from './screens';
import { tenantRoute } from './tenant';

// Placeholders for every workspace screen. Each feature plan replaces one with the real screen.

/**
 * The queue's tier, filters (`status` keys comma separated) and the account open in the peek drawer, so
 * a link or a reload keeps the place (C10).
 */
export type QueueSearch = { tier?: string; practice?: string; offer?: string; source?: string; status?: string; peek?: string };

export const queueRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'queue',
  validateSearch: (search: Record<string, unknown>): QueueSearch => pickStrings(search, ['tier', 'practice', 'offer', 'source', 'status', 'peek']),
  component: lazyRouteComponent(() => import('../features/review/QueueScreen'), 'QueueScreen'),
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
