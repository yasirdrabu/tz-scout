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

/** The `GET /v1/me` fields the app types (src/app/v1/me/route.ts); the person fields are read below. */
export type Me = {
  /** `currency` (ISO 4217) and `timezone` (IANA) feed lib/format; read as optional. */
  tenant: { id: string; slug: string; name: string; currency?: string; timezone?: string };
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

/** Records the workspace the person switched to, so sign-in and `/` land there next time. */
export function rememberWorkspaceOnServer(slug: string): Promise<void> {
  return apiFetch<void>('/me/workspace', { method: 'PUT', body: { slug } });
}

/** Sidebar badges: null when the person cannot see that screen. */
export type Counts = { review_queue: number | null; new_assignments: number | null };

export const countsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['me-counts', tenant],
    queryFn: () => apiFetch<Counts>('/me/counts', { tenant }),
    staleTime: 60_000,
  });

// Fields `/me` sends for a person: `user { id, name, email, platform_admin }` (null for API keys)
// and `workspaces`; `tenant` is null for a person with no workspace to land in (a platform admin
// with no membership). They are read defensively.
type Loose = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const userOf = (me: Me): Loose => {
  const u = (me as unknown as Loose).user;
  return typeof u === 'object' && u !== null ? (u as Loose) : {};
};

export function personOf(me: Me): { name: string | null; email: string | null } {
  const u = userOf(me);
  return { name: text(u.name), email: text(u.email) };
}

/** The person's user id (the members list's `user_id`), or null for an API key. */
export const userIdOf = (me: Me): string | null => text(userOf(me).id);

/** What Profile shows beyond name and email: role here, sign-in method and the access lines. */
export function profileOf(me: Me): { role: string | null; signInMethod: string | null; access: string[] } {
  const loose = me as unknown as Loose;
  const lines = loose.access_summary;
  const access = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
  return { role: text(loose.role), signInMethod: text(userOf(me).sign_in_method), access };
}

/** True when `/me` says the person is a platform admin. */
export function isPlatformAdmin(me: Me): boolean {
  return userOf(me).platform_admin === true;
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
  return me.tenant ? [{ ...me.tenant, role: null, member_count: null }] : [];
}
