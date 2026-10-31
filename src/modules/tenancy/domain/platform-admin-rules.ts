/** Platform admins are Taazaa staff (screens.md §22): only these addresses can be made one. */
export const STAFF_EMAIL_DOMAIN = 'taazaa.com';

/** True for an address at the staff domain, e.g. `ana@taazaa.com` (case-insensitive). */
export function isStaffEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at > 0 && e.slice(at + 1) === STAFF_EMAIL_DOMAIN && !/\s/.test(e);
}

/**
 * Why a platform admin cannot be removed, or null when they can: nobody removes themselves, and the
 * last platform admin stays. `admins` is how many active platform admins there are now.
 */
export function adminRemovalRefusal(actorUserId: string, targetUserId: string, admins: number): 'not-yourself' | 'last-admin' | null {
  if (actorUserId === targetUserId) return 'not-yourself';
  if (admins <= 1) return 'last-admin';
  return null;
}
