import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';

const SESSIONS = [
  { id: 'ses_1', current: true, ip: '10.4.2.18', user_agent: 'Chrome on Windows', created_at: '2026-10-31T08:00:00Z', last_active_at: '2026-10-31T09:59:00Z' },
  { id: 'ses_2', current: false, ip: '10.4.2.19', user_agent: 'Safari on iPhone', created_at: '2026-10-30T08:00:00Z', last_active_at: null },
];

function serve() {
  serveMe({
    taazaa: {
      scopes: ['accounts:read'],
      tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' },
      user: { id: 'usr_dana', name: 'Dana Whitfield', email: 'dana@taazaa.com', platform_admin: false, sign_in_method: 'microsoft' },
      role: 'leader',
      access_summary: ['Accounts in the Public sector practice'],
    },
  });
  server.use(http.get('/v1/me/sessions', () => HttpResponse.json({ data: SESSIONS })));
}

beforeEach(() => localStorage.clear());

describe('Profile', () => {
  it('shows name, email, role, practice access, sign-in method and sessions', async () => {
    serve();
    renderApp('/t/taazaa/profile');
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield in Taazaa')).toBeInTheDocument();
    const you = screen.getByRole('region', { name: 'You' });
    expect(you).toHaveTextContent('dana@taazaa.com');
    expect(you).toHaveTextContent('Sales leader');
    expect(you).toHaveTextContent('Accounts in the Public sector practice');
    expect(you).toHaveTextContent('Microsoft');
    const current = (await screen.findByText('Chrome on Windows')).closest('tr')!;
    expect(current).toHaveTextContent('This device');
    expect(current).toHaveTextContent('10.4.2.18');
    expect(screen.getByText('Safari on iPhone').closest('tr')).toHaveTextContent('Not recorded');
  });

  it('shows loading and error states for sessions', async () => {
    serve();
    server.use(http.get('/v1/me/sessions', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [] });
    }));
    const first = renderApp('/t/taazaa/profile');
    expect(await screen.findByText('Loading your sessions')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/me/sessions', () => problem(500, 'Something went wrong', { ref: 'cor_s1' })));
    renderApp('/t/taazaa/profile');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your sessions didn't load");
    expect(within(alert).getByText('Error ref cor_s1')).toBeInTheDocument();
  });

  it('says when there are no sessions', async () => {
    serve();
    server.use(http.get('/v1/me/sessions', () => HttpResponse.json({ data: [] })));
    renderApp('/t/taazaa/profile');
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('signs out of every device after the confirm and goes to sign-in', async () => {
    serve();
    let called = false;
    server.use(http.post(exactly('/v1/me:sign-out-everywhere'), () => {
      called = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const app = renderApp('/t/taazaa/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out of every device' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of every device?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
    expect(screen.getByText("You're signed out of every device.")).toBeInTheDocument();
    expect(called).toBe(true);
    expect(app.queryClient.getQueryData(['me', 'taazaa'])).toBeUndefined();
  });

  it('shows the API words when signing out everywhere fails', async () => {
    serve();
    server.use(http.post(exactly('/v1/me:sign-out-everywhere'), () => problem(403, 'Forbidden', { detail: 'Only a person can do this.' })));
    renderApp('/t/taazaa/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out of every device' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Only a person can do this.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Sign out of every device?' })).toBeInTheDocument();
  });

  it('signs out, and shows the failure', async () => {
    serve();
    server.use(http.post('/api/auth/sign-out', () => problem(500, 'Something went wrong', { detail: 'Sign-out did not finish.' })));
    renderApp('/t/taazaa/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Sign-out did not finish.')).toBeInTheDocument();

    server.use(http.post('/api/auth/sign-out', () => HttpResponse.json({ success: true })));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Scout' })).toBeInTheDocument();
  });
});
