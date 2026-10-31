import { createRoute } from '@tanstack/react-router';
import { Placeholder } from './Placeholder';
import { SCREENS } from './screens';
import { tenantRoute } from './tenant';

export const profileRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'profile',
  component: () => <Placeholder screen={SCREENS.profile} />,
});
