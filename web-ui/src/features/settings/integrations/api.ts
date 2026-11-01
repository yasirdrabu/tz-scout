import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// The Integrations screen (src/http/routes/v1/integrations). Every write answers with the service's row.

export type IntegrationStatus = 'not_set_up' | 'connected' | 'failing' | 'disabled';

export type Credential = { kind: string; label: string; last4: string | null; saved_at: string };

export type Integration = {
  key: string;
  name: string;
  used_for: string;
  group: string;
  mode: 'mock' | 'live';
  status: IntegrationStatus;
  last_error: string | null;
  last_tested_at: string | null;
  last_call_at: string | null;
  calls_today: number;
  calls_today_cap: number | null;
  errors_today: number;
  avg_ms: number | null;
  credentials: Credential[];
};

export type TestResult = { ok: boolean; message: string; missing_permissions?: string[]; duration_ms: number };

export type Call = {
  id: string;
  at: string;
  operation: string;
  outcome: string;
  status_code: number | null;
  duration_ms: number | null;
  error_message: string | null;
};

const path = (key: string) => `/integrations/${encodeURIComponent(key)}`;

export const integrationsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['integrations', tenant],
    queryFn: () => apiFetch<{ data: Integration[] }>('/integrations', { tenant }).then((r) => r.data),
  });

export const callsQuery = (tenant: string, key: string, errorsOnly: boolean) =>
  queryOptions({
    queryKey: ['integrations', tenant, key, 'calls', errorsOnly],
    queryFn: () => apiFetch<{ data: Call[] }>(`${path(key)}/calls?errors_only=${errorsOnly}`, { tenant }).then((r) => r.data),
  });

export const saveCredential = (tenant: string, key: string, body: { kind: string; value: string }) =>
  apiFetch<Integration>(`${path(key)}/credential`, { tenant, method: 'PUT', body });

export const testIntegration = (tenant: string, key: string) => apiFetch<TestResult>(`${path(key)}:test`, { tenant, method: 'POST' });

export const setMode = (tenant: string, key: string, mode: 'mock' | 'live') =>
  apiFetch<Integration>(`${path(key)}/mode`, { tenant, method: 'PUT', body: { mode } });

export const setDisabled = (tenant: string, key: string, disabled: boolean) =>
  apiFetch<Integration>(`${path(key)}/disabled`, { tenant, method: 'PUT', body: { disabled } });

export const disconnect = (tenant: string, key: string) => apiFetch<Integration>(`${path(key)}:disconnect`, { tenant, method: 'POST' });

/**
 * What a service's credential is called. The row lists only saved credentials, not the kinds a
 * service needs, so a first credential is picked from every kind the API takes (CREDENTIAL_KINDS,
 * labels as src/modules/integrations/domain/labels.ts).
 */
export const CREDENTIAL_KINDS: { kind: string; label: string }[] = [
  { kind: 'api_key', label: 'Key' },
  { kind: 'private_app_token', label: 'Private app token' },
  { kind: 'oauth_tokens', label: 'Sign-in tokens' },
  { kind: 'client_secret', label: 'Client secret' },
];
