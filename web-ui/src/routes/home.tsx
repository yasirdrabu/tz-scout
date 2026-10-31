import type { QueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { UnauthorizedError } from '../api/errors';
import { meQuery, type Me } from '../api/me';
import { lastWorkspace, rememberWorkspace } from '../lib/lastWorkspace';
import { rootRoute } from './root';

/** `/me` of the remembered workspace, else of the one the API picks, else null (signed out). */
async function landingMe(queryClient: QueryClient): Promise<Me | null> {
  const remembered = lastWorkspace();
  const tries = remembered ? [remembered, undefined] : [undefined];
  for (const tenant of tries) {
    try {
      return await queryClient.fetchQuery(meQuery(tenant));
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      if (tenant) rememberWorkspace(null);
    }
  }
  return null;
}

/** `/`: the last used workspace, or sign-in. */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const me = await landingMe(context.queryClient);
    if (!me) throw redirect({ to: '/signin', search: {} });
    throw redirect({ to: '/t/$tenant', params: { tenant: me.tenant.slug } });
  },
});
