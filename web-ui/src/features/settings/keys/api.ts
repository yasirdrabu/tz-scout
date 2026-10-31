import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// API keys (src/app/v1/api-keys, Decision 14). The secret comes back once, from create.

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  mask: string;
  environment: 'live' | 'test';
  scopes: string[];
  source_id: string | null;
  source_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export type Access = 'send_and_status' | 'send_only' | 'read_only';

/** The three choices the create dialog offers. The API turns each into permissions (domain/key-access.ts). */
export const ACCESS: { access: Access; label: string; about: string; scopes: string[] }[] = [
  {
    access: 'send_and_status',
    label: 'Send accounts and check status',
    about: 'Post new accounts and read back their review status.',
    scopes: ['arrivals:write', 'arrivals:read', 'status:read'],
  },
  { access: 'send_only', label: 'Send accounts only', about: 'Post new accounts. Cannot read anything back.', scopes: ['arrivals:write'] },
  { access: 'read_only', label: 'Read results only', about: 'Read account status and results. Cannot send accounts.', scopes: ['accounts:read', 'status:read'] },
];

/** "Can do" for a key: the choice its permissions came from, else the permissions themselves. */
export function canDo(scopes: string[]): string {
  const has = new Set(scopes);
  const match = ACCESS.find((a) => a.scopes.length === has.size && a.scopes.every((s) => has.has(s)));
  return match?.label ?? scopes.join(', ');
}

export const keysQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['api-keys', tenant],
    queryFn: () => apiFetch<{ data: ApiKey[] }>('/api-keys', { tenant }).then((r) => r.data),
  });

export const sourcesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['sources', tenant, 'names'],
    queryFn: () => apiFetch<{ data: { id: string; name: string }[] }>('/sources?limit=200', { tenant }).then((r) => r.data),
    staleTime: 60_000,
  });

export const createKey = (tenant: string, body: { name: string; source_id: string; access: Access }) =>
  apiFetch<ApiKey & { secret: string }>('/api-keys', { tenant, method: 'POST', body });

export const revokeKey = (tenant: string, id: string) => apiFetch<void>(`/api-keys/${encodeURIComponent(id)}`, { tenant, method: 'DELETE' });
