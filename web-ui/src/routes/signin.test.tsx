import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp, serveMe } from '../test/renderApp';
import { server } from '../test/server';

beforeEach(() => {
  localStorage.clear();
});

const devOn = () => http.get('/api/v1/auth/config', () => HttpResponse.json({ methods: ['microsoft'], dev_sign_in: true }));

describe('sign-in', () => {
  it('offers Microsoft sign-in', async () => {
    renderApp('/signin');
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
  });

  it.each([
    ['not_set_up', "Your account isn't a member of any workspace yet. Ask your owner for an invite."],
    ['account_turned_off', 'Your account is turned off. Ask your owner to turn it back on.'],
    ['sign_in_failed', "Sign-in didn't work. Try again, and if it keeps failing, ask your owner."],
    ['something_new', "Sign-in didn't work. Try again, and if it keeps failing, ask your owner."],
  ])('explains the %s error', async (code, copy) => {
    renderApp(`/signin?error=${code}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });

  it('offers only the methods the API reports', async () => {
    server.use(
      http.get('/api/v1/auth/config', () => HttpResponse.json({ methods: [], dev_sign_in: false })),
      http.get('/api/v1/dev/users', () => HttpResponse.json([{ id: 'u1', email: 'dana@taazaa.com', name: 'Dana Whitfield', platform_admin: false }])),
    );
    renderApp('/signin');
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Continue with Microsoft' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Sign in as' })).toBeNull();
  });

  it('offers Microsoft when the sign-in config does not load', async () => {
    server.use(http.get('/api/v1/auth/config', () => new HttpResponse(null, { status: 500 })));
    renderApp('/signin');
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
  });

  it('lists dev users when the API reports dev sign-in on', async () => {
    server.use(
      devOn(),
      http.get('/api/v1/dev/users', () => HttpResponse.json([{ id: 'u1', email: 'dana@taazaa.com', name: 'Dana Whitfield', platform_admin: true }])),
    );
    renderApp('/signin');
    expect(await screen.findByRole('heading', { name: 'Sign in as' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dana@taazaa.com · Platform admin/ })).toBeInTheDocument();
    expect(screen.getByText('Developer sign-in is on. Turn it off before anyone outside the team can reach this app.')).toBeInTheDocument();
  });

  it('starts Microsoft sign-in with the return path', async () => {
    let body: unknown;
    server.use(
      http.post('/api/auth/sign-in/social', async ({ request }) => {
        body = await request.json();
        // A same-document URL, so jsdom can follow it.
        return HttpResponse.json({ url: '#microsoft' });
      }),
    );
    renderApp('/signin?return=%2Ft%2Ftaazaa%2Fqueue');
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Microsoft' }));
    await vi.waitFor(() => expect(window.location.hash).toBe('#microsoft'));
    expect(body).toMatchObject({ provider: 'microsoft', callbackURL: '/t/taazaa/queue', errorCallbackURL: '/signin' });
  });

  it('signs in as a dev user and goes back to the return path', async () => {
    server.use(
      devOn(),
      http.get('/api/v1/dev/users', () =>
        HttpResponse.json([{ id: 'u1', email: 'dana@taazaa.com', name: 'Dana Whitfield', platform_admin: false }]),
      ),
    );
    let signedIn = false;
    server.use(
      http.post('/api/dev/sign-in', () => {
        signedIn = true;
        return HttpResponse.json({ user_id: 'u1' });
      }),
    );
    serveMe({ taazaa: { scopes: ['review:act'] } });
    const app = renderApp('/signin?return=%2Ft%2Ftaazaa%2Fqueue');
    await userEvent.click(await screen.findByRole('button', { name: /Dana Whitfield/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Review queue' })).toBeInTheDocument();
    expect(signedIn).toBe(true);
    expect(app.path()).toBe('/t/taazaa/queue');
  });

  it('shows the API detail when dev sign-in is refused', async () => {
    server.use(
      devOn(),
      http.get('/api/v1/dev/users', () => HttpResponse.json([{ id: 'u9', email: 'gone@taazaa.com', name: 'Gone', platform_admin: false }])),
      http.post('/api/dev/sign-in', () =>
        HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/forbidden', title: "Your account isn't set up in Scout yet.", status: 403 },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderApp('/signin');
    await userEvent.click(await screen.findByRole('button', { name: /Gone/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your account isn't set up in Scout yet.");
  });
});
