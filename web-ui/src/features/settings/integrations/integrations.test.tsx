import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { exactly, problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { Call, Integration } from './api';

const service = (s: Partial<Integration> & Pick<Integration, 'key' | 'name'>): Integration => ({
  used_for: '',
  group: 'Data and enrichment',
  mode: 'mock',
  status: 'not_set_up',
  last_error: null,
  last_tested_at: null,
  last_call_at: null,
  calls_today: 0,
  calls_today_cap: null,
  errors_today: 0,
  avg_ms: null,
  credentials: [],
  ...s,
});

const HUBSPOT = service({
  key: 'hubspot',
  name: 'HubSpot',
  used_for: 'Companies, owners, deals and activity',
  group: 'CRM',
  mode: 'live',
  status: 'connected',
  last_call_at: '2026-10-31T09:58:00Z',
  calls_today: 1284,
  errors_today: 3,
  avg_ms: 182,
  credentials: [{ kind: 'private_app_token', label: 'Private app token', last4: '4f2a', saved_at: '2026-08-02T10:00:00Z' }],
});
const APOLLO = service({ key: 'apollo', name: 'Apollo', status: 'failing', last_error: 'Apollo said the key is not valid.', credentials: [{ kind: 'api_key', label: 'Key', last4: 'b81e', saved_at: '2026-08-02T10:00:00Z' }] });
const GOVSPEND = service({ key: 'govspend', name: 'GovSpend', used_for: 'Public sector bids and budgets' });

const CALLS: Call[] = [
  { id: 'c1', at: '2026-10-31T09:58:00Z', operation: 'hubspot.test', outcome: 'ok', status_code: 200, duration_ms: 182, error_message: null },
  { id: 'c2', at: '2026-10-31T09:40:00Z', operation: 'hubspot.companies.search', outcome: 'rate_limited', status_code: 429, duration_ms: 90, error_message: 'Too many calls' },
];

function serve(rows: Integration[] = [HUBSPOT, APOLLO, GOVSPEND]) {
  serveMe({ taazaa: { scopes: ['integrations:manage'] } });
  server.use(
    http.get('/v1/integrations', () => HttpResponse.json({ data: rows })),
    http.get('/v1/integrations/:key/calls', ({ request }) => {
      const errorsOnly = new URL(request.url).searchParams.get('errors_only') === 'true';
      return HttpResponse.json({ data: errorsOnly ? CALLS.filter((c) => c.outcome !== 'ok') : CALLS });
    }),
  );
}

const fail = () => problem(409, 'Test first', { detail: 'Run a passing test in the last 10 minutes before going live.' });

async function openService(label: string) {
  renderApp('/t/taazaa/settings/integrations');
  await userEvent.click(await screen.findByRole('button', { name: label }));
  return screen.findByRole('dialog');
}

beforeEach(() => localStorage.clear());

describe('Integrations list', () => {
  it('shows the summary and services grouped, with mode, status, last call and calls today', async () => {
    serve();
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByRole('heading', { name: '1 of 2 services working' })).toBeInTheDocument();
    expect(screen.getByText('Apollo is failing: Apollo said the key is not valid.')).toBeInTheDocument();
    const crm = screen.getByRole('region', { name: 'CRM' });
    const row = within(crm).getByText('HubSpot').closest('tr')!;
    expect(row).toHaveTextContent('Companies, owners, deals and activity');
    expect(row).toHaveTextContent('Live');
    expect(row).toHaveTextContent('Working');
    expect(row).toHaveTextContent('1,284');
    expect(within(row).getByRole('button', { name: 'Manage HubSpot' })).toBeInTheDocument();
    const data = screen.getByRole('region', { name: 'Data and enrichment' });
    const gov = within(data).getByText('GovSpend').closest('tr')!;
    expect(gov).toHaveTextContent('Using sample data');
    expect(gov).toHaveTextContent('Not set up');
    expect(gov).toHaveTextContent('Never');
    expect(within(gov).getByRole('button', { name: 'Connect GovSpend' })).toBeInTheDocument();
  });

  it('shows loading, error and empty states', async () => {
    serve();
    server.use(http.get('/v1/integrations', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [] });
    }));
    const first = renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText('Loading integrations')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/integrations', () => problem(500, 'Something went wrong', { ref: 'cor_i1' })));
    const second = renderApp('/t/taazaa/settings/integrations');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Integrations didn't load");
    expect(within(alert).getByText('Error ref cor_i1')).toBeInTheDocument();
    second.unmount();

    server.use(http.get('/v1/integrations', () => HttpResponse.json({ data: [] })));
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByRole('heading', { name: 'No services to connect' })).toBeInTheDocument();
  });
});

