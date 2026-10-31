import type { DataLimit } from '../../../api/me';
import type { Member, MemberStatus, Practice } from './api';

// The API sends role keys only (GET /v1/roles has no role labels), so the screen names them here,
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

/** Email addresses typed with commas, semicolons or new lines. */
export const parseEmails = (raw: string) => [...new Set(raw.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];
