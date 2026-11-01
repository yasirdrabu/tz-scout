import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { serveSources } from './testing';

const params = (href: string) => new URL(href, 'http://app').searchParams;
const names = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]!.querySelector('a')?.textContent);

beforeEach(() => localStorage.clear());

describe('Sources (§10)', () => {
  it('shows the tree in the API order, with how each sends, trust words and the numbers from stats', async () => {
    const seen = serveSources();
    renderApp('/t/taazaa/sources');
    expect(await screen.findByRole('heading', { name: 'Sources', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText('Every account traces back to a person, the agent they run and the data vendor behind it. Trust decides how much Scout relies on what a source says.'),
    ).toBeInTheDocument();
    await screen.findByRole('link', { name: 'RFP Watch' });
    expect(names()).toEqual(['Marcus Lee', 'RFP Watch', 'CSV imports', 'Kestrel Advisory', 'HubSpot inbound']);
    const rfp = screen.getByRole('link', { name: 'RFP Watch' }).closest('tr')!;
    expect(rfp).toHaveTextContent('Agent');
    expect(rfp).toHaveTextContent('Through Marcus Lee');
    expect(rfp).toHaveTextContent('Not enough data yet');
    expect(within(rfp).getAllByRole('cell').map((c) => c.textContent).slice(3, 7)).toEqual(['41', '38', '19', '6']);
    expect(screen.getByRole('link', { name: 'CSV imports' }).closest('tr')).toHaveTextContent('New');
    expect(screen.getByRole('link', { name: 'Kestrel Advisory' }).closest('tr')).toHaveTextContent('Paused');
    // Trust always reads the words until R3, and there is no Trust filter.
    for (const row of screen.getAllByRole('row').slice(1)) expect(row).toHaveTextContent('Not enough data yet');
    // Archived sources stay out: the list never asks for them (the API leaves them out by default).
    expect(seen.filter((r) => r.url.pathname === '/api/v1/sources').every((r) => !r.url.searchParams.has('status'))).toBe(true);
  });

  it('collapses and expands the children', async () => {
    serveSources();
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources');
    await screen.findByRole('link', { name: 'RFP Watch' });
    await user.click(screen.getByRole('button', { name: 'Collapse Marcus Lee' }));
    expect(screen.queryByRole('link', { name: 'RFP Watch' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Marcus Lee' }));
    expect(screen.getByRole('link', { name: 'RFP Watch' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(names()).toEqual(['Marcus Lee', 'Kestrel Advisory', 'HubSpot inbound']);
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(names()).toHaveLength(5);
  });

  it("filters by type with the API's counts, and keeps the filter and search in the URL", async () => {
    const seen = serveSources();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/sources');
    await screen.findByRole('link', { name: 'RFP Watch' });
    await user.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.queryByRole('tab', { name: /Trust/ })).toBeNull();
    const agent = await screen.findByRole('checkbox', { name: /Agent/ });
    expect(agent.closest('label')).toHaveTextContent('1');
    await user.click(agent);
    await waitFor(() => expect(params(app.path()).get('kind')).toBe('agent'));
    await waitFor(() => expect(names()).toEqual(['RFP Watch']));
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('searchbox', { name: 'Find a source' }), 'rfp');
    await waitFor(() => expect(params(app.path()).get('q')).toBe('rfp'));
    expect(seen.some((s) => s.url.pathname === '/api/v1/sources' && s.url.searchParams.get('q') === 'rfp' && s.url.searchParams.get('kind') === 'agent')).toBe(true);
  });

  it('shows the empty state with a way out, and no archived sources', async () => {
    serveSources({ sources: [] });
    renderApp('/t/taazaa/sources?q=nothing');
    expect(await screen.findByText('No sources match. Clear the filters, or add a source.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('shows the loading line and the error state', async () => {
    serveSources();
    server.use(
      http.get('/api/v1/sources', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const first = renderApp('/t/taazaa/sources');
    expect(await screen.findByText('Loading sources')).toBeInTheDocument();
    first.unmount();
    server.use(http.get('/api/v1/sources', () => problem(500, 'Something went wrong', { ref: 'cor_s1' })));
    renderApp('/t/taazaa/sources');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Sources didn't load");
    expect(alert).toHaveTextContent('Error ref cor_s1');
  });

  it('opens the Source page from a row, and hides Add a source without sources:manage', async () => {
    serveSources({ scopes: ['arrivals:read'] });
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/sources');
    const link = await screen.findByRole('link', { name: 'RFP Watch' });
    expect(screen.queryByRole('button', { name: 'Add a source' })).toBeNull();
    await user.click(link);
    await waitFor(() => expect(app.path()).toContain('/t/taazaa/sources/src_rfp'));
  });
});
