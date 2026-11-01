import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp } from '../../../test/renderApp';
import { server } from '../../../test/server';
import { fail, serve } from './testing';

beforeEach(() => localStorage.clear());

async function openInvite(user: { click: (el: Element) => Promise<void> } = userEvent) {
  renderApp('/t/taazaa/settings/members');
  await user.click(await screen.findByRole('button', { name: 'Invite people' }));
  return screen.findByRole('dialog', { name: 'Invite people' });
}

describe('invite dialog', () => {
  it('asks for at least one address', async () => {
    serve();
    const dialog = await openInvite();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(within(dialog).getByRole('textbox', { name: 'Email addresses' })).toHaveAccessibleDescription(
      'Separate with commas or new lines. Add at least one email address.',
    );
  });

  it('invites people with a role and practice access, then gives the sign-in link', async () => {
    const user = userEvent.setup();
    serve();
    let body: unknown;
    server.use(
      http.post('/api/v1/members', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          results: [
            { email: 'ravi@taazaa.com', ok: true, membership_id: 'mbr_9', status: 'invited' },
            { email: 'jo@taazaa.com', ok: true, membership_id: 'mbr_10', status: 'invited' },
            { email: 'dana@taazaa.com', ok: false, error: { slug: 'already-member', title: 'Already a member' } },
          ],
          sign_in_url: 'https://api.example.com/signin',
        });
      }),
    );
    const dialog = await openInvite(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Email addresses' }), 'ravi@taazaa.com, jo@taazaa.com{Enter}dana@taazaa.com');
    await user.click(within(dialog).getByRole('radio', { name: /Sales leader/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Public sector' }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite 3 people' }));

    expect(await screen.findByText('Invited 2 people.')).toBeInTheDocument();
    expect(body).toEqual({
      emails: ['ravi@taazaa.com', 'jo@taazaa.com', 'dana@taazaa.com'],
      role: 'leader',
      data_limit: { kind: 'practices', ids: ['p1'] },
    });
    const done = screen.getByRole('dialog', { name: 'Invite people' });
    expect(done).toHaveTextContent(`Scout doesn't send invite emails yet. Send them this link to sign in: ${window.location.origin}/signin`);
    expect(within(done).getByText('dana@taazaa.com: Already a member')).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Sign-in link copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/signin`);
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps refused addresses in the form with their reasons', async () => {
    serve();
    server.use(
      http.post('/api/v1/members', () =>
        HttpResponse.json({
          results: [{ email: 'dana@taazaa.com', ok: false, error: { slug: 'already-member', title: 'Already a member' } }],
          sign_in_url: 'https://api.example.com/signin',
        }),
      ),
    );
    const dialog = await openInvite();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Email addresses' }), 'dana@taazaa.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await within(dialog).findByText('dana@taazaa.com: Already a member')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Email addresses' })).toHaveValue('dana@taazaa.com');
  });

  it('shows the API words when the invite fails', async () => {
    serve();
    server.use(http.post('/api/v1/members', fail));
    const dialog = await openInvite();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Email addresses' }), 'x@taazaa.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });
});

describe('Roles and permissions tab', () => {
  async function openRoles() {
    renderApp('/t/taazaa/settings/members');
    await userEvent.click(await screen.findByRole('tab', { name: 'Roles and permissions' }));
  }

  it('shows the read-only matrix with the API labels and groups', async () => {
    serve();
    await openRoles();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Sales leader' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Workspace' })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /Invite and manage members/ });
    expect(within(row).getAllByText('Yes')).toHaveLength(1);
    expect(screen.getByText(/Taazaa platform admins can act in every workspace. They aren't a role here./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull();
  });

  it('shows loading and error states', async () => {
    serve();
    server.use(http.get('/api/v1/roles', async () => {
      await delay('infinite');
      return HttpResponse.json({});
    }));
    await openRoles();
    expect(await screen.findByText('Loading roles and permissions')).toBeInTheDocument();
  });

  it('says when the roles fail to load', async () => {
    serve();
    server.use(http.get('/api/v1/roles', () => problem(500, 'Something went wrong', { ref: 'cor_r1' })));
    await openRoles();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Roles and permissions didn't load");
    expect(within(alert).getByText('Error ref cor_r1')).toBeInTheDocument();
  });
});

describe('Login history tab', () => {
  it('shows its empty state until sign-ins are recorded', async () => {
    serve();
    renderApp('/t/taazaa/settings/members');
    await userEvent.click(await screen.findByRole('tab', { name: 'Login history' }));
    expect(screen.getByRole('heading', { name: 'No sign-ins to show yet' })).toBeInTheDocument();
  });
});
