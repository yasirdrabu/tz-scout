import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Permission names as the backend spells them (src/modules/tenancy/domain/permissions.ts). */
export type Scope = string;

export type DataLimit =
  | { kind: 'all' }
  | { kind: 'practices'; ids: string[] }
  | { kind: 'own_accounts' }
  | { kind: 'sources'; ids: string[] }
  | { kind: 'own_source' }
  | { kind: 'any_of'; limits: DataLimit[] };

/** Exactly what today's `GET /v1/me` returns (src/app/v1/me/route.ts). */
export type Me = {
  tenant: { id: string; slug: string; name: string };
  kind: 'user' | 'api_key' | 'oauth';
  id: string;
  scopes: Scope[];
  data_limit: DataLimit;
  source_id: string | null;
  environment: 'live' | 'test' | null;
};

export type Workspace = { id: string; slug: string; name: string; role: string | null; member_count: number | null };

export function fetchMe(tenant?: string, signal?: AbortSignal): Promise<Me> {
  return apiFetch<Me>('/me', { ...(tenant ? { tenant } : {}), ...(signal ? { signal } : {}) });
}

/** The `/me` query for a workspace; no slug asks for the person's last used one. */
export const meQuery = (tenant?: string) =>
  queryOptions({
    queryKey: ['me', tenant ?? null],
    queryFn: ({ signal }) => fetchMe(tenant, signal),
    staleTime: 60_000,
  });

export const hasScope = (me: Me, scope: Scope) => me.scopes.includes(scope);

// Fields the spec needs that `/me` does not send yet (api-gaps.md tenancy, Proposed change 2).
// They are read defensively so the shell picks them up the day the API adds them.
type Loose = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function personOf(me: Me): { name: string | null; email: string | null } {
  const m = me as unknown as Loose;
  return { name: text(m.name), email: text(m.email) };
}

/** Today's `/me` has no platform admin flag, so this is false until it does. */
export function isPlatformAdmin(me: Me): boolean {
  return (me as unknown as Loose).platform_admin === true;
}

/** The person's workspaces when `/me` lists them, else just the current one. */
export function workspacesOf(me: Me): Workspace[] {
  const listed = (me as unknown as Loose).workspaces;
  if (Array.isArray(listed)) {
    const valid = listed.flatMap((w: unknown): Workspace[] => {
      if (typeof w !== 'object' || w === null) return [];
      const o = w as Loose;
      const id = text(o.id);
      const slug = text(o.slug);
      const name = text(o.name);
      return id && slug && name ? [{ id, slug, name, role: text(o.role), member_count: count(o.member_count) }] : [];
    });
    if (valid.length > 0) return valid;
  }
  return [{ ...me.tenant, role: null, member_count: null }];
}
