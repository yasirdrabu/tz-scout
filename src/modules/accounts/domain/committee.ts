import type { RoleOrigin } from '../contracts/types';

export const CORE_ROLES = ['business_owner', 'commercial_buyer', 'technical_buyer'];

export type CoverageStatus = 'covered' | 'guessed' | 'gap';
export type CommitteePerson = { id: string; name: string; title: string | null; origin: RoleOrigin };
export type CommitteeRole = { key: string; label: string; required: boolean; status: CoverageStatus; people: CommitteePerson[] };
export type CommitteeSummary = { covered: number; required: number; text: string };

type RoleInput = { key: string; label: string; sort: number; archived: boolean };
type PersonInput = { id: string; name: string; title: string | null; roles: { key: string; origin: RoleOrigin }[] };
type OfferInput = { requiredRoles: string[]; optionalRoles: string[] } | null;

/**
 * How well the account's people cover the offer's buying roles. The roles are the offer's required ones, then its optional ones,
 * in the tenant's role order. With no offer (or no required roles on it) the required roles are the core three. Archived roles are dropped.
 */
export function coverage(
  roles: RoleInput[],
  people: PersonInput[],
  offer: OfferInput,
): { roles: CommitteeRole[]; summary: CommitteeSummary; gaps: string[]; coreRoles: boolean } {
  const active = roles.filter((r) => !r.archived).sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  const live = (keys: string[]) => keys.filter((k) => active.some((r) => r.key === k));
  const hasOffer = !!offer && live(offer.requiredRoles).length > 0;
  const required = hasOffer ? live(offer.requiredRoles) : CORE_ROLES;
  const optional = hasOffer ? live(offer.optionalRoles).filter((k) => !required.includes(k)) : [];
  const rows: CommitteeRole[] = active
    .filter((r) => required.includes(r.key) || optional.includes(r.key))
    .map((r) => {
      const holders = people.flatMap((p) => {
        const held = p.roles.find((x) => x.key === r.key);
        return held ? [{ id: p.id, name: p.name, title: p.title, origin: held.origin }] : [];
      });
      const status: CoverageStatus = holders.some((h) => h.origin !== 'guessed_from_title') ? 'covered' : holders.length ? 'guessed' : 'gap';
      return { key: r.key, label: r.label, required: required.includes(r.key), status, people: holders };
    });
  const need = rows.filter((r) => r.required);
  const covered = need.filter((r) => r.status === 'covered').length;
  return {
    roles: rows,
    summary: { covered, required: need.length, text: `${covered} of ${need.length} ${need.length === 1 ? 'role' : 'roles'} covered` },
    coreRoles: !hasOffer,
    gaps: need.filter((r) => r.status === 'gap').map((r) => r.key),
  };
}
