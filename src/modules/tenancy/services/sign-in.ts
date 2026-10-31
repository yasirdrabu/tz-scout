import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
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
  tid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
};

/**
 * Which Entra tenants may be trusted for a first sign-in matched by email or UPN (Entra email and
 * UPN claims are set by each tenant's admins, so they prove nothing on their own).
 */
export type EntraPolicy = {
  /** Scout's home Entra tenant: the only one platform admins may be matched from by email. */
  homeTenantId: string;
  /** Tenants whose people may be matched by email on their first sign-in. */
  allowedTenantIds: string[];
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const lower = (v: string | undefined) => v?.toLowerCase();

/** An address no user can have (`.invalid` is reserved), so better-auth matches nobody and refuses. */
const noMatch = () => `no-match-${newId('cor').toLowerCase()}@sign-in.invalid`;

/** True when a first, email-matched link from Entra tenant `tid` may be trusted for this user. */
function mayLinkByEmail(u: { platformAdmin: boolean }, tid: string | undefined, policy: EntraPolicy): boolean {
  if (!tid) return false;
  if (u.platformAdmin) return tid === policy.homeTenantId.toLowerCase();
  return policy.allowedTenantIds.map((t) => t.toLowerCase()).includes(tid);
}

/**
 * The email better-auth should match the Microsoft profile on.
 * - A user pinned to this Entra object id (and tenant): that user's email.
 * - Else a user found by email or UPN: their email, only when they are not pinned to another
 *   Microsoft identity and the token's tenant passes `mayLinkByEmail`.
 * - Else the lower-cased profile email or UPN (matches nobody; sign-in is refused).
 * Refusals map to an address that matches nobody, so better-auth refuses with the not-set-up message.
 */
export async function signInEmailFor(profile: MicrosoftProfile, policy: EntraPolicy): Promise<string | undefined> {
  const oid = str(profile.oid);
  const tid = lower(str(profile.tid));
  if (oid) {
    const [pinned] = await adminDb
      .select({ email: user.email, tid: user.entraTenantId })
      .from(user)
      .where(eq(user.entraObjectId, oid));
    if (pinned) return pinned.tid === null || pinned.tid === tid ? pinned.email : noMatch();
  }
  const email = str(profile.email);
  const upn = str(profile.preferred_username) ?? str(profile.upn);
  const u = await findUser({ email, upn });
  if (!u) return norm(email) ?? norm(upn);
  const [pin] = await adminDb.select({ oid: user.entraObjectId }).from(user).where(eq(user.id, u.id));
  if (pin?.oid) return noMatch(); // pinned to a different Microsoft identity
  return mayLinkByEmail(u, tid, policy) ? u.email : noMatch();
}

/** The `tid` claim of an id token (already validated by better-auth), lower-cased. */
export function tenantOfIdToken(idToken: string | null | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    return lower(str((JSON.parse(Buffer.from(payload, 'base64url').toString()) as { tid?: unknown }).tid));
  } catch {
    return undefined;
  }
}

/**
 * True when the Microsoft identity (`entraObjectId`, Entra tenant `tid`) may be linked to `userId`.
 * Pinned users accept only their own identity. Otherwise: no other user holds that object id, the
 * user has no other Microsoft account link, and the tenant passes `mayLinkByEmail`.
 */
export async function entraIdentityFits(
  userId: string,
  entraObjectId: string,
  tid: string | undefined,
  policy: EntraPolicy,
): Promise<boolean> {
  const [u] = await adminDb
    .select({ oid: user.entraObjectId, tid: user.entraTenantId, platformAdmin: user.platformAdmin })
    .from(user)
    .where(eq(user.id, userId));
  if (!u) return false;
  if (u.oid !== null) return u.oid === entraObjectId && (u.tid === null || u.tid === tid);
  const [other] = await adminDb
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.entraObjectId, entraObjectId), ne(user.id, userId)))
    .limit(1);
  if (other) return false;
  const [link] = await adminDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'microsoft'), ne(account.accountId, entraObjectId)))
    .limit(1);
  if (link) return false;
  return mayLinkByEmail(u, tid, policy);
}

/** Pins the user to the Microsoft identity just linked (only when not pinned yet). */
export async function pinEntraIdentity(userId: string, entraObjectId: string, tid: string | undefined): Promise<void> {
  await adminDb
    .update(user)
    .set({ entraObjectId, entraTenantId: tid ?? null, updatedAt: new Date() })
    .where(and(eq(user.id, userId), isNull(user.entraObjectId)));
}

/**
 * After a passed gate: records the sign-in and makes invited memberships
 * active (TEN-E2-S1-AC3) with a `tenancy.member.activated` audit row in each tenant. No event: the
 * member was announced by `tenancy.member.added` at invite.
 */
export async function completeSignIn(userId: string): Promise<void> {
  const correlationId = newId('cor');
  const actor = { kind: 'user' as const, id: userId };
  await adminDb.transaction(async (tx) => {
    await tx.update(user).set({ lastSignInAt: new Date(), updatedAt: new Date() }).where(eq(user.id, userId));
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

/**
 * Where to send someone after sign-in: their last used tenant, else their first active tenant
 * (TEN-E2-S1-AC1). A platform admin's last used tenant counts even without a membership.
 */
export async function landingPathFor(userId: string): Promise<string> {
  const [u] = await adminDb
    .select({ last: user.lastTenantId, platformAdmin: user.platformAdmin })
    .from(user)
    .where(eq(user.id, userId));
  if (u?.platformAdmin && u.last) {
    const [t] = await adminDb
      .select({ slug: tenant.slug })
      .from(tenant)
      .where(and(eq(tenant.id, u.last), eq(tenant.status, 'active')));
    if (t) return `/t/${t.slug}`;
  }
  const list = await tenantsFor(userId);
  const target = list.find((t) => t.id === u?.last) ?? list[0];
  return target ? `/t/${target.slug}` : '/';
}
