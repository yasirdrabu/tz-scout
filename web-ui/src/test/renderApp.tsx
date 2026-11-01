import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { Me } from '../api/me';
import { AppRoot, createApp } from '../router';
import { server } from './server';

export const ME: Me = {
  tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa' },
  kind: 'user',
  id: 'm1',
  scopes: [],
  data_limit: { kind: 'all' },
  source_id: null,
  environment: null,
};

/** `/api/v1/me` answering per tenant header; a missing entry is a 401. */
export function serveMe(byTenant: Record<string, Partial<Me> & Record<string, unknown>>, fallback?: string) {
  server.use(
    http.get('/api/v1/me', ({ request }) => {
      const slug = request.headers.get('x-scout-tenant') ?? fallback;
      const me = slug ? byTenant[slug] : undefined;
      if (!me) {
        return HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/unauthenticated', title: 'Sign in or send a valid API key.', status: 401 },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return HttpResponse.json({ ...ME, tenant: { id: slug, slug, name: slug }, ...me });
    }),
  );
}

export function renderApp(path: string) {
  const app = createApp({ history: createMemoryHistory({ initialEntries: [path] }), retry: false });
  const view = render(<AppRoot app={app} />);
  return { ...view, ...app, path: () => app.router.state.location.href };
}

export const ADMIN_USER = { id: 'usr_sam', name: 'Sam Okafor', email: 'sam@taazaa.com', platform_admin: true };

/**
 * `/api/v1/me` for a person with no workspace to land in (a platform admin with no membership): no
 * tenant, no scopes, every active tenant in `workspaces`. A tenant header is answered by `byTenant`.
 */
export function serveNoTenantMe(
  user: Record<string, unknown> = ADMIN_USER,
  workspaces: unknown[] = [],
  byTenant: Record<string, Partial<Me> & Record<string, unknown>> = {},
) {
  server.use(
    http.get('/api/v1/me', ({ request }) => {
      const slug = request.headers.get('x-scout-tenant');
      if (!slug) return HttpResponse.json({ ...ME, user, tenant: null, workspaces, scopes: [], data_limit: null });
      const me = byTenant[slug];
      if (!me) {
        return HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/unauthenticated', title: 'Sign in or send a valid API key.', status: 401 },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return HttpResponse.json({ ...ME, user, workspaces, tenant: { id: slug, slug, name: slug }, ...me });
    }),
  );
}
