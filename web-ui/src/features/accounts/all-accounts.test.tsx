import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { AccountFacets, AccountRow } from './api';

const account = (a: Partial<AccountRow> & Pick<AccountRow, 'account_id' | 'name'>): AccountRow => ({
  domain: null,
  industry: 'Public agency',
  hq_city: 'Miami',
  hq_state: 'FL',
  priority: 79,
  stage: 'engaged',
  stage_label: 'Engaged',
  owner_user_id: 'usr_ash',
  owner_name: 'Ash Patel',
  practice_name: null,
  lead_offer: { offer_id: 'off_mb', name: 'Modernization Blueprint', practice_id: 'p', practice_name: 'Data and Engineering for AI Readiness', chosen: false },
  source: { source_id: 'src_rfp', name: 'RFP Watch', kind: 'agent', via: 'Marcus Lee · GovSpend' },
  last_activity: { kind: 'meeting', at: '2026-10-23T10:00:00Z' },
  value: { amount_cents: 21_000_000, currency: 'USD', kind: 'open_deal', deal_name: 'Pilot' },
  ...a,
});

const FACETS: AccountFacets = {
  total: 14,
  won_this_year: 3,
  stages: [
    { key: 'arrived', label: 'Arrived', count: 4 },
    { key: 'reviewed', label: 'Reviewed', count: 1 },
    { key: 'assigned', label: 'Assigned', count: 2 },
    { key: 'engaged', label: 'Engaged', count: 3 },
    { key: 'opportunity', label: 'Opportunity', count: 1 },
    { key: 'won', label: 'Won', count: 3 },
    { key: 'other', label: 'Other', count: 0 },
  ],
  owners: [
    { value: 'usr_ash', label: 'Ash Patel', count: 8 },
    { value: 'unassigned', label: 'Unassigned', count: 6 },
  ],
  practices: [],
  sources: [{ value: 'src_rfp', label: 'RFP Watch', count: 5 }],
};

const ROWS = [
  account({ account_id: 'acc_hollis', name: 'Hollis Freight Lines' }),
  account({ account_id: 'acc_anchor', name: 'Anchor Bay Logistics', owner_user_id: null, owner_name: null, stage: 'declined', stage_label: 'Not pursued', last_activity: null, value: null }),
];

function serve(rows = ROWS) {
  const seen: URL[] = [];
  serveMe({ taazaa: { scopes: ['accounts:read'] } });
  server.use(
    http.get('/api/v1/accounts', ({ request }) => {
      const u = new URL(request.url);
      seen.push(u);
      const empty = u.searchParams.get('q') === 'nothing';
      return HttpResponse.json({ data: empty ? [] : rows, next_cursor: null, total: empty ? 0 : 14 });
    }),
    http.get('/api/v1/accounts/facets', () => HttpResponse.json(FACETS)),
  );
  return seen;
}

const params = (href: string) => new URL(href, 'http://app').searchParams;

beforeEach(() => localStorage.clear());

describe('All accounts', () => {
  it('shows the subtitle, stage tabs from the API and the rows, sorted by stage then priority', async () => {
    const seen = serve();
    renderApp('/t/taazaa/accounts');
    expect(await screen.findByText('14 accounts across every stage. 3 won this year.')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Stage' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All 14', 'Arrived 4', 'Reviewed 1', 'Assigned 2', 'Engaged 3', 'Opportunity 1', 'Won 3', 'Other 0']);
    const hollis = (await screen.findByRole('link', { name: 'Hollis Freight Lines' })).closest('tr')!;
    expect(hollis).toHaveTextContent('Public agency · Miami, FL');
    expect(hollis).toHaveTextContent('Engaged');
    expect(hollis).toHaveTextContent('Ash Patel');
    expect(hollis).toHaveTextContent('Modernization Blueprint');
    expect(hollis).toHaveTextContent('Meeting held');
    expect(hollis).toHaveTextContent('$210,000');
    expect(hollis).toHaveTextContent('Open deal');
    const anchor = screen.getByRole('link', { name: 'Anchor Bay Logistics' }).closest('tr')!;
    expect(anchor).toHaveTextContent('Unassigned');
    expect(anchor).toHaveTextContent('Not pursued');
    expect(screen.getByText('Showing 2 of 14')).toBeInTheDocument();
    expect(screen.getByText('Sorted by stage, then priority')).toBeInTheDocument();
    expect(seen[0]!.searchParams.get('sort')).toBe('stage_priority');
  });

  it('keeps the stage, search and filters in the URL and sends them to the API', async () => {
    const seen = serve();
    const app = renderApp('/t/taazaa/accounts');
    await screen.findByRole('link', { name: 'Hollis Freight Lines' });
    await userEvent.click(screen.getByRole('tab', { name: 'Won 3' }));
    await waitFor(() => expect(params(app.path()).get('stage')).toBe('won'));
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('radio', { name: 'Unassigned 6' }));
    await waitFor(() => expect(params(app.path()).get('owner')).toBe('unassigned'));
    await waitFor(() => {
      const last = seen.at(-1)!.searchParams;
      expect(last.get('stage')).toBe('won');
      expect(last.get('unassigned')).toBe('true');
      expect(last.has('owner_user_id')).toBe(false);
    });
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an account' }), 'nothing');
    expect(await screen.findByRole('heading', { name: 'No accounts match these filters' })).toBeInTheDocument();
    expect(params(app.path()).get('q')).toBe('nothing');
    expect(screen.getByText('Try another stage or owner, or clear the filters to see every account in this workspace.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect([...params(app.path()).keys()]).toEqual([]));
  });

  it('exports the CSV and says how many accounts it holds', async () => {
    serve();
    let asked: URL | null = null;
    server.use(
      http.get('/api/v1/accounts/export', ({ request }) => {
        asked = new URL(request.url);
        return new HttpResponse('Account\nHollis\n', { headers: { 'content-type': 'text/csv', 'x-scout-row-count': '14' } });
      }),
    );
    const created = vi.fn(() => 'blob:x');
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    renderApp('/t/taazaa/accounts?stage=won');
    await screen.findByRole('link', { name: 'Hollis Freight Lines' });
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Exported 14 accounts to scout-accounts.csv.')).toBeInTheDocument();
    expect(asked!.searchParams.get('stage')).toBe('won');
    expect(created).toHaveBeenCalled();
  });

  it('shows the API’s words when the export fails', async () => {
    serve();
    server.use(http.get('/api/v1/accounts/export', () => problem(403, 'Forbidden', { detail: 'You need accounts:read.' })));
    renderApp('/t/taazaa/accounts');
    await screen.findByRole('link', { name: 'Hollis Freight Lines' });
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('You need accounts:read.')).toBeInTheDocument();
  });

  it('says what failed and tries again', async () => {
    serve();
    server.use(http.get('/api/v1/accounts', () => problem(500, 'Something went wrong', { ref: 'a-22e90b' })));
    renderApp('/t/taazaa/accounts');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("All accounts didn't load");
    expect(alert).toHaveTextContent('Error ref a-22e90b');
  });

  it('a row opens the account page', async () => {
    serve();
    const app = renderApp('/t/taazaa/accounts');
    const hollis = await screen.findByRole('link', { name: 'Hollis Freight Lines' });
    await userEvent.click(hollis.closest('tr')!.querySelector('td:nth-child(3)')!);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/accounts/acc_hollis'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Account page' })).toBeInTheDocument();
  });
});
