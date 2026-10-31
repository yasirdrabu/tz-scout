import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp } from '../../../test/renderApp';
import { server } from '../../../test/server';
import { fail, MEMBERS, serve } from './testing';

/** Opens Settings > Members and the named member's drawer. */
async function openMember(name: string, user: { click: (el: Element) => Promise<void> } = userEvent) {
  renderApp('/t/taazaa/settings/members');
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name });
}

beforeEach(() => localStorage.clear());

describe('Settings tabs', () => {
  it('shows the tabs this person has permission for', async () => {
    serve();
    renderApp('/t/taazaa/settings/members');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Members', 'Integrations', 'API keys', 'Review statuses', 'Audit log']);
    expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows Members alone with members:read and says when a tab is not open', async () => {
    serve(MEMBERS, ['members:read']);
    renderApp('/t/taazaa/settings/api-keys');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Members']);
    expect(screen.getByRole('heading', { name: "This tab isn't open to you" })).toBeInTheDocument();
  });
});

describe('Members tab', () => {
  it('lists members with role, practice access, sign-in, status and last active', async () => {
    serve();
    renderApp('/t/taazaa/settings/members');
    expect(await screen.findByRole('tab', { name: 'Members (5)' })).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table');
    const ash = within(table).getByRole('button', { name: 'Ash Patel' }).closest('tr')!;
    expect(ash).toHaveTextContent('Account executive');
    expect(ash).toHaveTextContent('Public sector');
    expect(ash).toHaveTextContent('Microsoft');
    expect(ash).toHaveTextContent('Active');
    expect(within(table).getByRole('button', { name: 'Priya Raman' }).closest('tr')).toHaveTextContent('You');
    const ravi = within(table).getByRole('button', { name: 'ravi.menon@taazaa.com' }).closest('tr')!;
    expect(ravi).toHaveTextContent('Invited');
    expect(within(ravi).getAllByText('Not signed in yet')).toHaveLength(2);
    expect(screen.getByText('3 active members use this')).toBeInTheDocument();
    expect(screen.getByText('Showing 5 of 5')).toBeInTheDocument();
  });

  it('filters by search and status', async () => {
    serve();
    renderApp('/t/taazaa/settings/members');
    await userEvent.click(await screen.findByRole('tab', { name: 'Suspended 1' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Lena Brooks' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'All 5' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search by name or email' }), 'nobody');
    expect(screen.getByRole('heading', { name: 'No members match' })).toBeInTheDocument();
  });

  it('shows the loading line while members load', async () => {
    serve();
    server.use(http.get('/v1/members', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [] });
    }));
    renderApp('/t/taazaa/settings/members');
    expect(await screen.findByText('Loading members')).toBeInTheDocument();
  });

  it('says what failed, with Try again and the error ref', async () => {
    serve();
    server.use(http.get('/v1/members', () => problem(500, 'Something went wrong', { detail: 'The database is down.', ref: 'cor_m1' })));
    renderApp('/t/taazaa/settings/members');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Members didn't load");
    expect(alert).toHaveTextContent('The database is down.');
    expect(within(alert).getByText('Error ref cor_m1')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the empty state with Invite people', async () => {
    serve([]);
    renderApp('/t/taazaa/settings/members');
    expect(await screen.findByRole('heading', { name: 'No members yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invite people' }).length).toBeGreaterThan(0);
  });

  it('hides Invite people without members:manage', async () => {
    serve(MEMBERS, ['members:read']);
    renderApp('/t/taazaa/settings/members');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Invite people' })).toBeNull();
  });
});

