import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { formatDateTime } from '../../../lib/format';
import { exactly, problem } from '../../../test/http';
import { renderApp, serveNoTenantMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { AdminTenant, PlatformAdmin } from './api';

const tenant = (t: Partial<AdminTenant> & Pick<AdminTenant, 'id' | 'slug' | 'name'>): AdminTenant => ({
  currency: 'USD',
  timezone: 'America/New_York',
  status: 'active',
  created_at: '2026-08-02T15:00:00Z',
  member_count: 14,
  owner: { name: 'Priya Raman', email: 'priya.raman@taazaa.com' },
  ...t,
});

const TENANTS = [
  tenant({ id: 't_taazaa', slug: 'taazaa', name: 'Taazaa' }),
  tenant({ id: 't_harbor', slug: 'harbor', name: 'Harbor Health Partners', member_count: 22, currency: 'EUR', timezone: 'Europe/Berlin', owner: null }),
  tenant({ id: 't_meridian', slug: 'meridian', name: 'Meridian Public Sector', status: 'suspended', member_count: 3 }),
];

const ADMINS: PlatformAdmin[] = [
  { user_id: 'usr_sam', name: 'Sam Okafor', email: 'sam@taazaa.com', last_sign_in_at: '2026-10-31T12:12:00Z' },
  { user_id: 'usr_lena', name: 'Lena Ortiz', email: 'lena@taazaa.com', last_sign_in_at: null },
];

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function serve(tenants: AdminTenant[] = TENANTS, admins: PlatformAdmin[] = ADMINS, total = tenants.length) {
  serveNoTenantMe();
  server.use(
    http.get('/v1/admin/tenants', () =>
      HttpResponse.json({
        data: tenants,
        summary: {
          total,
          active: tenants.filter((t) => t.status === 'active').length,
          suspended: tenants.filter((t) => t.status === 'suspended').length,
        },
      }),
    ),
    http.get('/v1/admin/platform-admins', () => HttpResponse.json({ data: admins })),
  );
}

beforeEach(() => localStorage.clear());

describe('Tenants list', () => {
  it('shows the Tenants tile and each tenant with its address, status, members and created date', async () => {
    serve();
    renderApp('/admin/tenants');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tenants' })).toBeInTheDocument();
    expect(screen.getByText('Each tenant is a separate company on Scout. Nothing is shared between tenants.')).toBeInTheDocument();
    expect(await screen.findByText('2 active · 1 suspended')).toBeInTheDocument();
    const taazaa = screen.getByRole('button', { name: 'Taazaa' }).closest('tr')!;
    expect(taazaa).toHaveTextContent(`${window.location.host}/t/taazaa`);
    expect(taazaa).toHaveTextContent('Active');
    expect(taazaa).toHaveTextContent('14');
    expect(taazaa).toHaveTextContent('Aug 2, 2026');
    expect(screen.getByRole('button', { name: 'Meridian Public Sector' }).closest('tr')).toHaveTextContent('Suspended');
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
  });

  it("shows the API's total in the Tenants tile, not its own count", async () => {
    serve(TENANTS, ADMINS, 12);
    renderApp('/admin/tenants');
    const tile = (await screen.findByText('Tenants', { selector: 'div' })).parentElement!;
    expect(tile).toHaveTextContent('12');
    expect(screen.getByText('Showing 3 of 12')).toBeInTheDocument();
  });

  it('shows loading, error and empty states', async () => {
    serve();
    server.use(
      http.get('/v1/admin/tenants', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const first = renderApp('/admin/tenants');
    expect(await screen.findByText('Loading tenants')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/admin/tenants', () => problem(500, 'Something went wrong', { detail: 'The database is down.', ref: 'cor_t1' })));
    const second = renderApp('/admin/tenants');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Tenants didn't load");
    expect(alert).toHaveTextContent('The database is down.');
    expect(within(alert).getByText('Error ref cor_t1')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    second.unmount();

    serve([]);
    renderApp('/admin/tenants');
    expect(await screen.findByRole('heading', { name: 'No tenants yet' })).toBeInTheDocument();
    expect(screen.getByText('0 active · 0 suspended')).toBeInTheDocument();
  });
});

describe('tenant drawer', () => {
  it('opens in the URL with General, closes with Esc and returns focus', async () => {
    serve();
    const app = renderApp('/admin/tenants');
    const name = await screen.findByRole('button', { name: 'Harbor Health Partners' });
    await userEvent.click(name);
    const drawer = await screen.findByRole('dialog', { name: 'Harbor Health Partners' });
    expect(app.router.state.location.search).toEqual({ open: 't_harbor' });
    expect(drawer).toHaveTextContent('No owner yet');
    expect(drawer).toHaveTextContent('22');
    expect(drawer).toHaveTextContent('EUR');
    expect(drawer).toHaveTextContent('Europe/Berlin');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.router.state.location.search).toEqual({});
    await waitFor(() => expect(screen.getByRole('button', { name: 'Harbor Health Partners' })).toHaveFocus());
  });

  it('suspends after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.post(exactly('/v1/admin/tenants/t_taazaa:suspend'), () => problem(409, 'That tenant is already suspended.', { slug: 'not-active' })));
    renderApp('/admin/tenants?open=t_taazaa');
    const drawer = await screen.findByRole('dialog', { name: 'Taazaa' });
    expect(drawer).toHaveTextContent('Priya Raman · priya.raman@taazaa.com');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Suspend tenant' }));
    const confirm = await screen.findByRole('dialog', { name: 'Suspend Taazaa?' });
    expect(confirm).toHaveTextContent('Nobody in it can sign in or use its API keys until you resume it.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('That tenant is already suspended.')).toBeInTheDocument();

    let called = 0;
    server.use(
      http.post(exactly('/v1/admin/tenants/t_taazaa:suspend'), () => {
        called++;
        return HttpResponse.json({ ...TENANTS[0], status: 'suspended' });
      }),
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('Taazaa suspended.')).toBeInTheDocument();
    expect(called).toBe(1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Suspend Taazaa?' })).toBeNull());
  });

  it('resumes a suspended tenant, and shows the failure', async () => {
    serve();
    server.use(http.post(exactly('/v1/admin/tenants/t_meridian:resume'), () => problem(409, 'That tenant is not suspended.', { slug: 'not-suspended' })));
    renderApp('/admin/tenants?open=t_meridian');
    const drawer = await screen.findByRole('dialog', { name: 'Meridian Public Sector' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Resume tenant' }));
    expect(await screen.findByText('That tenant is not suspended.')).toBeInTheDocument();

    server.use(http.post(exactly('/v1/admin/tenants/t_meridian:resume'), () => HttpResponse.json({ ...TENANTS[2], status: 'active' })));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Resume tenant' }));
    expect(await screen.findByText('Meridian Public Sector resumed.')).toBeInTheDocument();
  });
});

describe('new tenant', () => {
  async function openPanel() {
    renderApp('/admin/tenants');
    await screen.findByRole('button', { name: 'Taazaa' });
    await userEvent.click(screen.getByRole('button', { name: 'New tenant' }));
    return screen.findByRole('dialog', { name: 'New tenant' });
  }

  it('asks for the name, slug and owner email', async () => {
    serve();
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    expect(within(panel).getByRole('textbox', { name: 'Company name' })).toHaveAccessibleDescription('Add the company name.');
    expect(within(panel).getByRole('textbox', { name: 'Slug' })).toHaveAccessibleDescription(expect.stringContaining('Add a slug.'));
    expect(within(panel).getByRole('textbox', { name: 'Owner email' })).toHaveAccessibleDescription(
      "They get the Owner role and sign in with Microsoft. Add the owner's email.",
    );
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Owner email' }), 'not-an-email');
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    expect(within(panel).getByRole('textbox', { name: 'Owner email' })).toHaveAccessibleDescription(expect.stringContaining("That doesn't look like an email address."));
  });

  it('creates a tenant with Scout defaults, then offers Open tenant and Done', async () => {
    serve();
    let body: unknown;
    server.use(
      http.post('/v1/admin/tenants', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(tenant({ id: 't_north', slug: 'northwind-advisory', name: 'Northwind Advisory', owner: { name: 'dana@northwind.com', email: 'dana@northwind.com' } }), { status: 201 });
      }),
    );
    const panel = await openPanel();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Company name' }), 'Northwind Advisory');
    expect(within(panel).getByRole('textbox', { name: 'Slug' })).toHaveValue('northwind-advisory');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Owner email' }), 'dana@northwind.com');
    expect(within(panel).getByRole('textbox', { name: 'Currency' })).toHaveValue('USD');
    await userEvent.selectOptions(within(panel).getByRole('combobox', { name: 'Timezone' }), 'Europe/London');
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));

    const ready = await screen.findByRole('dialog', { name: 'Northwind Advisory is ready' });
    expect(body).toEqual({ name: 'Northwind Advisory', slug: 'northwind-advisory', owner_email: 'dana@northwind.com', currency: 'USD', timezone: 'Europe/London' });
    expect(ready).toHaveTextContent('dana@northwind.com is invited as the owner.');
    await userEvent.click(within(ready).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the new tenant', async () => {
    serve();
    serveNoTenantMe(undefined, [], { 'northwind-advisory': { scopes: ['accounts:read'] } });
    server.use(http.post('/v1/admin/tenants', () => HttpResponse.json(tenant({ id: 't_north', slug: 'northwind-advisory', name: 'Northwind Advisory' }), { status: 201 })));
    const panel = await openPanel();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Company name' }), 'Northwind Advisory');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Owner email' }), 'dana@northwind.com');
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    const ready = await screen.findByRole('dialog', { name: 'Northwind Advisory is ready' });
    await userEvent.click(within(ready).getByRole('button', { name: 'Open tenant' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'All accounts' })).toBeInTheDocument();
  });

  it('shows a taken slug and other refusals under their field', async () => {
    serve();
    server.use(http.post('/v1/admin/tenants', () => problem(409, 'That short name is taken.', { slug: 'slug-taken' })));
    const panel = await openPanel();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Company name' }), 'Taazaa');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Owner email' }), 'priya@taazaa.com');
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    expect(await within(panel).findByText('That slug is taken. Pick another.')).toBeInTheDocument();

    server.use(
      http.post('/v1/admin/tenants', () =>
        HttpResponse.json(
          { type: 'https://scout.taazaa.ai/problems/validation', title: 'Check the request.', status: 400, errors: [{ path: 'currency', message: 'Use a three-letter currency code.' }] },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    expect(await within(panel).findByText('Use a three-letter currency code.')).toBeInTheDocument();

    server.use(http.post('/v1/admin/tenants', () => problem(500, 'Something went wrong', { detail: 'The database is down.' })));
    await userEvent.click(within(panel).getByRole('button', { name: 'Create tenant' }));
    expect(await screen.findByText('The database is down.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New tenant' })).toBeInTheDocument();
  });
});

describe('platform admins', () => {
  it('lists admins with their last sign-in, and no Remove for yourself', async () => {
    serve();
    renderApp('/admin/tenants');
    const list = (await screen.findByText('lena@taazaa.com')).closest('table')!;
    const sam = within(list).getByText('sam@taazaa.com').closest('tr')!;
    expect(sam).toHaveTextContent('You');
    expect(sam).toHaveTextContent(formatDateTime('2026-10-31T12:12:00Z', zone));
    expect(within(sam).queryByRole('button', { name: /Remove/ })).toBeNull();
    const lena = screen.getByText('lena@taazaa.com').closest('tr')!;
    expect(lena).toHaveTextContent('Never');
    expect(within(lena).getByRole('button', { name: 'Remove Lena Ortiz' })).toBeInTheDocument();
  });

  it('shows loading, error and empty states', async () => {
    serve();
    server.use(
      http.get('/v1/admin/platform-admins', async () => {
        await delay('infinite');
        return HttpResponse.json({ data: [] });
      }),
    );
    const first = renderApp('/admin/tenants');
    expect(await screen.findByText('Loading platform admins')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/admin/platform-admins', () => problem(500, 'Something went wrong', { ref: 'cor_p1' })));
    const second = renderApp('/admin/tenants');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Platform admins didn't load");
    expect(within(alert).getByText('Error ref cor_p1')).toBeInTheDocument();
    second.unmount();

    serve(TENANTS, []);
    renderApp('/admin/tenants');
    expect(await screen.findByRole('heading', { name: 'No platform admins' })).toBeInTheDocument();
  });

  it('removes after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.delete('/v1/admin/platform-admins/usr_lena', () => problem(409, 'Scout needs at least one platform admin.', { slug: 'last-admin' })));
    renderApp('/admin/tenants');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Lena Ortiz' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Lena Ortiz?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Scout needs at least one platform admin.')).toBeInTheDocument();

    server.use(http.delete('/v1/admin/platform-admins/usr_lena', () => new HttpResponse(null, { status: 204 })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Lena Ortiz is no longer a platform admin.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('adds an admin by email, with refusals under the field', async () => {
    serve();
    let body: unknown;
    server.use(http.post('/v1/admin/platform-admins', () => problem(400, 'Use an @taazaa.com email.', { slug: 'not-staff-email' })));
    renderApp('/admin/tenants');
    await userEvent.click(await screen.findByRole('button', { name: 'Add platform admin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add platform admin' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add platform admin' }));
    expect(within(dialog).getByRole('textbox', { name: 'Work email' })).toHaveAccessibleDescription(expect.stringContaining('Add their work email.'));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Work email' }), 'ravi@gmail.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add platform admin' }));
    expect(await within(dialog).findByText('Use an @taazaa.com email.')).toBeInTheDocument();

    server.use(
      http.post('/v1/admin/platform-admins', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user_id: 'usr_ravi', name: 'Ravi Menon', email: 'ravi@taazaa.com', last_sign_in_at: null }, { status: 201 });
      }),
    );
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Work email' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Work email' }), 'ravi@taazaa.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add platform admin' }));
    expect(await screen.findByText('Ravi Menon is now a platform admin.')).toBeInTheDocument();
    expect(body).toEqual({ email: 'ravi@taazaa.com' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
