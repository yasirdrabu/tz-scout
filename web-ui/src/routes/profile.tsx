import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from './tenant';

export const profileRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'profile',
  component: lazyRouteComponent(() => import('./profile.page'), 'ProfilePage'),
});
