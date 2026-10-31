import { describe, expect, it } from 'vitest';
import { routes, type RouteEntry } from '@/http/routes';
import { createApp, MAX_BODY_BYTES } from '@/http/server';

/**
 * The real route table with each handler replaced by a stub that names its entry, so the routing
 * can be checked without a database.
 */
const stubbed: RouteEntry[] = routes.map(({ path, module }) => ({
  path,
  module: Object.fromEntries(
    Object.keys(module).map((m) => [
      m,
      async (req: Request) => Response.json({ route: path, method: req.method, url: req.url }),
    ]),
  ),
}));
const app = createApp({ routes: stubbed, webUiDist: '/nonexistent' });

async function routeOf(p: string, method = 'GET') {
  const res = await app.request(p, { method });
  expect(res.status, `${method} ${p}`).toBe(200);
  return (await res.json()) as { route: string; method: string; url: string };
}

describe('routing', () => {
  it.each([
    ['GET', '/v1/me', '/v1/me'],
    ['POST', '/v1/me:sign-out-everywhere', '/v1/:resource'],
    ['GET', '/v1/nope', '/v1/:resource'],
    ['PATCH', '/v1/members/mbr_x', '/v1/members/:id'],
    ['POST', '/v1/members/mbr_x:suspend', '/v1/members/:id'],
    ['POST', '/v1/members/mbr_x%3Asuspend', '/v1/members/:id'],
    ['POST', '/v1/accounts/acc_1:merge', '/v1/accounts/:id'],
    ['GET', '/v1/accounts/acc_1/score', '/v1/accounts/:id/score'],
    ['GET', '/v1/accounts/acc_1/score/history', '/v1/accounts/:id/score/history'],
    ['GET', '/v1/review-queue/count', '/v1/review-queue/count'],
    ['GET', '/v1/crm/owners', '/v1/crm/:resource'],
    ['POST', '/v1/crm/owners:sync', '/v1/crm/:resource'],
    ['POST', '/v1/integrations/hubspot:test', '/v1/integrations/:key'],
    ['GET', '/v1/integrations/hubspot/calls', '/v1/integrations/:key/calls'],
    ['POST', '/v1/inbound/hubspot/conn_1', '/v1/inbound/hubspot/:connectionId'],
    ['DELETE', '/v1/sources/src_1/mappings/map_1', '/v1/sources/:id/mappings/:mappingId'],
    ['GET', '/api/auth/callback/microsoft', '/api/auth/*'],
    ['POST', '/api/auth/sign-in/social', '/api/auth/*'],
    ['POST', '/api/dev/sign-in', '/api/dev/sign-in'],
    ['GET', '/healthz', '/healthz'],
    ['GET', '/readyz', '/readyz'],
  ])('%s %s goes to %s', async (method, p, route) => {
    const r = await routeOf(p, method);
    expect(r.route).toBe(route);
    expect(r.method).toBe(method);
    expect(new URL(r.url).pathname).toBe(p);
  });

  it('passes the query string through', async () => {
    const r = await routeOf('/v1/audit?limit=5&cursor=abc');
    expect(new URL(r.url).search).toBe('?limit=5&cursor=abc');
  });

  it('answers HEAD from GET with no body', async () => {
    const res = await app.request('/v1/me', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('gives a method the route does not export 405 with Allow', async () => {
    const res = await app.request('/v1/members/mbr_x', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, PATCH, DELETE, OPTIONS');
    expect(await res.text()).toBe('');
  });

  it('lists HEAD with GET in Allow', async () => {
    const res = await app.request('/healthz', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('answers OPTIONS with 204 and Allow', async () => {
    const res = await app.request('/v1/members/mbr_x', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('allow')).toBe('POST, PATCH, DELETE, OPTIONS');
  });

  it.each(['/v1', '/v1/nope/deeper', '/v1/members/mbr_x/nope', '/api', '/api/nope', '/healthz/x', '/readyz/x'])(
    'gives unknown API path %s the problem+json 404',
    async (p) => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await app.request(p, { method });
        expect(res.status, `${method} ${p}`).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json();
        expect(body).toMatchObject({ type: 'https://scout.taazaa.ai/problems/not-found', status: 404 });
        expect(body.correlation_id).toBe(res.headers.get('x-correlation-id'));
      }
    },
  );

  it('refuses a body over the server limit with 413 problem+json', async () => {
    const res = await app.request('/v1/members/mbr_x', {
      method: 'PATCH',
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
