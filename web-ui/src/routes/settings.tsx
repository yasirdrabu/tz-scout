import { createRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';
import { SETTINGS_TABS } from '../app/nav';
import { pickStrings } from '../lib/search';
import { tenantRoute } from './tenant';

/**
 * `open`: the member, service, key or AI run shown open, so the URL carries what is open. `q`, `area`
 * and `who`: the Audit log's search and filters; `q` and `status` the Members search and status tab;
 * `status` and `task` the AI runs filters (C10).
 */
type SettingsSearch = { open?: string; q?: string; area?: string; who?: string; status?: string; task?: string };
const SEARCH_KEYS = ['open', 'q', 'area', 'who', 'status', 'task'] as const;

export const settingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/$tab',
  validateSearch: (search: Record<string, unknown>): SettingsSearch => pickStrings(search, SEARCH_KEYS),
  beforeLoad: ({ params }) => {
    if (!SETTINGS_TABS.some((t) => t.tab === params.tab)) throw notFound();
  },
  component: lazyRouteComponent(() => import('./settings.page'), 'SettingsPage'),
});
