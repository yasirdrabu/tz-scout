import { createRoute, redirect } from '@tanstack/react-router';
import { isPlatformAdmin } from '../api/me';
import { landingMe } from '../app/RequireSession';
import { rootRoute } from './root';

/** `/`: the last used workspace; a platform admin with no workspace goes to Tenants; else sign-in. */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const me = await landingMe(context.queryClient);
    if (!me) throw redirect({ to: '/signin', search: {} });
    if (me.tenant) throw redirect({ to: '/t/$tenant', params: { tenant: me.tenant.slug } });
    throw redirect({ to: isPlatformAdmin(me) ? '/admin/tenants' : '/admin' });
  },
});
