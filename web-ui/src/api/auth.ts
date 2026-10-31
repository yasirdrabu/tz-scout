import { request } from './client';
import { ApiError, UnauthorizedError } from './errors';

/** Sign-in lives outside the API base: better-auth at /api/auth, developer sign-in at /api/dev. */
const AUTH = '/api/auth';
const DEV = '/api/dev';

/** A relative in-app path to return to after sign-in, or null when it is unsafe or loops back. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (raw === '/signin' || raw.startsWith('/signin?') || raw.startsWith('/signin/')) return null;
  return raw;
}

/**
 * Starts Microsoft sign-in: the API answers with the provider URL and the browser follows it.
 * Afterwards better-auth sends the person to `returnPath`, or to `/signin?error=...` on failure.
 */
export async function startMicrosoftSignIn(returnPath: string, go: (url: string) => void = (u) => window.location.assign(u)) {
  const res = await request<{ url?: unknown } | null>(`${AUTH}/sign-in/social`, {
    method: 'POST',
    body: { provider: 'microsoft', callbackURL: safeReturnPath(returnPath) ?? '/', errorCallbackURL: '/signin' },
  });
  if (typeof res?.url !== 'string') {
    throw new ApiError({ status: 500, title: 'Sign-in did not start', code: 'sign_in_failed', ref: '' });
  }
  go(res.url);
}

export type DevUser = { id: string; email: string; name: string; platform_admin: boolean };

/**
 * People developer sign-in offers, or null when the API has no list (api-gaps.md tenancy:
 * `GET /dev/users` is a new endpoint; today only the old sign-in page reads them server side).
 */
export async function devUsers(): Promise<DevUser[] | null> {
  try {
    const list = await request<unknown>(`${DEV}/users`);
    return Array.isArray(list) ? (list as DevUser[]) : null;
  } catch (e) {
    if (e instanceof ApiError && !(e instanceof UnauthorizedError)) return null;
    throw e;
  }
}

/** Developer sign-in as a seeded user. 404 when the API has it turned off. */
export async function devSignIn(userId: string): Promise<void> {
  await request(`${DEV}/sign-in`, { method: 'POST', body: { userId } });
}

export async function signOut(): Promise<void> {
  await request(`${AUTH}/sign-out`, { method: 'POST', body: {} });
}
