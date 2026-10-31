import { and, asc, eq, isNull } from 'drizzle-orm';
import { platformAudit } from '@/platform/audit';
import { adminDb, adminTransaction } from '@/platform/db/client';
import type { Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { adminRemovalRefusal, isStaffEmail } from '../domain/platform-admin-rules';
import { user } from '../db/schema';
import { forgetAccess } from './principal';
import type { AdminActor } from './tenants';

export type PlatformAdmin = { userId: string; name: string; email: string; lastSignInAt: Date | null };

const cols = { userId: user.id, name: user.name, email: user.email, lastSignInAt: user.lastSignInAt };
const active = and(eq(user.platformAdmin, true), isNull(user.disabledAt));

/** Platform admins who are not turned off, by email. */
export async function platformAdmins(tx?: Tx): Promise<PlatformAdmin[]> {
  return (tx ?? adminDb).select(cols).from(user).where(active).orderBy(asc(user.email));
}

/**
 * Makes an @taazaa.com address a platform admin, creating the person if Scout does not know them yet
 * (they sign in with Microsoft from Taazaa's home tenant). Audited as `tenancy.platform_admin.added`.
 * 400 `not-staff-email`, 409 `already-admin` or `account-turned-off`.
 */
export async function addPlatformAdmin(by: AdminActor, rawEmail: string): Promise<PlatformAdmin> {
  const email = rawEmail.trim().toLowerCase();
  if (!isStaffEmail(email)) {
    throw new ScoutError({ slug: 'not-staff-email', status: 400, title: 'Use an @taazaa.com email.' });
  }
  const added = await adminTransaction(by.tx, async (tx) => {
    await tx
      .insert(user)
      .values({ id: newId('usr'), name: email.split('@')[0] ?? email, email })
      .onConflictDoNothing({ target: user.email });
    const [u] = await tx
      .select({ ...cols, platformAdmin: user.platformAdmin, disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.email, email))
      .for('update');
    if (u!.platformAdmin) throw new ScoutError({ slug: 'already-admin', status: 409, title: 'Already a platform admin.' });
    if (u!.disabledAt) {
      throw new ScoutError({ slug: 'account-turned-off', status: 409, title: 'That account is turned off.' });
    }
    await tx.update(user).set({ platformAdmin: true, updatedAt: new Date() }).where(eq(user.id, u!.userId));
    await platformAudit(
      {
        actor: by.actor,
        correlationId: by.correlationId,
        action: 'tenancy.platform_admin.added',
        subject: { type: 'user', id: u!.userId },
        after: { email, platformAdmin: true },
      },
      tx,
    );
    return { userId: u!.userId, name: u!.name, email: u!.email, lastSignInAt: u!.lastSignInAt };
  });
  forgetAccess({ userId: added.userId });
  return added;
}

/**
 * Takes the platform admin flag away. Nobody removes themselves (403 `not-yourself`) and the last
 * platform admin stays (409 `last-admin`); 404 when the user is not a platform admin. The admin rows
 * are locked, so two removals at once cannot leave none. Audited as `tenancy.platform_admin.removed`.
 */
export async function removePlatformAdmin(by: AdminActor, userId: string): Promise<void> {
  await adminTransaction(by.tx, async (tx) => {
    const admins = await tx.select({ id: user.id, email: user.email }).from(user).where(active).for('update');
    const target = admins.find((a) => a.id === userId);
    if (!target) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That platform admin was not found.' });
    const refusal = adminRemovalRefusal(by.actor.id, userId, admins.length);
    if (refusal === 'not-yourself') {
      throw new ScoutError({ slug: 'not-yourself', status: 403, title: "You can't remove yourself." });
    }
    if (refusal === 'last-admin') {
      throw new ScoutError({ slug: 'last-admin', status: 409, title: "Scout needs at least one platform admin." });
    }
    await tx.update(user).set({ platformAdmin: false, updatedAt: new Date() }).where(eq(user.id, userId));
    await platformAudit(
      {
        actor: by.actor,
        correlationId: by.correlationId,
        action: 'tenancy.platform_admin.removed',
        subject: { type: 'user', id: userId },
        before: { email: target.email, platformAdmin: true },
        after: { platformAdmin: false },
      },
      tx,
    );
  });
  forgetAccess({ userId });
}
