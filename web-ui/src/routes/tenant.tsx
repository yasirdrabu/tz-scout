import { useQuery } from '@tanstack/react-query';
import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { meQuery } from '../api/me';
import { landingPath } from '../app/nav';
import { requireSession } from '../app/RequireSession';
import { Shell } from '../app/Shell';
import { rememberWorkspace } from '../lib/lastWorkspace';
import { EmptyState } from '../ui/EmptyState';
import { LoadingLine } from '../ui/LoadingLine';
import styles from './Page.module.css';
import { rootRoute } from './root';

/** `/t/$tenant`: every workspace screen, inside the shell. */
export const tenantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/t/$tenant',
  beforeLoad: async ({ context, params, location }) => {
    const me = await requireSession(context.queryClient, params.tenant, location.href);
    rememberWorkspace(me.tenant.slug);
  },
  component: TenantLayout,
});

function TenantLayout() {
  const { tenant } = tenantRoute.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  if (!me) {
    return (
      <div className={styles.centered}>
        <LoadingLine>Loading your workspace</LoadingLine>
      </div>
    );
  }
  return (
    <Shell me={me}>
      <Outlet />
    </Shell>
  );
}

/** `/t/$tenant/`: the first of Review queue, My accounts, All accounts the person may see. */
export const tenantIndexRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: '/',
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(params.tenant));
    const to = landingPath(me);
    if (to) throw redirect({ to, params });
  },
  component: NoScreens,
});

function NoScreens() {
  return (
    <EmptyState title="Nothing to open here yet">
      Your role in this workspace has no screens yet. Ask your owner for access.
    </EmptyState>
  );
}
