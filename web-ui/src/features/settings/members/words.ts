import type { DataLimit } from '../../../api/me';
import type { Member, MemberLock, MemberStatus, Practice } from './api';

// The API sends role keys only (GET /api/v1/roles has no role labels), so the screen names them here,
// in the mockup's words. A role the app doesn't know shows its key, capitalised.
const ROLE_NAMES: Record<string, { label: string; about: string }> = {
  owner: { label: 'Owner', about: 'Everything, including members, integrations, keys and settings.' },
  operator: { label: 'Operator', about: 'Runs sources, batches, imports and the review queue.' },
  leader: { label: 'Sales leader', about: 'Sees every seller, assigns accounts, edits offers and playbooks.' },
  seller: { label: 'Account executive', about: 'Works their own accounts and playbook steps.' },
};

export const roleLabel = (role: string) => ROLE_NAMES[role]?.label ?? role.charAt(0).toUpperCase() + role.slice(1);
export const roleAbout = (role: string) => ROLE_NAMES[role]?.about ?? '';

/** Roles that can be narrowed to practices (screens.md §21a: leaders and AEs). */
export const hasPracticeAccess = (role: string) => role === 'leader' || role === 'seller';

export const STATUS_LABEL: Record<MemberStatus, string> = { active: 'Active', invited: 'Invited', suspended: 'Suspended' };

export function signInWith(m: Pick<Member, 'sign_in_method'>): string {
  if (m.sign_in_method === 'microsoft') return 'Microsoft';
  if (m.sign_in_method === 'dev') return 'Developer sign-in';
  return 'Not signed in yet';
}

/** The practices a data limit narrows to, or null for all. */
export const practiceIds = (limit: DataLimit | null): string[] | null => (limit?.kind === 'practices' ? limit.ids : null);

export function practiceText(limit: DataLimit | null, practices: Practice[]): string {
  const ids = practiceIds(limit);
  if (!ids) return 'All practices';
  if (ids.length === 1) return practices.find((p) => p.id === ids[0])?.name ?? '1 practice';
  return `${ids.length} practices`;
}

/**
 * The plain Scout sign-in address, this app's own sign-in page: invited people get in the first time
 * they sign in with Microsoft (Decision 18). The invite dialog and Copy sign-in link both use it.
 */
export const signInAddress = () => `${window.location.origin}/signin`;

/** Why the role can't change, in the screen's words (from the API's lock reason). */
export function roleLockText(lock: MemberLock | null): string | null {
  if (lock === 'self') return "You can't change your own role.";
  if (lock === 'last_owner') return 'This is the only owner. Make someone else an owner first.';
  if (lock === 'owners_only') return "Only an owner can change an owner's role.";
  if (lock === 'no_permission') return "You can't change roles.";
  return null;
}

/** Why a member can't be suspended or removed. */
export function removeLockText(lock: MemberLock | null): string | null {
  if (lock === 'self') return "You can't suspend or remove yourself.";
  if (lock === 'owner') return "Owners can't be suspended or removed. Change their role first.";
  if (lock) return "You can't suspend or remove this member.";
  return null;
}

/** Why a member can't be signed out everywhere. */
export function signOutLockText(lock: MemberLock | null): string | null {
  if (lock === 'owners_only') return 'Only an owner can sign an owner out everywhere.';
  if (lock === 'platform_admin') return 'Only a platform admin can sign a platform admin out everywhere.';
  if (lock) return "You can't sign this member out everywhere.";
  return null;
}

/** Email addresses typed with commas, semicolons or new lines. */
export const parseEmails = (raw: string) => [...new Set(raw.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];
