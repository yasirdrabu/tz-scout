import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { SettingsScreen } from '../features/settings/SettingsScreen';

const route = getRouteApi('/t/$tenant/settings/$tab');

/** The Settings route's screen, loaded on first visit (its own chunk). */
export function SettingsPage() {
  const { tenant, tab } = route.useParams();
  const { open } = route.useSearch();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery(tenant));
  if (!me) return null;
  const setOpen = (id: string | undefined) =>
    void navigate({ to: '/t/$tenant/settings/$tab', params: { tenant, tab }, search: (prev) => ({ ...prev, open: id }) });
  return <SettingsScreen me={me} tenant={tenant} tab={tab} open={open} setOpen={setOpen} />;
}
