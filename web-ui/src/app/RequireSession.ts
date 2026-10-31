import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { UnauthorizedError } from '../api/errors';
import { meQuery, type Me } from '../api/me';

/** Where a 401 sends the person: sign-in, with the path to come back to. */
export const signInRedirect = (returnTo: string) => redirect({ to: '/signin', search: { return: returnTo } });

/**
 * For a route's `beforeLoad`: the `/me` of this workspace (cached), or a redirect to sign-in with
 * the current path when the session is missing or expired. Other errors reach the route's error view.
 */
export async function requireSession(queryClient: QueryClient, tenant: string | undefined, returnTo: string): Promise<Me> {
  try {
    return await queryClient.ensureQueryData(meQuery(tenant));
  } catch (e) {
    if (e instanceof UnauthorizedError) throw signInRedirect(returnTo);
    throw e;
  }
}
