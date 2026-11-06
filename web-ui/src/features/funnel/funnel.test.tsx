import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { funnel, NO_COSTS, SELLER, serveDrill, serveFunnel, withoutSpend } from './testing';

const open = async (path = '/t/taazaa/funnel') => {
  const app = renderApp(path);
  await screen.findByRole('heading', { name: 'Funnel by source', level: 1 });
  return app;
};

describe('Funnel header and filters', () => {
  it('shows the title, the sub and Last 90 days by default', async () => {
    const seen = serveFunnel();
    await open();
    expect(screen.getByText('How many accounts each source moved through each stage, and what each one cost. Click a source for its stage-by-stage detail.')).toBeInTheDocument();
    expect(screen.getByLabelText('Period')).toHaveValue('90d');
    expect(screen.getByRole('option', { name: 'This quarter' })).toBeInTheDocument();
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.searchParams.get('period')).toBe('90d');
  });

  it('changing a filter updates the URL and refetches', async () => {
    const seen = serveFunnel();
    const app = await open();
    await screen.findByText('RFP Watch');
    await screen.findByRole('option', { name: 'Data and AI' });
    await userEvent.selectOptions(screen.getByLabelText('Practice'), 'p1');
    await waitFor(() => expect(app.path()).toContain('practice=p1'));
    await waitFor(() => expect(seen.at(-1)!.searchParams.get('practice')).toBe('p1'));
    await userEvent.selectOptions(screen.getByLabelText('Period'), 'year');
    await waitFor(() => expect(app.path()).toContain('period=year'));
    await waitFor(() => expect(seen.at(-1)!.searchParams.get('period')).toBe('year'));
    await screen.findByRole('option', { name: 'October list' });
    await userEvent.selectOptions(screen.getByLabelText('Batch'), 'b1');
    await waitFor(() => expect(seen.at(-1)!.searchParams.get('batch')).toBe('b1'));
    await userEvent.selectOptions(screen.getByLabelText('Offer'), 'o1');
    await waitFor(() => expect(seen.at(-1)!.searchParams.get('offer')).toBe('o1'));
  });
});

