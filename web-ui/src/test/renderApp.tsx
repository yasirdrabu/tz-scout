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

/** `/v1/me` answering per tenant header; a missing entry is a 401. */
export function serveMe(byTenant: Record<string, Partial<Me> & Record<string, unknown>>, fallback?: string) {
  server.use(
    http.get('/v1/me', ({ request }) => {
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
