import { asc, isNull } from 'drizzle-orm';
import { adminDb } from '@/platform/db/client';
import { user } from '../db/schema';
import { isAPIError } from 'better-auth/api';
import { PROBLEM_BASE, type ProblemJson } from '@/platform/errors';
import { auth } from '../auth';

function problem(status: number, slug: string, title: string): Response {
  const body: ProblemJson = { type: PROBLEM_BASE + slug, title, status };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json' } });
}

/**
 * `POST /api/dev/sign-in { userId }`: signs in as a seeded user without Microsoft (TEN-E2-S2).
 * Answers 404 unless `enabled` (the route passes `config.authDevSignin`, which is never true in
 * production). The membership gate still applies.
 */
export async function handleDevSignIn(request: Request, opts: { enabled: boolean }): Promise<Response> {
  if (!opts.enabled) return problem(404, 'not-found', 'Not found');
  let userId: unknown;
  try {
    userId = ((await request.json()) as { userId?: unknown } | null)?.userId;
  } catch {
    userId = undefined;
  }
  if (typeof userId !== 'string' || !userId) return problem(400, 'validation', 'Send a user id.');
  try {
    const { headers, response } = await auth.api.devSignIn({
      body: { userId },
      headers: request.headers,
      returnHeaders: true,
    });
    const out = new Headers({ 'content-type': 'application/json' });
    for (const c of headers.getSetCookie()) out.append('set-cookie', c);
    return new Response(JSON.stringify({ user_id: response.userId }), { status: 200, headers: out });
  } catch (e) {
    if (isAPIError(e)) {
      const status = e.statusCode;
      const slug = status === 404 ? 'not-found' : status === 403 ? 'forbidden' : 'sign-in-failed';
      return problem(status, slug, e.body?.message ?? e.message);
    }
    throw e;
  }
}

export type DevSignInUser = { id: string; name: string; email: string; platformAdmin: boolean };

/** People the developer picker offers. Only call when AUTH_DEV_SIGNIN is on. */
export async function devSignInUsers(): Promise<DevSignInUser[]> {
  return adminDb
    .select({ id: user.id, name: user.name, email: user.email, platformAdmin: user.platformAdmin })
    .from(user)
    .where(isNull(user.disabledAt))
    .orderBy(asc(user.email));
}
