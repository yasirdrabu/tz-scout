import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { exactly, problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import { category, CLAUDE_RATES, APOLLO_RATES, serveCosts, serveRates, summary } from '../../costs/testing';
import type { Call, Cap, Integration } from './api';

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
  cap: null,
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

function serve(rows: Integration[] = [HUBSPOT, APOLLO, GOVSPEND], scopes = ['integrations:manage']) {
  serveMe({ taazaa: { scopes } });
  server.use(
    http.get('/api/v1/integrations', () => HttpResponse.json({ data: rows })),
    http.get('/api/v1/integrations/:key/rates', () => HttpResponse.json({ data: [] })),
    http.get('/api/v1/integrations/:key/calls', ({ request }) => {
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
    server.use(http.get('/api/v1/integrations', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [] });
    }));
    const first = renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText('Loading integrations')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/api/v1/integrations', () => problem(500, 'Something went wrong', { ref: 'cor_i1' })));
    const second = renderApp('/t/taazaa/settings/integrations');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Integrations didn't load");
    expect(within(alert).getByText('Error ref cor_i1')).toBeInTheDocument();
    second.unmount();

    server.use(http.get('/api/v1/integrations', () => HttpResponse.json({ data: [] })));
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
      http.put('/api/v1/integrations/govspend/credential', async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ ...GOVSPEND, credentials: [{ kind: 'api_key', label: 'Key', last4: '9z9z', saved_at: '2026-10-31T10:00:00Z' }] });
      }),
      http.post(exactly('/api/v1/integrations/govspend:test'), () => HttpResponse.json({ ok: true, message: 'Read and write scopes granted.', duration_ms: 182 })),
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
    server.use(http.put('/api/v1/integrations/govspend/credential', () => problem(400, 'Paste the key or token to save it.')));
    const drawer = await openService('Connect GovSpend');
    await userEvent.type(within(drawer).getByLabelText('Paste the Key'), 'gs-key-1234567890');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByText('Paste the key or token to save it.')).toBeInTheDocument();
  });

  it('tests the connection and shows a failed result', async () => {
    serve();
    server.use(
      http.post(exactly('/api/v1/integrations/hubspot:test'), () =>
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
    server.use(http.post(exactly('/api/v1/integrations/hubspot:test'), () => problem(500, 'Something went wrong', { detail: 'Scout could not run the test.' })));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Scout could not run the test.')).toBeInTheDocument();
  });

  it('asks before switching to live, and shows the refusal', async () => {
    serve();
    server.use(http.put('/api/v1/integrations/apollo/mode', fail));
    const drawer = await openService('Manage Apollo');
    await userEvent.click(within(drawer).getByRole('radio', { name: 'Live' }));
    const confirm = await screen.findByRole('dialog', { name: 'Switch Apollo to live?' });
    expect(confirm).toHaveAccessibleDescription('Scout reads and writes real records in Apollo.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Switch to live' }));
    expect(await screen.findByText('Run a passing test in the last 10 minutes before going live.')).toBeInTheDocument();

    let body: unknown;
    server.use(http.put('/api/v1/integrations/apollo/mode', async ({ request }) => {
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
    server.use(http.put('/api/v1/integrations/:key/mode', () => {
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
    server.use(http.post(exactly('/api/v1/integrations/hubspot:disconnect'), () => problem(404, 'Not found', { detail: 'Scout has no such service.' })));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disconnect HubSpot?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Scout has no such service.')).toBeInTheDocument();

    server.use(http.post(exactly('/api/v1/integrations/hubspot:disconnect'), () => HttpResponse.json({ ...HUBSPOT, credentials: [], mode: 'mock', status: 'not_set_up' })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnected HubSpot. Scout stopped calling it and switched to sample data.')).toBeInTheDocument();
  });

  it('turns a service off and on, and shows the failure', async () => {
    serve([HUBSPOT, { ...GOVSPEND, status: 'disabled' }]);
    let body: unknown;
    server.use(http.put('/api/v1/integrations/:key/disabled', async ({ request }) => {
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
    server.use(http.put('/api/v1/integrations/govspend/disabled', () => problem(403, 'Forbidden', { detail: 'Only owners can do this.' })));
    await userEvent.click(within(gov).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Only owners can do this.')).toBeInTheDocument();
  });
});

describe('last 50 calls', () => {
  it('says when there are no calls, and when they fail to load', async () => {
    serve();
    server.use(http.get('/api/v1/integrations/govspend/calls', () => HttpResponse.json({ data: [] })));
    const drawer = await openService('Connect GovSpend');
    expect(await within(drawer).findByText('No calls yet.')).toBeInTheDocument();
    server.use(http.get('/api/v1/integrations/govspend/calls', () => problem(500, 'Something went wrong', { ref: 'cor_c1' })));
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Errors only' }));
    expect(await within(drawer).findByText("Calls didn't load")).toBeInTheDocument();
  });
});

const cap = (c: Partial<Cap>): Cap => ({
  provider_key: 'hubspot',
  unit: 'calls',
  period: 'day',
  limit: 50000,
  used: 0,
  reserved: 0,
  level: 'ok',
  resets_at: '2026-11-03T12:00:00Z',
  overage: false,
  ...c,
});
const MONTH_END = '2026-12-01T12:00:00Z';

describe('usage limits', () => {
  it('lists blocked, then overage, then warn lines', async () => {
    serve([
      { ...HUBSPOT, cap: cap({ used: 42000, level: 'warn' }) },
      { ...APOLLO, cap: cap({ provider_key: 'apollo', unit: 'credits', period: 'month', limit: 2000, used: 2000, level: 'blocked', resets_at: MONTH_END }) },
      { ...GOVSPEND, cap: cap({ provider_key: 'govspend', used: 60000, level: 'warn', overage: true }) },
    ]);
    renderApp('/t/taazaa/settings/integrations');
    await screen.findByRole('heading', { name: '1 of 2 services working' });
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(lines.slice(0, 3)).toEqual([
      'Apollo reached its monthly limit. Scout stopped calling it until Dec 1.',
      'GovSpend is allowed over its limit until Nov 3.',
      'HubSpot has used 84% of its daily limit.',
    ]);
  });

  it('rounds the percent down without float error', async () => {
    serve([{ ...HUBSPOT, cap: cap({ used: 29, limit: 100, level: 'warn' }) }]);
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText('HubSpot has used 29% of its daily limit.')).toBeInTheDocument();
  });

  it('counts held usage in the percent, as the level does', async () => {
    serve([{ ...HUBSPOT, cap: cap({ used: 30000, reserved: 12000, level: 'warn' }) }]);
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText('HubSpot has used 84% of its daily limit.')).toBeInTheDocument();
  });

  it.each([
    ['America/New_York', 'Dec 1'],
    ['America/Los_Angeles', 'Nov 30'],
  ])('writes the reset date in the tenant timezone (%s)', async (timezone, date) => {
    serve([{ ...HUBSPOT, cap: cap({ used: 50000, level: 'blocked', period: 'month', resets_at: '2026-12-01T05:00:00Z' }) }]);
    serveMe({ taazaa: { scopes: ['integrations:manage'], tenant: { id: 'taazaa', slug: 'taazaa', name: 'taazaa', timezone } } });
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText(`HubSpot reached its monthly limit. Scout stopped calling it until ${date}.`)).toBeInTheDocument();
  });

  it('shows no limit lines when everything is ok', async () => {
    serve([{ ...HUBSPOT, cap: cap({ used: 10 }) }]);
    renderApp('/t/taazaa/settings/integrations');
    await screen.findByRole('heading', { name: '1 of 1 services working' });
    expect(screen.queryByText(/limit\./)).toBeNull();
  });

  it('shows the usage line with thousands separators, and money for cost_cents', async () => {
    serve([HUBSPOT, { ...APOLLO, key: 'anthropic', name: 'Anthropic', cap: cap({ provider_key: 'anthropic', unit: 'cost_cents', period: 'month', limit: 20000, used: 1240, resets_at: MONTH_END }) }]);
    const drawer = await openService('Manage Anthropic');
    expect(within(drawer).getByText('$12.40 of $200.00 this month. Resets Dec 1.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Limit per month')).toHaveValue('20000');
  });

  it('shows calls today, and No limit.', async () => {
    serve([{ ...HUBSPOT, cap: cap({}) }, GOVSPEND]);
    const drawer = await openService('Manage HubSpot');
    expect(within(drawer).getByText('0 of 50,000 calls today. Resets Nov 3.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Connect GovSpend' }));
    const gov = await screen.findByRole('dialog', { name: 'GovSpend' });
    expect(within(gov).getByText('No limit.')).toBeInTheDocument();
  });

  it('saves a new limit and toasts', async () => {
    serve([{ ...HUBSPOT, cap: cap({}) }]);
    let body: unknown;
    server.use(http.put('/api/v1/integrations/hubspot/cap', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ cap: cap({ limit: 60000 }) });
    }));
    const drawer = await openService('Manage HubSpot');
    const input = within(drawer).getByLabelText('Limit per day');
    await userEvent.clear(input);
    await userEvent.type(input, '60000');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('Limit saved.')).toBeInTheDocument();
    expect(body).toEqual({ limit: 60000 });
  });

  it('refuses an invalid limit without sending, and shows a server error', async () => {
    serve([{ ...HUBSPOT, cap: cap({}) }]);
    let calls = 0;
    server.use(http.put('/api/v1/integrations/hubspot/cap', () => {
      calls += 1;
      return HttpResponse.json(
        { type: 'https://scout.taazaa.ai/problems/validation', title: 'Invalid', status: 400, correlation_id: 'cor_v1', errors: [{ path: 'limit', message: 'Enter a whole number of 1 or more.' }] },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    }));
    const drawer = await openService('Manage HubSpot');
    const input = within(drawer).getByLabelText('Limit per day');
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save limit' }));
    expect(input).toHaveAccessibleDescription('Enter a whole number of 1 or more.');
    expect(calls).toBe(0);

    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(calls).toBe(1));
    expect(input).toHaveAccessibleDescription('Enter a whole number of 1 or more.');
  });

  it('allows overage when blocked', async () => {
    serve([{ ...HUBSPOT, cap: cap({ used: 50000, level: 'blocked' }) }]);
    let posted = 0;
    server.use(http.post(exactly('/api/v1/integrations/hubspot/cap:allow-overage'), () => {
      posted += 1;
      return HttpResponse.json({ cap: cap({ used: 50000, level: 'blocked', overage: true }) });
    }));
    const drawer = await openService('Manage HubSpot');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Allow until Nov 3' }));
    expect(await screen.findByText('HubSpot can go over its limit until Nov 3.')).toBeInTheDocument();
    expect(posted).toBe(1);
  });
});

describe('Prices (R3a)', () => {
  const CLAUDE = { ...APOLLO, key: 'anthropic', name: 'Claude', status: 'connected' as const };

  it('shows each Claude model with its input and output price per million tokens, and saves them', async () => {
    serve([CLAUDE]);
    const seen = serveRates('anthropic', CLAUDE_RATES);
    const drawer = await openService('Manage Claude');
    const prices = await within(drawer).findByRole('region', { name: 'Prices' });
    const model = within(prices).getByRole('group', { name: 'claude-sonnet-5-5' });
    const input = within(model).getByLabelText('Input, $ per million tokens');
    expect(input).toHaveValue('3');
    expect(within(model).getByLabelText('Output, $ per million tokens')).toHaveValue('15');
    await userEvent.clear(input);
    await userEvent.type(input, '4');
    await userEvent.click(within(prices).getByRole('button', { name: 'Save prices' }));
    expect(await screen.findByText('Prices saved.')).toBeInTheDocument();
    expect(seen[0]!.body).toEqual({
      rates: [
        { item: 'claude-sonnet-5-5:input', cents_per_unit: 0.0004 },
        { item: 'claude-sonnet-5-5:output', cents_per_unit: 0.0015 },
      ],
    });
  });

  it('shows Cents per credit for Apollo and refuses a negative price', async () => {
    serve();
    const seen = serveRates('apollo', APOLLO_RATES);
    const drawer = await openService('Manage Apollo');
    const prices = await within(drawer).findByRole('region', { name: 'Prices' });
    const credit = within(prices).getByLabelText('Cents per credit');
    expect(credit).toHaveValue('2');
    await userEvent.clear(credit);
    await userEvent.type(credit, '-1');
    await userEvent.click(within(prices).getByRole('button', { name: 'Save prices' }));
    expect(credit).toHaveAccessibleDescription("A rate can't be negative.");
    expect(seen).toHaveLength(0);
    await userEvent.clear(credit);
    await userEvent.type(credit, '2.5');
    await userEvent.click(within(prices).getByRole('button', { name: 'Save prices' }));
    expect(await screen.findByText('Prices saved.')).toBeInTheDocument();
    expect(seen[0]!.body).toEqual({ rates: [{ item: 'credit', cents_per_unit: 2.5 }] });
  });

  it('says so when the prices do not load', async () => {
    serve();
    server.use(http.get('/api/v1/integrations/apollo/rates', () => problem(500, 'Down')));
    const drawer = await openService('Manage Apollo');
    expect(await within(drawer).findByText("Couldn't load prices. Try again.")).toBeInTheDocument();
  });

  it('has no Prices section for a service with no money', async () => {
    serve();
    const drawer = await openService('Manage HubSpot');
    await within(drawer).findByRole('region', { name: 'Usage limit' });
    expect(within(drawer).queryByRole('region', { name: 'Prices' })).toBeNull();
  });
});

describe('Budget banners on Integrations (R3a)', () => {
  const paused = summary({
    categories: [category({ key: 'ai_usage', label: 'AI usage', spend_month_cents: 120_000, budget_cents: 100_000, level: 'paused', pausable: true })],
  });

  it('shows the pause to people who can see costs', async () => {
    serveCosts({ scopes: ['integrations:manage', 'costs:read'], summary: paused });
    server.use(
      http.get('/api/v1/integrations', () => HttpResponse.json({ data: [HUBSPOT] })),
      http.get('/api/v1/integrations/:key/rates', () => HttpResponse.json({ data: [] })),
    );
    renderApp('/t/taazaa/settings/integrations');
    expect(await screen.findByText('AI usage is paused: it is over 110% of its November budget. Raise the budget to resume.')).toBeInTheDocument();
  });

  it('shows nothing without costs:read', async () => {
    serve([HUBSPOT]);
    renderApp('/t/taazaa/settings/integrations');
    await screen.findByRole('heading', { name: '1 of 1 services working' });
    expect(screen.queryByRole('list', { name: 'Budget alerts' })).toBeNull();
  });
});
