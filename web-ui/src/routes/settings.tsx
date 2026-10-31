import { useQuery } from '@tanstack/react-query';
import { createRoute, notFound, useNavigate } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { SETTINGS_TABS } from '../app/nav';
import { SettingsScreen } from '../features/settings/SettingsScreen';
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
  component: Settings,
});

function Settings() {
  const { tenant, tab } = settingsRoute.useParams();
  const { open } = settingsRoute.useSearch();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery(tenant));
  if (!me) return null;
  const setOpen = (id: string | undefined) =>
    void navigate({ to: '/t/$tenant/settings/$tab', params: { tenant, tab }, search: id ? { open: id } : {} });
  return <SettingsScreen me={me} tenant={tenant} tab={tab} open={open} setOpen={setOpen} />;
}
