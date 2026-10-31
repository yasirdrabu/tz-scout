import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// The signed-in person's sessions (src/http/routes/v1/me/sessions, no workspace needed).

export type Session = {
  id: string;
  current: boolean;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string | null;
};

export const sessionsQuery = () =>
  queryOptions({
    queryKey: ['me-sessions'],
    queryFn: () => apiFetch<{ data: Session[] }>('/me/sessions').then((r) => r.data),
  });

/** Ends every session of this person, this one included. */
export const signOutEverywhere = () => apiFetch<void>('/me:sign-out-everywhere', { method: 'POST' });
