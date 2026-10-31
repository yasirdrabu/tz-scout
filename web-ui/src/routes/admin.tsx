import { createRoute, lazyRouteComponent, Outlet, redirect } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';
import { isPlatformAdmin } from '../api/me';
import { landingMe, signInRedirect } from '../app/RequireSession';
import { Shell } from '../app/Shell';
import { STATUSES, type RunStatus } from '../features/admin/ai-runs/api';
import { pickStrings } from '../lib/search';
import { EmptyState } from '../ui/EmptyState';
import { rootRoute } from './root';

/**
 * `/admin`: platform admin screens, with no workspace segment. The shell loads with the workspace
 * remembered in this browser, else the one the API picks, else none (a platform admin with no
 * membership); a platform admin who is in workspaces can switch back from the sidebar.
 */
export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: async ({ context, location }) => {
    const me = await landingMe(context.queryClient);
    if (!me) throw signInRedirect(location.href);
    return { me };
  },
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

/** `open`: the tenant shown in the drawer, so the URL carries what is open. */
type TenantsSearch = { open?: string };

export const adminTenantsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tenants',
  validateSearch: (search: Record<string, unknown>): TenantsSearch =>
    typeof search.open === 'string' && search.open ? { open: search.open } : {},
  component: lazyRouteComponent(() => import('../features/admin/tenants/TenantsScreen'), 'TenantsScreen'),
});

export const adminHealthRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'health',
  component: lazyRouteComponent(() => import('../features/admin/health/HealthScreen'), 'HealthScreen'),
});

/** The search, filters and the expanded run (`open`), so the URL carries them (C10). */
export type AiRunsSearch = { q?: string; status?: RunStatus; task?: string; tenant?: string; open?: string };

export const adminAiRunsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'ai-runs',
  validateSearch: (search: Record<string, unknown>): AiRunsSearch => {
    const { status, ...rest } = pickStrings(search, ['q', 'status', 'task', 'tenant', 'open']);
    const known = STATUSES.find((s) => s.status === status);
    return known ? { ...rest, status: known.status } : rest;
  },
  component: lazyRouteComponent(() => import('../features/admin/ai-runs/AiRunsScreen'), 'AiRunsScreen'),
});