describe('Funnel tiles', () => {
  it('reads sent, won, spend and cost per won account with the target', async () => {
    serveFunnel();
    await open();
    const tiles = await screen.findByRole('list', { name: 'Funnel totals' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li')!;
    expect(tile('Accounts sent')).toHaveTextContent('76');
    expect(tile('Accounts sent')).toHaveTextContent('6 sources');
    expect(tile('Won')).toHaveTextContent('5');
    expect(tile('Won')).toHaveTextContent('7% of sent');
    expect(tile('Spend')).toHaveTextContent('$1,000');
    expect(tile('Cost per won account')).toHaveTextContent('$200');
    expect(tile('Cost per won account')).toHaveTextContent('Target $200');
  });

  it('says No target set when there is no target', async () => {
    serveFunnel({ funnel: funnel({ target_cost_per_won_cents: null }) });
    await open();
    const tiles = await screen.findByRole('list', { name: 'Funnel totals' });
    expect(within(tiles).getByText('Cost per won account').closest('li')).toHaveTextContent('No target set');
  });
});

describe('Funnel table', () => {
  it('has a column per stage with the count, step percent and cost per account', async () => {
    serveFunnel();
    await open();
    const table = await screen.findByRole('table');
    for (const name of ['Source', 'Arrived', 'Reviewed', 'Won', 'Spend', 'Cost per won account', 'Win rate']) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    const rfp = within(table).getByText('RFP Watch').closest('tr')!;
    expect(rfp).toHaveTextContent('40');
    expect(rfp).toHaveTextContent('$10 per account');
    expect(rfp).toHaveTextContent('50% from previous stage · $20 per account');
    expect(rfp).toHaveTextContent('20% from previous stage · $100 per account');
    expect(rfp).toHaveTextContent('$400');
    expect(rfp).toHaveTextContent('10%');
  });

  it('colours cost per won by status and grays the words', async () => {
    serveFunnel();
    await open();
    const table = await screen.findByRole('table');
    const cell = (name: string) => within(within(table).getByText(name).closest('tr')!).getByTestId('cost-per-won');
    expect(cell('RFP Watch')).toHaveTextContent('$100');
    expect(cell('RFP Watch').className).toMatch(/good/);
    expect(cell('Partner referrals').className).toMatch(/amber/);
    expect(cell('Pricey vendor').className).toMatch(/red/);
    expect(cell('Event list')).toHaveTextContent('No wins yet');
    expect(cell('Event list').className).toMatch(/gray/);
    expect(cell('New feed')).toHaveTextContent('Not enough data');
    expect(cell('New feed').className).toMatch(/gray/);
    expect(cell('No-target source')).toHaveTextContent('No target set');
    expect(cell('No-target source').className).toMatch(/gray/);
  });

  it('draws a win-rate bar and links each row to its drill', async () => {
    serveFunnel();
    serveDrill();
    const app = await open();
    const link = await screen.findByRole('link', { name: 'RFP Watch' });
    expect(link).toHaveAttribute('href', '/t/taazaa/funnel/src_rfp');
    expect(within(link.closest('tr')!).getByRole('meter', { name: 'Win rate' })).toHaveAttribute('aria-valuenow', '10');
    await userEvent.click(link);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/funnel/src_rfp'));
  });
});

describe('Funnel without costs:read', () => {
  it('hides Spend and Cost per won everywhere', async () => {
    serveFunnel({ scopes: NO_COSTS });
    await open();
    const table = await screen.findByRole('table');
    expect(within(table).queryByRole('columnheader', { name: /^Spend/ })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /^Cost per won/ })).toBeNull();
    const rfp = within(table).getByText('RFP Watch').closest('tr')!;
    expect(rfp).toHaveTextContent('50% from previous stage');
    expect(rfp).not.toHaveTextContent('per account');
    const tiles = screen.getByRole('list', { name: 'Funnel totals' });
    expect(within(tiles).queryByText('Spend')).toBeNull();
    expect(within(tiles).queryByText('Cost per won account')).toBeNull();
    expect(within(tiles).getByText('Accounts sent')).toBeInTheDocument();
  });
});

describe('Funnel empty', () => {
  it('says No accounts arrived in this period.', async () => {
    serveFunnel({ funnel: funnel({ rows: [], totals: { sent: 0, sources: 0, won: 0, won_pct: null, spend_cents: 0, cost_per_won_cents: null } }) });
    await open();
    expect(await screen.findByText('No accounts arrived in this period.')).toBeInTheDocument();
  });
});

describe('Funnel when spend is not split', () => {
  it('with a practice, offer or batch filter it hides spend as without costs:read and says why', async () => {
    serveFunnel({ funnel: { ...withoutSpend(funnel()), spend_split: false } });
    await open('/t/taazaa/funnel?practice=p1');
    const table = await screen.findByRole('table');
    expect(screen.getByText("Spend isn't split by practice, offer or batch.")).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /^Spend/ })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /^Cost per won/ })).toBeNull();
    expect(within(table).getByText('RFP Watch').closest('tr')).not.toHaveTextContent('per account');
    const tiles = screen.getByRole('list', { name: 'Funnel totals' });
    expect(within(tiles).queryByText('Spend')).toBeNull();
    expect(within(tiles).queryByText('Cost per won account')).toBeNull();
    expect(screen.queryByText(/^Cost per won account: green/)).toBeNull();
  });

  it('says nothing about the split when spend is split', async () => {
    serveFunnel();
    await open();
    await screen.findByRole('table');
    expect(screen.queryByText("Spend isn't split by practice, offer or batch.")).toBeNull();
  });
});

describe('Funnel for a seller', () => {
  it('has no Batch filter and never lists batches', async () => {
    serveFunnel({ scopes: SELLER });
    let listed = 0;
    server.use(
      http.get('/api/v1/batches', () => {
        listed += 1;
        return HttpResponse.json({ data: [], next_cursor: null });
      }),
    );
    await open();
    await screen.findByRole('table');
    expect(screen.getByLabelText('Practice')).toBeInTheDocument();
    expect(screen.queryByLabelText('Batch')).toBeNull();
    expect(listed).toBe(0);
  });
});
