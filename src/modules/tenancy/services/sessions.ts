import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/platform/db/tenant';
import { SESSION_MAX_SECONDS } from '../auth';
import { account, session, user } from '../db/schema';
import { SESSION_IDLE_MS } from './principal';

/** How someone signs in: Microsoft, developer sign-in (a sign-in with no Microsoft link), or not yet. */
export type SignInMethod = 'microsoft' | 'dev' | null;

export type SignInFacts = { lastActiveAt: Date | null; signInMethod: SignInMethod };

/**
 * Per user: last activity (their latest session activity, else their last sign-in) and sign-in
 * method. Sessions and account links are platform-wide, so this says nothing about a workspace.
 */
export async function signInFacts(tx: Tx, userIds: string[]): Promise<Map<string, SignInFacts>> {
  const out = new Map<string, SignInFacts>();
  if (userIds.length === 0) return out;
  const users = await tx
    .select({ id: user.id, lastSignInAt: user.lastSignInAt })
    .from(user)
    .where(inArray(user.id, userIds));
  const latest = await tx
    .select({ userId: session.userId, at: sql<string>`max(${session.updatedAt})::text` })
    .from(session)
    .where(inArray(session.userId, userIds))
    .groupBy(session.userId);
  const microsoft = await tx
    .selectDistinct({ userId: account.userId })
    .from(account)
    .where(and(inArray(account.userId, userIds), eq(account.providerId, 'microsoft')));
  const lastSession = new Map(latest.map((r) => [r.userId, new Date(r.at)]));
  const withMicrosoft = new Set(microsoft.map((r) => r.userId));
  for (const u of users) {
    const s = lastSession.get(u.id) ?? null;
    const lastActiveAt = s && (!u.lastSignInAt || s > u.lastSignInAt) ? s : u.lastSignInAt;
    out.set(u.id, {
      lastActiveAt,
      signInMethod: withMicrosoft.has(u.id) ? 'microsoft' : u.lastSignInAt ? 'dev' : null,
    });
  }
  return out;
}

export type SessionView = {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastActiveAt: Date;
};

/** The person's sessions that still work (not past the idle or age limits), newest activity first. Never the token. */
export async function listSessions(tx: Tx, userId: string, currentSessionId: string): Promise<SessionView[]> {
  const now = Date.now();
  const rows = await tx
    .select({
      id: session.id,
      ip: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastActiveAt: session.updatedAt,
    })
    .from(session)
    .where(
      and(
        eq(session.userId, userId),
        gt(session.expiresAt, new Date(now)),
        gt(session.updatedAt, new Date(now - SESSION_IDLE_MS)),
        gt(session.createdAt, new Date(now - SESSION_MAX_SECONDS * 1000)),
      ),
    )
    .orderBy(desc(session.updatedAt), desc(session.id));
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Ends every session the person has, on every device and in every workspace. Returns how many. */
export async function endSessions(tx: Tx, userId: string): Promise<number> {
  const gone = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
  return gone.length;
}
