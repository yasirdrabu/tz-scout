import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { account, membership, tenant, user } from '../db/schema';
import { tenantsFor } from './members';

/** Shown when someone signs in who is not a member anywhere (TEN-E2-S1-AC2). */
export const NOT_SET_UP = "Your account isn't set up in Scout yet. Ask your Scout owner to add you.";
/** Shown when a disabled user tries to sign in (TEN-E2-S3-AC1). */
export const ACCOUNT_TURNED_OFF = 'Your Scout account is turned off. Ask your Scout owner for help.';

/** What we know about the person signing in: our user id, or what Microsoft told us. */
export type SignInIdentity = {
  userId?: string;
  email?: string | null;
  /** User principal name; accepted as an email. */
  upn?: string | null;
  entraObjectId?: string | null;
};

export type SignInResult = { ok: true; userId: string } | { ok: false; message: string };

const norm = (v: string | null | undefined): string | undefined => v?.trim().toLowerCase() || undefined;

/** Finds the user: by our id, else by Entra object id, else by lower-cased email, else by UPN. */
async function findUser(id: SignInIdentity) {
  const cols = { id: user.id, email: user.email, disabledAt: user.disabledAt, platformAdmin: user.platformAdmin };
  if (id.userId) {
    const [u] = await adminDb.select(cols).from(user).where(eq(user.id, id.userId));
    return u ?? null;
  }
  const oid = id.entraObjectId?.trim();
  if (oid) {
    const [u] = await adminDb.select(cols).from(user).where(eq(user.entraObjectId, oid));
    if (u) return u;
  }
  for (const email of [norm(id.email), norm(id.upn)]) {
    if (!email) continue;
    const [u] = await adminDb.select(cols).from(user).where(eq(user.email, email));
    if (u) return u;
  }
  return null;
}

/**
 * The sign-in gate. A person gets in when they are not disabled and are a platform admin or hold an
 * active or invited membership in an active tenant. Read only: `completeSignIn` does the writes.
 */
export async function checkSignIn(identity: SignInIdentity): Promise<SignInResult> {
  const u = await findUser(identity);
  if (!u) return { ok: false, message: NOT_SET_UP };
  if (u.disabledAt) return { ok: false, message: ACCOUNT_TURNED_OFF };
  if (u.platformAdmin) return { ok: true, userId: u.id };
  const live = await adminDb
    .select({ id: membership.id })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .where(
      and(
        eq(membership.userId, u.id),
        inArray(membership.status, ['invited', 'active']),
        eq(tenant.status, 'active'),
      ),
    )
    .limit(1);
  return live.length > 0 ? { ok: true, userId: u.id } : { ok: false, message: NOT_SET_UP };
}

/** Claims of a Microsoft id token that matter for matching. */
export type MicrosoftProfile = {
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * The email better-auth should match the Microsoft profile on: the email of the user found by Entra
 * object id, email or UPN (in that order), else the lower-cased profile email or UPN.
 */
export async function signInEmailFor(profile: MicrosoftProfile): Promise<string | undefined> {
  const identity: SignInIdentity = {
    entraObjectId: str(profile.oid),
    email: str(profile.email),
    upn: str(profile.preferred_username) ?? str(profile.upn),
  };
  const u = await findUser(identity);
  return u?.email ?? norm(identity.email) ?? norm(identity.upn);
}

/**
 * True when the Microsoft identity `entraObjectId` may be linked to `userId`: the user has no Entra
 * object id yet, or the same one, and no other user holds it.
 */
export async function entraIdentityFits(userId: string, entraObjectId: string): Promise<boolean> {
  const [u] = await adminDb.select({ oid: user.entraObjectId }).from(user).where(eq(user.id, userId));
  if (!u || (u.oid !== null && u.oid !== entraObjectId)) return false;
  const [other] = await adminDb
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.entraObjectId, entraObjectId), ne(user.id, userId)))
    .limit(1);
  return !other;
}

/**
 * After a passed gate: records the sign-in, keeps the Entra object id, and makes invited memberships
 * active (TEN-E2-S1-AC3) with a `tenancy.member.activated` audit row in each tenant. No event: the
 * member was announced by `tenancy.member.added` at invite.
 */
export async function completeSignIn(userId: string): Promise<void> {
  const correlationId = newId('cor');
  const actor = { kind: 'user' as const, id: userId };
  await adminDb.transaction(async (tx) => {
    await tx.update(user).set({ lastSignInAt: new Date(), updatedAt: new Date() }).where(eq(user.id, userId));
    // Keep the Microsoft object id so a later email change still matches this person.
    await tx
      .update(user)
      .set({
        entraObjectId: sql`(select ${account.accountId} from ${account} where ${account.userId} = ${userId}
          and ${account.providerId} = 'microsoft' order by ${account.createdAt} limit 1)`,
      })
      .where(
        and(
          eq(user.id, userId),
          isNull(user.entraObjectId),
          sql`not exists (select 1 from ${user} u2 where u2.entra_object_id = (select ${account.accountId}
            from ${account} where ${account.userId} = ${userId} and ${account.providerId} = 'microsoft'
            order by ${account.createdAt} limit 1))`,
        ),
      );
    const activated = await tx
      .update(membership)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(membership.userId, userId),
          eq(membership.status, 'invited'),
          inArray(membership.tenantId, tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.status, 'active'))),
        ),
      )
      .returning({ id: membership.id, tenantId: membership.tenantId, role: membership.role });
    for (const m of activated) {
      await audit(
        { tenantId: m.tenantId, actor, correlationId, tx },
        {
          action: 'tenancy.member.activated',
          subject: { type: 'membership', id: m.id },
          before: { status: 'invited' },
          after: { status: 'active', role: m.role },
        },
      );
    }
  });
}

/** Where to send someone after sign-in: their last used tenant, else their first active tenant (TEN-E2-S1-AC1). */
export async function landingPathFor(userId: string): Promise<string> {
  const [u] = await adminDb.select({ last: user.lastTenantId }).from(user).where(eq(user.id, userId));
  const list = await tenantsFor(userId);
  const target = list.find((t) => t.id === u?.last) ?? list[0];
  return target ? `/t/${target.slug}` : '/';
}
