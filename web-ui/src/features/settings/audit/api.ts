import { infiniteQueryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// The audit log (src/http/routes/v1/audit): newest first, cursor paged.

export type AuditEntry = {
  id: string;
  actor_kind: string;
  actor_id: string;
  api_key_id: string | null;
  support_access: boolean;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  ip: string | null;
  at: string;
  area: string;
  actor_name: string | null;
  api_key_name: string | null;
};

/** The API's area keys (domain/audit-areas.ts) and what the filter calls them. */
export const AREAS: { area: string; label: string }[] = [
  { area: 'tenants', label: 'Tenants' },
  { area: 'members', label: 'Members' },
  { area: 'sign_in', label: 'Sign-in' },
  { area: 'api_keys', label: 'API keys' },
  { area: 'settings', label: 'Settings' },
  { area: 'integrations', label: 'Integrations' },
  { area: 'sources', label: 'Sources' },
  { area: 'other', label: 'Other' },
];

export const areaLabel = (area: string) => AREAS.find((a) => a.area === area)?.label ?? area;

export type AuditFilters = { q: string; area: string; who: string };

type Page = { data: AuditEntry[]; next_cursor: string | null };

export const auditQuery = (tenant: string, f: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ['audit', tenant, f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (f.q) p.set('q', f.q);
      if (f.area) p.set('area', f.area);
      if (f.who) p.set('actor_id', f.who);
      if (pageParam) p.set('cursor', pageParam);
      const qs = p.toString();
      return apiFetch<Page>(`/audit${qs ? `?${qs}` : ''}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
  });
