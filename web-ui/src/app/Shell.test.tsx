import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { rememberWorkspace } from '../lib/lastWorkspace';
import { renderApp, serveMe } from '../test/renderApp';
import { server } from '../test/server';

beforeEach(() => {
  localStorage.clear();
  server.use(http.get('/v1/dev/users', () => new HttpResponse('Not found', { status: 404 })));
});

const LEADER = ['review:act', 'assign:act', 'accounts:read', 'assignments:respond', 'analytics:read', 'offers:read', 'playbooks:read'];

describe('shell navigation', () => {
  it('shows only the items the person has permission for', async () => {
    serveMe({ taazaa: { scopes: ['accounts:read', 'assignments:respond'] } });
    renderApp('/t/taazaa/accounts');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'All accounts' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'My accounts' })).toBeInTheDocument();
    for (const hidden of ['Review queue', 'Overview', 'Sources', 'Batches and imports', 'Playbooks', 'Costs', 'Tenants']) {
      expect(within(nav).queryByRole('link', { name: hidden })).toBeNull();
    }
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
  });

  it('shows the /me/counts badges on Review queue and My accounts', async () => {
    serveMe({ taazaa: { scopes: LEADER } });
    server.use(http.get('/v1/me/counts', () => HttpResponse.json({ review_queue: 12, new_assignments: 3 })));
    renderApp('/t/taazaa/queue');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByRole('link', { name: 'Review queue 12 accounts waiting' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'My accounts 3 new assignments' })).toBeInTheDocument();
  });

  it('shows no badge for a zero or hidden count', async () => {
    serveMe({ taazaa: { scopes: LEADER } });
    server.use(http.get('/v1/me/counts', () => HttpResponse.json({ review_queue: 0, new_assignments: null })));
    renderApp('/t/taazaa/queue');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Review queue' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'My accounts' })).toBeInTheDocument();
  });

  it('shows Settings with any settings permission, opening its first tab', async () => {
    serveMe({ taazaa: { scopes: ['accounts:read', 'audit:read'] } });
    renderApp('/t/taazaa/accounts');
    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '/t/taazaa/settings/audit-log');
  });

  it('shows a placeholder naming the screen, its spec section and release', async () => {
    serveMe({ taazaa: { scopes: LEADER } });
    renderApp('/t/taazaa/queue');
    expect(await screen.findByRole('heading', { level: 1, name: 'Review queue' })).toBeInTheDocument();
    expect(screen.getByText('screens.md §2')).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
  });
});

describe('landing', () => {
  it('opens the first of Review queue, My accounts, All accounts', async () => {
    serveMe({ taazaa: { scopes: ['accounts:read', 'assignments:respond'] } });
    const app = renderApp('/t/taazaa');
    expect(await screen.findByRole('heading', { level: 1, name: 'My accounts' })).toBeInTheDocument();
    expect(app.path()).toBe('/t/taazaa/my');
  });

  it('goes from / to the last used workspace', async () => {
    rememberWorkspace('brightline');
    serveMe({ brightline: { scopes: LEADER } });
    const app = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Review queue' })).toBeInTheDocument();
    expect(app.path()).toBe('/t/brightline/queue');
  });

  it('goes from / to the workspace the API picks when none is remembered', async () => {
    serveMe({ taazaa: { scopes: ['accounts:read'] } }, 'taazaa');
    const app = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'All accounts' })).toBeInTheDocument();
    expect(app.path()).toBe('/t/taazaa/accounts');
  });

  it('goes from / to sign-in without a session', async () => {
    serveMe({});
    const app = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/signin');
  });
});

describe('session', () => {
  it('sends a 401 to sign-in with the return path', async () => {
    serveMe({});
    const app = renderApp('/t/taazaa/queue?tier=act');
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/signin');
    expect(app.router.state.location.search).toEqual({ return: '/t/taazaa/queue?tier=act' });
  });

  it('shows the API detail and error ref when /me fails', async () => {
    server.use(
      http.get('/v1/me', () =>
        HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/internal', title: 'Something went wrong', status: 500, detail: 'The database is down.', correlation_id: 'cor_7f31c2' },
          { status: 500, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderApp('/t/taazaa/queue');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The database is down.');
    expect(within(alert).getByText('Error ref cor_7f31c2')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('workspace switcher', () => {
  it('shows only the current workspace while /me has no list', async () => {
    serveMe({ taazaa: { scopes: LEADER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa' } } });
    renderApp('/t/taazaa/queue');
    await userEvent.click(await screen.findByRole('button', { name: /Switch workspace/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).getByText('Each workspace keeps its own accounts, sources and HubSpot connection.')).toBeInTheDocument();
  });

  it('switches the /t/:tenant segment and clears the query cache', async () => {
    const workspaces = [
      { id: 't1', slug: 'taazaa', name: 'Taazaa', role: 'leader', member_count: 14 },
      { id: 't2', slug: 'brightline', name: 'Brightline Logistics', role: 'leader', member_count: 6 },
    ];
    serveMe({
      taazaa: { scopes: LEADER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa' }, workspaces },
      brightline: { scopes: ['accounts:read'], tenant: { id: 't2', slug: 'brightline', name: 'Brightline Logistics' }, workspaces },
    });
    let recorded: unknown;
    server.use(
      http.put('/v1/me/workspace', async ({ request }) => {
        recorded = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const app = renderApp('/t/taazaa/queue');
    await screen.findByRole('heading', { level: 1, name: 'Review queue' });
    app.queryClient.setQueryData(['accounts', 'taazaa'], ['old']);
    expect(screen.getByText('Scout · 14 members')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Switch workspace/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Brightline Logistics/ }));

    expect(await screen.findByRole('heading', { level: 1, name: 'All accounts' })).toBeInTheDocument();
    expect(app.path()).toBe('/t/brightline/accounts');
    expect(app.queryClient.getQueryData(['accounts', 'taazaa'])).toBeUndefined();
    expect(screen.getByRole('status')).toHaveTextContent('Switched to Brightline Logistics');
    await waitFor(() => expect(localStorage.getItem('scout.workspace')).toBe('brightline'));
    expect(recorded).toEqual({ slug: 'brightline' });
  });
});

describe('header', () => {
  it('focuses search with /', async () => {
    serveMe({ taazaa: { scopes: LEADER } });
    renderApp('/t/taazaa/queue');
    const search = await screen.findByRole('searchbox', { name: 'Search' });
    expect(search).toHaveAttribute('placeholder', 'Search accounts, people and batches');
    await userEvent.keyboard('/');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');
  });
});

describe('profile menu', () => {
  it('signs out and goes to sign-in', async () => {
    serveMe({ taazaa: { scopes: LEADER, user: { id: 'm1', name: 'Dana Whitfield', email: 'dana@taazaa.com', platform_admin: false } } });
    const signedOut = vi.fn();
    server.use(
      http.post('/api/auth/sign-out', () => {
        signedOut();
        return HttpResponse.json({ success: true });
      }),
    );
    const app = renderApp('/t/taazaa/queue');
    await userEvent.click(await screen.findByRole('button', { name: /Dana Whitfield/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    expect(signedOut).toHaveBeenCalledOnce();
    expect(app.queryClient.getQueryData(['me', 'taazaa'])).toBeUndefined();
  });
});
