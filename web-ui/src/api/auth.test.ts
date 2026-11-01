import { http, HttpResponse } from 'msw';
import { server } from '../test/server';
import { devSignIn, devUsers, safeReturnPath, signOut, startMicrosoftSignIn } from './auth';
import { ApiError } from './errors';

describe('safeReturnPath', () => {
  it.each([
    ['/t/taazaa/queue', '/t/taazaa/queue'],
    ['/t/taazaa/accounts?stage=open#x', '/t/taazaa/accounts?stage=open#x'],
    ['/', '/'],
  ])('keeps the relative path %s', (raw, kept) => {
    expect(safeReturnPath(raw)).toBe(kept);
  });

  it.each([undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 't/x', '/signin'])(
    'refuses %s',
    (raw) => {
      expect(safeReturnPath(raw)).toBeNull();
    },
  );
});

describe('startMicrosoftSignIn', () => {
  it('posts the provider with the return and error paths and follows the URL', async () => {
    let body: unknown;
    server.use(
      http.post('/api/auth/sign-in/social', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ url: 'https://login.microsoftonline.com/x', redirect: true });
      }),
    );
    const go = vi.fn();
    await startMicrosoftSignIn('/t/taazaa/queue', go);
    expect(body).toEqual({ provider: 'microsoft', callbackURL: '/t/taazaa/queue', errorCallbackURL: '/signin' });
    expect(go).toHaveBeenCalledWith('https://login.microsoftonline.com/x');
  });

  it('returns to / when the return path is unsafe', async () => {
    let body: { callbackURL?: string } = {};
    server.use(
      http.post('/api/auth/sign-in/social', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ url: 'https://login.microsoftonline.com/x' });
      }),
    );
    await startMicrosoftSignIn('//evil.example', vi.fn());
    expect(body.callbackURL).toBe('/');
  });

  it('fails when no URL comes back', async () => {
    server.use(http.post('/api/auth/sign-in/social', () => HttpResponse.json({})));
    await expect(startMicrosoftSignIn('/', vi.fn())).rejects.toBeInstanceOf(ApiError);
  });
});

describe('developer sign-in', () => {
  it('posts the user id', async () => {
    let body: unknown;
    server.use(
      http.post('/api/dev/sign-in', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user_id: 'u1' });
      }),
    );
    await devSignIn('u1');
    expect(body).toEqual({ userId: 'u1' });
  });

  it('lists dev users when the API offers them', async () => {
    server.use(
      http.get('/api/v1/dev/users', () =>
        HttpResponse.json([{ id: 'u1', email: 'dana@taazaa.com', name: 'Dana Whitfield', platform_admin: false }]),
      ),
    );
    expect(await devUsers()).toEqual([{ id: 'u1', email: 'dana@taazaa.com', name: 'Dana Whitfield', platform_admin: false }]);
  });

  it('reports no list when the endpoint is missing', async () => {
    server.use(http.get('/api/v1/dev/users', () => new HttpResponse('Not found', { status: 404 })));
    expect(await devUsers()).toBeNull();
  });
});

describe('signOut', () => {
  it('posts to the sign-out endpoint', async () => {
    const called = vi.fn();
    server.use(
      http.post('/api/auth/sign-out', () => {
        called();
        return HttpResponse.json({ success: true });
      }),
    );
    await signOut();
    expect(called).toHaveBeenCalledOnce();
  });
});
