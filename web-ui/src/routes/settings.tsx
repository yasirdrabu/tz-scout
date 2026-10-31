import { createRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';
import { SETTINGS_TABS } from '../app/nav';
import { tenantRoute } from './tenant';

/** `open`: the member, service or key shown in a drawer, so the URL carries what is open. */
type SettingsSearch = { open?: string };

export const settingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/$tab',
  validateSearch: (search: Record<string, unknown>): SettingsSearch =>
    typeof search.open === 'string' && search.open ? { open: search.open } : {},
  beforeLoad: ({ params }) => {
    if (!SETTINGS_TABS.some((t) => t.tab === params.tab)) throw notFound();
  },
  component: lazyRouteComponent(() => import('./settings.page'), 'SettingsPage'),
});