describe('member drawer', () => {
  it('opens from the row, puts the member in the URL and closes with Esc', async () => {
    serve();
    const app = renderApp('/t/taazaa/settings/members');
    await userEvent.click(await screen.findByRole('button', { name: 'Dana Whitfield' }));
    const drawer = await screen.findByRole('dialog', { name: 'Dana Whitfield' });
    const appSearch = () => app.router.state.location.search;
    expect(appSearch()).toEqual({ open: 'mbr_dana' });
    expect(drawer).toHaveTextContent('dana@taazaa.com');
    expect(within(drawer).getByRole('combobox', { name: 'Role' })).toHaveValue('leader');
    expect(within(drawer).getByRole('textbox', { name: 'HubSpot user' })).toHaveValue('7001');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(appSearch()).toEqual({});
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dana Whitfield' })).toHaveFocus());
  });

  it('opens straight from the URL', async () => {
    serve();
    renderApp('/t/taazaa/settings/members?open=mbr_ash');
    expect(await screen.findByRole('dialog', { name: 'Ash Patel' })).toBeInTheDocument();
  });

  it('changes the role and says when it applies', async () => {
    serve();
    let body: unknown;
    server.use(http.patch('/v1/members/mbr_dana', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(MEMBERS[1]);
    }));
    const drawer = await openMember('Dana Whitfield');
    await userEvent.selectOptions(within(drawer).getByRole('combobox', { name: 'Role' }), 'operator');
    expect(await screen.findByText('Dana Whitfield is now Operator. It applies the next time they load a page.')).toBeInTheDocument();
    expect(body).toEqual({ role: 'operator' });
  });

  it('shows the API words when the role change fails', async () => {
    serve();
    server.use(http.patch('/v1/members/mbr_dana', fail));
    const drawer = await openMember('Dana Whitfield');
    await userEvent.selectOptions(within(drawer).getByRole('combobox', { name: 'Role' }), 'operator');
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });

  it('locks your own role and suspend and remove for yourself', async () => {
    serve();
    const drawer = await openMember('Priya Raman');
    const role = within(drawer).getByRole('combobox', { name: 'Role' });
    expect(role).toBeDisabled();
    expect(role).toHaveAccessibleDescription("You can't change your own role.");
    expect(within(drawer).getByRole('button', { name: 'Suspend' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Remove from workspace' })).toBeDisabled();
    expect(within(drawer).getByText("You can't suspend or remove yourself.")).toBeInTheDocument();
  });

  it('saves practice access', async () => {
    serve();
    let body: unknown;
    server.use(http.patch('/v1/members/mbr_ash', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(MEMBERS[0]);
    }));
    const drawer = await openMember('Ash Patel');
    const group = await within(drawer).findByRole('group', { name: 'Practice access' });
    expect(within(group).getByRole('button', { name: 'Public sector' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(group).getByRole('button', { name: 'Health' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save practice access' }));
    expect(await screen.findByText('Practice access saved for Ash Patel.')).toBeInTheDocument();
    expect(body).toEqual({ data_limit: { kind: 'practices', ids: ['p1', 'p2'] } });
  });

  it('saves the HubSpot user, and shows the failure', async () => {
    serve();
    let body: unknown;
    server.use(http.patch('/v1/members/mbr_ash', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(MEMBERS[0]);
    }));
    const drawer = await openMember('Ash Patel');
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'HubSpot user' }), '9001');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save HubSpot user' }));
    expect(await screen.findByText('HubSpot user saved for Ash Patel.')).toBeInTheDocument();
    expect(body).toEqual({ crm_owner_ids: { hubspot: '9001' } });

    server.use(http.patch('/v1/members/mbr_ash', fail));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save HubSpot user' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });

  it('suspends, and shows the failure', async () => {
    serve();
    server.use(http.post('/v1/members/mbr_dana:suspend', () => HttpResponse.json({ ...MEMBERS[1], status: 'suspended' })));
    const drawer = await openMember('Dana Whitfield');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText("Dana Whitfield suspended. They can't use this workspace until you reactivate them.")).toBeInTheDocument();

    server.use(http.post('/v1/members/mbr_dana:suspend', fail));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });

  it('reactivates, and shows the failure', async () => {
    serve();
    server.use(http.post('/v1/members/mbr_lena:reactivate', () => HttpResponse.json(MEMBERS[2])));
    const drawer = await openMember('Lena Brooks');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('Lena Brooks reactivated.')).toBeInTheDocument();

    server.use(http.post('/v1/members/mbr_lena:reactivate', fail));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });

  it('removes after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.delete('/v1/members/mbr_ash', fail));
    const drawer = await openMember('Ash Patel');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Remove from workspace' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Ash Patel?' });
    expect(confirm).toHaveAccessibleDescription(
      'Their 23 open accounts go back to the review queue to be reassigned. Their sign-in history is kept.',
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();

    server.use(http.delete('/v1/members/mbr_ash', () => new HttpResponse(null, { status: 204 })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Ash Patel removed from the workspace.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('signs a member out everywhere after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.post('/v1/members/mbr_dana:sign-out-everywhere', fail));
    const drawer = await openMember('Dana Whitfield');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Sign out of every device' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sign Dana Whitfield out everywhere?' });
    expect(confirm).toHaveAccessibleDescription('This signs them out of every workspace on every device.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();

    server.use(http.post('/v1/members/mbr_dana:sign-out-everywhere', () => new HttpResponse(null, { status: 204 })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Dana Whitfield is signed out of every device.')).toBeInTheDocument();
  });

  it('copies the sign-in link and revokes an invite', async () => {
    const user = userEvent.setup();
    serve();
    server.use(http.delete('/v1/members/mbr_ravi', () => new HttpResponse(null, { status: 204 })));
    const drawer = await openMember('ravi.menon@taazaa.com', user);
    await user.click(within(drawer).getByRole('button', { name: 'Copy sign-in link' }));
    expect(await screen.findByText('Sign-in link copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/signin`);
    await user.click(within(drawer).getByRole('button', { name: 'Revoke invite' }));
    expect(await screen.findByText('Invite to ravi.menon@taazaa.com revoked.')).toBeInTheDocument();
  });

  it('shows a read-only drawer without members:manage', async () => {
    serve(MEMBERS, ['members:read']);
    const drawer = await openMember('Dana Whitfield');
    expect(within(drawer).queryByRole('combobox', { name: 'Role' })).toBeNull();
    expect(within(drawer).getByText('Sales leader')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Suspend' })).toBeNull();
  });
});

describe('revoke invite', () => {
  it('shows the API words when revoking fails', async () => {
    serve();
    server.use(http.delete('/v1/members/mbr_ravi', fail));
    const drawer = await openMember('ravi.menon@taazaa.com');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Revoke invite' }));
    expect(await screen.findByText('The API refused this change.')).toBeInTheDocument();
  });
});
