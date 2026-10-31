import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { ProfileScreen } from '../features/profile/ProfileScreen';
import { tenantRoute } from './tenant';

export const profileRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'profile',
  component: Profile,
});

function Profile() {
  const { tenant } = profileRoute.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  return me ? <ProfileScreen me={me} /> : null;
}
