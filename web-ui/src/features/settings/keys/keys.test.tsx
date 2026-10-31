import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { ApiKey } from './api';

const key = (k: Partial<ApiKey> & Pick<ApiKey, 'id' | 'name'>): ApiKey => ({
  prefix: 'scout_live_AbCd1234',
  mask: 'scout_live_AbCd1234…',
  environment: 'live',
  scopes: ['arrivals:write', 'arrivals:read', 'status:read'],
  source_id: 'src_rfp',
  source_name: 'RFP Watch',
  created_by: 'usr_marcus',
  created_by_name: 'Marcus Lee',
  created_at: '2026-08-02T15:00:00Z',
  last_used_at: '2026-10-31T10:00:00Z',
  last_used_ip: '10.4.2.18',
  expires_at: null,
  revoked_at: null,
  ...k,
});

const KEYS = [
  key({ id: 'key_rfp', name: 'RFP Watch agent' }),
  key({ id: 'key_kestrel', name: 'Kestrel partner portal', scopes: ['arrivals:write'], source_name: 'Kestrel Advisory', last_used_at: null }),
  key({ id: 'key_old', name: 'Old key', revoked_at: '2026-09-01T00:00:00Z' }),
];

function serve(keys: ApiKey[] = KEYS) {
  serveMe({ taazaa: { scopes: ['keys:manage', 'arrivals:read'], tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  server.use(
    http.get('/api/v1/api-keys', () => HttpResponse.json({ data: keys })),
    http.get('/api/v1/sources', () => HttpResponse.json({ data: [{ id: 'src_rfp', name: 'RFP Watch' }, { id: 'src_conf', name: 'Conference contacts agent' }], next_cursor: null })),
  );
}

beforeEach(() => localStorage.clear());

describe('API keys list', () => {
  it('lists live keys with source, what they can do, the mask and last use', async () => {
    serve();
    renderApp('/t/taazaa/settings/api-keys');
    expect(await screen.findByText('Keys let agents and partners send accounts to Scout. Each key belongs to one source.')).toBeInTheDocument();
    const rfp = (await screen.findByText('RFP Watch agent')).closest('tr')!;
    expect(rfp).toHaveTextContent('Created Aug 2, 2026 by Marcus Lee');
    expect(rfp).toHaveTextContent('Send accounts and check status');
    expect(rfp).toHaveTextContent('scout_live_AbCd1234…');
    expect(rfp).toHaveTextContent('Oct 31, 6:00 AM');
    const kestrel = screen.getByText('Kestrel partner portal').closest('tr')!;
    expect(kestrel).toHaveTextContent('Send accounts only');
    expect(kestrel).toHaveTextContent('Never');
    expect(screen.queryByText('Old key')).toBeNull();
  });

  it('shows loading, error and empty states', async () => {
    serve();
    server.use(http.get('/api/v1/api-keys', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [] });
    }));
    const first = renderApp('/t/taazaa/settings/api-keys');
    expect(await screen.findByText('Loading API keys')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/api/v1/api-keys', () => problem(500, 'Something went wrong', { ref: 'cor_k1' })));
    const second = renderApp('/t/taazaa/settings/api-keys');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("API keys didn't load");
    expect(within(alert).getByText('Error ref cor_k1')).toBeInTheDocument();
    second.unmount();

    server.use(http.get('/api/v1/api-keys', () => HttpResponse.json({ data: [KEYS[2]] })));
    renderApp('/t/taazaa/settings/api-keys');
    expect(await screen.findByRole('heading', { name: 'No API keys yet' })).toBeInTheDocument();
  });
});

describe('create a key', () => {
  async function openCreate(user: { click: (el: Element) => Promise<void> } = userEvent) {
    renderApp('/t/taazaa/settings/api-keys');
    await screen.findByText('RFP Watch agent');
    await user.click(screen.getByRole('button', { name: 'Create a key' }));
    return screen.findByRole('dialog', { name: 'Create an API key' });
  }

  it('asks for a name and a source', async () => {
    serve();
    const dialog = await openCreate();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription('Give the key a name.');
    expect(within(dialog).getByRole('combobox', { name: 'Source' })).toHaveAccessibleDescription('Pick the source this key sends accounts for.');
  });

  it('creates the key and shows it once with Copy', async () => {
    const user = userEvent.setup();
    serve();
    let body: unknown;
    server.use(
      http.post('/api/v1/api-keys', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...key({ id: 'key_new', name: 'Conference agent' }), secret: 'scout_live_8Hq2vXsecret' }, { status: 201 });
      }),
    );
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Conference agent');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Source' }), 'Conference contacts agent');
    await user.click(within(dialog).getByRole('radio', { name: /Read results only/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const done = await screen.findByRole('dialog', { name: 'Key created for Conference agent' });
    expect(body).toEqual({ name: 'Conference agent', source_id: 'src_conf', access: 'read_only' });
    expect(within(done).getByText('scout_live_8Hq2vXsecret')).toBeInTheDocument();
    expect(within(done).getByText("Copy this now. You won't see it again.")).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: 'Copy' }));
    expect(await within(done).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('scout_live_8Hq2vXsecret');
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('scout_live_8Hq2vXsecret')).toBeNull();
  });

  it('shows the API words when creating fails', async () => {
    serve();
    server.use(http.post('/api/v1/api-keys', () => problem(403, 'Forbidden', { detail: "You can't give a key permissions you don't have." })));
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Agent');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Source' }), 'RFP Watch');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText("You can't give a key permissions you don't have.")).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Create an API key' })).toBeInTheDocument();
  });
});

describe('revoke and access log', () => {
  it('revokes after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.delete('/api/v1/api-keys/key_rfp', () => problem(404, 'Not found', { detail: 'That key is already revoked.' })));
    renderApp('/t/taazaa/settings/api-keys');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke RFP Watch agent' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke RFP Watch agent?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('That key is already revoked.')).toBeInTheDocument();

    server.use(http.delete('/api/v1/api-keys/key_rfp', () => new HttpResponse(null, { status: 204 })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('RFP Watch agent revoked. Calls with it now fail.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the access log in the URL with its empty state', async () => {
    serve();
    const app = renderApp('/t/taazaa/settings/api-keys');
    await userEvent.click(await screen.findByRole('button', { name: 'Access log for Kestrel partner portal' }));
    const drawer = await screen.findByRole('dialog', { name: 'Kestrel partner portal' });
    expect(app.router.state.location.search).toEqual({ open: 'key_kestrel' });
    expect(drawer).toHaveTextContent('scout_live_AbCd1234… · Send accounts only');
    expect(within(drawer).getByRole('heading', { name: 'No calls yet' })).toBeInTheDocument();
    expect(within(drawer).getByText('They show here the first time this key is used.')).toBeInTheDocument();
  });
});
