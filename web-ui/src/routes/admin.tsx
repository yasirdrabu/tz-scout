import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';
import { isPlatformAdmin } from '../api/me';
import { requireSession } from '../app/RequireSession';
import { Shell } from '../app/Shell';
import { lastWorkspace } from '../lib/lastWorkspace';
import { EmptyState } from '../ui/EmptyState';
import { Placeholder } from './Placeholder';
import { rootRoute } from './root';
import { SCREENS } from './screens';

/**
 * `/admin`: platform admin screens. Today `/me` needs a workspace and has no platform admin flag
 * (api-gaps.md tenancy), so the shell loads with the last workspace and the screens stay closed.
 */
export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: async ({ context, location }) => ({
    me: await requireSession(context.queryClient, lastWorkspace() ?? undefined, location.href),
  }),
  component: AdminLayout,
});

function AdminLayout() {
  const { me } = adminRoute.useRouteContext();
  return (
    <Shell me={me}>
      {isPlatformAdmin(me) ? (
        <Outlet />
      ) : (
        <EmptyState title="Only platform admins can open this page" icon={<ShieldOff />}>
          Ask a Taazaa platform admin if you need something here.
        </EmptyState>
      )}
    </Shell>
  );
}

export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/tenants' });
  },
});

export const adminTenantsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tenants',
  component: () => <Placeholder screen={SCREENS.adminTenants} />,
});

export const adminHealthRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'health',
  component: () => <Placeholder screen={SCREENS.adminHealth} />,
});

export const adminAiRunsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'ai-runs',
  component: () => <Placeholder screen={SCREENS.adminAiRuns} />,
});
