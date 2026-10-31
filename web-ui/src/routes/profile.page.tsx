import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { ProfileScreen } from '../features/profile/ProfileScreen';

const route = getRouteApi('/t/$tenant/profile');

/** The Profile route's screen, loaded on first visit (its own chunk). */
export function ProfilePage() {
  const { tenant } = route.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  return me ? <ProfileScreen me={me} /> : null;
}
