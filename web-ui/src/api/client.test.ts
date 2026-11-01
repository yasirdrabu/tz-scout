import { http, HttpResponse } from 'msw';
import { server } from '../test/server';
import { API_BASE, apiFetch } from './client';
import { ApiError, UnauthorizedError } from './errors';

describe('apiFetch', () => {
  it('uses one base path', () => {
    expect(API_BASE).toBe('/api/v1');
  });

  it('sends the tenant, a new correlation id per request and includes credentials', async () => {
    const seen: Request[] = [];
    server.use(
      http.get('/api/v1/me', ({ request }) => {
        seen.push(request);
        return HttpResponse.json({ ok: true });
      }),
    );
    expect(await apiFetch('/me', { tenant: 'taazaa' })).toEqual({ ok: true });
    await apiFetch('/me', { tenant: 'taazaa' });
    const [first, second] = seen;
    expect(first?.headers.get('x-scout-tenant')).toBe('taazaa');
    expect(first?.headers.get('accept')).toContain('application/json');
    expect(first?.credentials).toBe('include');
    expect(first?.headers.get('idempotency-key')).toBeNull();
    const ids = [first?.headers.get('x-correlation-id'), second?.headers.get('x-correlation-id')];
    expect(ids[0]).toMatch(/^[A-Za-z0-9._:-]{6,128}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('leaves out the tenant header when there is no tenant', async () => {
    let tenant: string | null = 'unset';
    server.use(
      http.get('/api/v1/me', ({ request }) => {
        tenant = request.headers.get('x-scout-tenant');
        return HttpResponse.json({});
      }),
    );
    await apiFetch('/me');
    expect(tenant).toBeNull();
  });

  it('sends JSON and an Idempotency-Key on POST', async () => {
    let request: Request | undefined;
    server.use(
      http.post('/api/v1/things', async ({ request: r }) => {
        request = r.clone();
        return HttpResponse.json({ id: 't1' }, { status: 201 });
      }),
    );
    await apiFetch('/things', { tenant: 'taazaa', method: 'POST', body: { name: 'A' } });
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('idempotency-key')).toMatch(/.{8,}/);
    expect(await request?.json()).toEqual({ name: 'A' });
  });

  it('returns undefined for 204', async () => {
    server.use(http.delete('/api/v1/things/t1', () => new HttpResponse(null, { status: 204 })));
    expect(await apiFetch('/things/t1', { tenant: 'taazaa', method: 'DELETE' })).toBeUndefined();
  });

  it('maps problem+json to ApiError with the detail and the correlation id as the ref', async () => {
    server.use(
      http.get('/api/v1/accounts', () =>
        HttpResponse.json(
          {
            type: 'https://scout.taazaa.ai/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: 'Only a person can do this.',
            correlation_id: 'cor_01ABC',
          },
          { status: 403, headers: { 'content-type': 'application/problem+json', 'x-correlation-id': 'cor_01ABC' } },
        ),
      ),
    );
    const error = await apiFetch('/accounts', { tenant: 'taazaa' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, title: 'Forbidden', detail: 'Only a person can do this.', code: 'forbidden', ref: 'cor_01ABC' });
    expect((error as ApiError).message).toBe('Only a person can do this.');
  });

  it('types a 401 as UnauthorizedError', async () => {
    server.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/unauthenticated', title: 'Sign in or send a valid API key.', status: 401 },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const error = await apiFetch('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('maps a non-JSON error to an ApiError with the request correlation id', async () => {
    let sent: string | null = null;
    server.use(
      http.get('/api/v1/broken', ({ request }) => {
        sent = request.headers.get('x-correlation-id');
        return new HttpResponse('<html>oops</html>', { status: 502, headers: { 'content-type': 'text/html' } });
      }),
    );
    const error = await apiFetch('/broken').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, title: 'Something went wrong', code: 'unknown' });
    expect((error as ApiError).ref).toBe(sent);
  });

  it('maps a network failure to an ApiError with status 0', async () => {
    server.use(http.get('/api/v1/down', () => HttpResponse.error()));
    const error = await apiFetch('/down').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network', title: "Scout can't be reached" });
  });
});