describe('manage panel', () => {
  it('opens in the URL with the masked credential, usage tiles and last 50 calls', async () => {
    serve();
    const drawer = await openService('Manage HubSpot');
    expect(drawer).toHaveAccessibleName('HubSpot');
    expect(within(drawer).getByText('••••••••4f2a')).toBeInTheDocument();
    expect(within(drawer).getByText('Saved. Ends in 4f2a.')).toBeInTheDocument();
    expect(within(drawer).getByText('182 ms')).toBeInTheDocument();
    expect(await within(drawer).findByText('hubspot.test')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Errors only' }));
    expect(await within(drawer).findByText('Too many calls')).toBeInTheDocument();
    expect(within(drawer).queryByText('hubspot.test')).toBeNull();
  });

  it('checks the paste before saving', async () => {
    serve();
    const drawer = await openService('Connect GovSpend');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save and test' }));
    expect(within(drawer).getByLabelText('Paste the Key')).toHaveAccessibleDescription('Paste the Key first. You can find it in GovSpend settings.');
    await userEvent.type(within(drawer).getByLabelText('Paste the Key'), 'abc');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save and test' }));
    expect(within(drawer).getByLabelText('Paste the Key')).toHaveAccessibleDescription('That is too short to be a Key. Check you copied all of it.');
  });

  it('saves and tests a credential', async () => {
    serve();
    let saved: unknown;
    server.use(
      http.put('/v1/integrations/govspend/credential', async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ ...GOVSPEND, credentials: [{ kind: 'api_key', label: 'Key', last4: '9z9z', saved_at: '2026-10-31T10:00:00Z' }] });
      }),
      http.post(exactly('/v1/integrations/govspend:test'), () => HttpResponse.json({ ok: true, message: 'Read and write scopes granted.', duration_ms: 182 })),
    );
    const drawer = await openService('Connect GovSpend');
    await userEvent.type(within(drawer).getByLabelText('Paste the Key'), 'gs-key-1234567890');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByText('Saved and connected. Round trip 182 ms.')).toBeInTheDocument();
    expect(saved).toEqual({ kind: 'api_key', value: 'gs-key-1234567890' });
    expect(within(drawer).getByText('Connected. Round trip 182 ms.')).toBeInTheDocument();
    expect(within(drawer).getByText('Read and write scopes granted.')).toBeInTheDocument();
  });

  it('shows the API words when saving fails', async () => {
    serve();
    server.use(http.put('/v1/integrations/govspend/credential', () => problem(400, 'Paste the key or token to save it.')));
    const drawer = await openService('Connect GovSpend');
    await userEvent.type(within(drawer).getByLabelText('Paste the Key'), 'gs-key-1234567890');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByText('Paste the key or token to save it.')).toBeInTheDocument();
  });

  it('tests the connection and shows a failed result', async () => {
    serve();
    server.use(
      http.post(exactly('/v1/integrations/hubspot:test'), () =>
        HttpResponse.json({ ok: false, message: 'HubSpot refused the token.', missing_permissions: ['crm.objects.deals.write'], duration_ms: 90 }),
      ),
    );
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(within(drawer).getByText('Missing: crm.objects.deals.write')).toBeInTheDocument());
    expect(within(drawer).getAllByText('HubSpot refused the token.').length).toBeGreaterThan(0);
  });

  it('shows the API words when the test call fails', async () => {
    serve();
    server.use(http.post(exactly('/v1/integrations/hubspot:test'), () => problem(500, 'Something went wrong', { detail: 'Scout could not run the test.' })));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Scout could not run the test.')).toBeInTheDocument();
  });

  it('asks before switching to live, and shows the refusal', async () => {
    serve();
    server.use(http.put('/v1/integrations/apollo/mode', fail));
    const drawer = await openService('Manage Apollo');
    await userEvent.click(within(drawer).getByRole('radio', { name: 'Live' }));
    const confirm = await screen.findByRole('dialog', { name: 'Switch Apollo to live?' });
    expect(confirm).toHaveAccessibleDescription('Scout reads and writes real records in Apollo.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Switch to live' }));
    expect(await screen.findByText('Run a passing test in the last 10 minutes before going live.')).toBeInTheDocument();

    let body: unknown;
    server.use(http.put('/v1/integrations/apollo/mode', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...APOLLO, mode: 'live' });
    }));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Switch to live' }));
    expect(await screen.findByText('Apollo is live.')).toBeInTheDocument();
    expect(body).toEqual({ mode: 'live' });
  });

  it('keeps sample data when the confirm is declined, and switches back without asking', async () => {
    serve();
    let calls = 0;
    server.use(http.put('/v1/integrations/:key/mode', () => {
      calls += 1;
      return HttpResponse.json({ ...HUBSPOT, mode: 'mock' });
    }));
    const apollo = await openService('Manage Apollo');
    await userEvent.click(within(apollo).getByRole('radio', { name: 'Live' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep sample data' }));
    expect(calls).toBe(0);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Manage HubSpot' }));
    const hubspot = await screen.findByRole('dialog', { name: 'HubSpot' });
    await userEvent.click(within(hubspot).getByRole('radio', { name: 'Using sample data' }));
    expect(await screen.findByText('HubSpot is using sample data.')).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('disconnects after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.post(exactly('/v1/integrations/hubspot:disconnect'), () => problem(404, 'Not found', { detail: 'Scout has no such service.' })));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disconnect HubSpot?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Scout has no such service.')).toBeInTheDocument();

    server.use(http.post(exactly('/v1/integrations/hubspot:disconnect'), () => HttpResponse.json({ ...HUBSPOT, credentials: [], mode: 'mock', status: 'not_set_up' })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnected HubSpot. Scout stopped calling it and switched to sample data.')).toBeInTheDocument();
  });

  it('turns a service off and on, and shows the failure', async () => {
    serve([HUBSPOT, { ...GOVSPEND, status: 'disabled' }]);
    let body: unknown;
    server.use(http.put('/v1/integrations/:key/disabled', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(HUBSPOT);
    }));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('HubSpot turned off. Scout stops calling it.')).toBeInTheDocument();
    expect(body).toEqual({ disabled: true });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Connect GovSpend' }));
    const gov = await screen.findByRole('dialog', { name: 'GovSpend' });
    server.use(http.put('/v1/integrations/govspend/disabled', () => problem(403, 'Forbidden', { detail: 'Only owners can do this.' })));
    await userEvent.click(within(gov).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Only owners can do this.')).toBeInTheDocument();
  });
});

describe('last 50 calls', () => {
  it('says when there are no calls, and when they fail to load', async () => {
    serve();
    server.use(http.get('/v1/integrations/govspend/calls', () => HttpResponse.json({ data: [] })));
    const drawer = await openService('Connect GovSpend');
    expect(await within(drawer).findByText('No calls yet.')).toBeInTheDocument();
    server.use(http.get('/v1/integrations/govspend/calls', () => problem(500, 'Something went wrong', { ref: 'cor_c1' })));
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Errors only' }));
    expect(await within(drawer).findByText("Calls didn't load")).toBeInTheDocument();
  });
});
