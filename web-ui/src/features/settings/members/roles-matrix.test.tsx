import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import { OWNER, PRIYA, serve } from './testing';

beforeEach(() => localStorage.clear());

const view = (role: string, permissions: string[], extra: Record<string, unknown> = {}) => ({
  role,
  permissions,
  default_permissions: permissions,
  customised: false,
  locked: false,
  ...extra,
});

const ROLES = {
  roles: [
    view('owner', ['accounts:read', 'members:manage'], { locked: true }),
    view('leader', ['accounts:read']),
    view('seller', ['accounts:read'], { default_permissions: [], customised: true }),
    view('operator', ['accounts:read']),
    view('viewer', ['accounts:read']),
  ],
  permissions: [
    { key: 'accounts:read', label: 'See every account', group: 'Accounts' },
    { key: 'members:manage', label: 'Invite and manage members', group: 'Workspace' },
  ],
};

const SAVED = 'Permissions saved. They apply the next time each member loads a page.';

async function openRoles(scopes = OWNER, platformAdmin = false) {
  serve(undefined, scopes);
  if (platformAdmin) serveMe({ taazaa: { scopes, user: { ...PRIYA, platform_admin: true } } });
  server.use(http.get('/api/v1/roles', () => HttpResponse.json(ROLES)));
  renderApp('/t/taazaa/settings/members');
  await userEvent.click(await screen.findByRole('tab', { name: 'Roles and permissions' }));
  await screen.findByRole('table');
}

/** Records each PUT /roles/{role} body and answers with the role. */
function capturePuts() {
  const puts: { role: string; permissions: string[] }[] = [];
  server.use(
    http.put('/api/v1/roles/:role', async ({ request, params }) => {
      const { permissions } = (await request.json()) as { permissions: string[] };
      puts.push({ role: String(params.role), permissions });
      return HttpResponse.json(view(String(params.role), permissions));
    }),
  );
  return puts;
}

const cell = (permission: string, role: string) => screen.getByRole('checkbox', { name: `${permission} for ${role}` });

describe('editable roles matrix', () => {
  it('shows the Viewer column and marks a customised role', async () => {
    await openRoles();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Viewer' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Account executive/ })).toHaveTextContent('Customised');
    expect(within(table).getByRole('columnheader', { name: 'Viewer' })).not.toHaveTextContent('Customised');
  });

  it("saves a toggled cell as that role's new list, then toasts", async () => {
    const user = userEvent.setup();
    await openRoles();
    const puts = capturePuts();
    const save = screen.getByRole('button', { name: 'Save permissions' });
    expect(save).toBeDisabled();
    await user.click(cell('Invite and manage members', 'Account executive'));
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByText(SAVED)).toBeInTheDocument();
    expect(puts).toEqual([{ role: 'seller', permissions: ['accounts:read', 'members:manage'] }]);
  });

  it('locks the Owner column with its description', async () => {
    await openRoles();
    const owner = cell('Invite and manage members', 'Owner');
    expect(owner).toBeChecked();
    expect(owner).toBeDisabled();
    expect(owner).toHaveAccessibleDescription('Owner always has every permission.');
  });

  it('Restore defaults then Save puts each changed role back to its defaults', async () => {
    const user = userEvent.setup();
    await openRoles();
    const puts = capturePuts();
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(cell('See every account', 'Account executive')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    expect(await screen.findByText(SAVED)).toBeInTheDocument();
    expect(puts).toEqual([{ role: 'seller', permissions: [] }]);
  });

  it('Discard drops the draft', async () => {
    const user = userEvent.setup();
    await openRoles();
    await user.click(cell('Invite and manage members', 'Viewer'));
    expect(cell('Invite and manage members', 'Viewer')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(cell('Invite and manage members', 'Viewer')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
  });

  it('shows the API detail when a save is refused and keeps the draft', async () => {
    const user = userEvent.setup();
    await openRoles();
    const detail = "You can't give the `members:manage` permission because you don't have it.";
    server.use(http.put('/api/v1/roles/:role', () => problem(403, 'Not available to you', { detail })));
    await user.click(cell('Invite and manage members', 'Viewer'));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    expect(await screen.findByText(detail)).toBeInTheDocument();
    expect(cell('Invite and manage members', 'Viewer')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled();
  });

  it('disables permissions the editor lacks', async () => {
    await openRoles(['members:read', 'members:manage']);
    expect(cell('See every account', 'Viewer')).toBeDisabled();
    expect(cell('Invite and manage members', 'Viewer')).toBeEnabled();
  });

  it('lets a platform admin edit every permission', async () => {
    await openRoles(['members:read', 'members:manage'], true);
    expect(cell('See every account', 'Viewer')).toBeEnabled();
  });

  it('stays read only without members:manage', async () => {
    await openRoles(['members:read']);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Viewer' })).toBeInTheDocument();
  });
});
