import { createRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';
import { SETTINGS_TABS } from '../app/nav';
import { pickStrings } from '../lib/search';
import { tenantRoute } from './tenant';

/**
 * `open`: the member, service or key shown in a drawer, so the URL carries what is open. `q`, `area`
 * and `who`: the Audit log's search and filters (C10).
 */
type SettingsSearch = { open?: string; q?: string; area?: string; who?: string };
const SEARCH_KEYS = ['open', 'q', 'area', 'who'] as const;

export const settingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/$tab',
  validateSearch: (search: Record<string, unknown>): SettingsSearch => pickStrings(search, SEARCH_KEYS),
  beforeLoad: ({ params }) => {
    if (!SETTINGS_TABS.some((t) => t.tab === params.tab)) throw notFound();
  },
  component: lazyRouteComponent(() => import('./settings.page'), 'SettingsPage'),
});
