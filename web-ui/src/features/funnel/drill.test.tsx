import { screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test/renderApp';
import { drill, NO_COSTS, SELLER, serveDrill } from './testing';

const open = async (path = '/t/taazaa/funnel/src_rfp?period=90d&practice=p1') => {
  const app = renderApp(path);
  await screen.findByRole('heading', { name: 'RFP Watch', level: 1 });
  return app;
};
const tile = (label: string) => within(screen.getByRole('list', { name: 'Source totals' })).getByText(label).closest('li')!;

describe('Funnel drill header (§17)', () => {
  it('shows the breadcrumb, type and period, position, previous and next, and Open source page', async () => {
    const seen = serveDrill();
    await open();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Funnel by source' })).toBeInTheDocument();
    expect(within(crumbs).getByText('RFP Watch')).toBeInTheDocument();
    expect(screen.getByText('Agent · Last 90 days')).toBeInTheDocument();
    expect(screen.getByText('3 of 6')).toBeInTheDocument();
    const prev = screen.getByRole('link', { name: 'Previous source' }).getAttribute('href')!;
    expect(prev).toContain('/t/taazaa/funnel/src_prev?');
    expect(prev).toContain('practice=p1');
    expect(screen.getByRole('link', { name: 'Next source' }).getAttribute('href')).toContain('/t/taazaa/funnel/src_next?');
    expect(screen.getByRole('link', { name: 'Open source page' }).getAttribute('href')).toBe('/t/taazaa/sources/src_rfp');
    await waitFor(() => expect(seen[0]!.searchParams.get('practice')).toBe('p1'));
  });

  it('hides the position line when null', async () => {
    serveDrill({ drill: drill({ position: null, row_count: null, prev_id: null, next_id: null }) });
    await open();
    expect(screen.queryByText(/ of 6$/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Previous source' })).toBeNull();
  });

  it('shows a not-found state for a 404', async () => {
    serveDrill({ status: 404 });
    renderApp('/t/taazaa/funnel/src_gone');
    expect(await screen.findByText('That source was not found.')).toBeInTheDocument();
  });
});

describe('Funnel drill tiles and insight', () => {
  it('reads the four tiles', async () => {
    serveDrill();
    await open();
    expect(tile('Sent')).toHaveTextContent('40');
    expect(tile('Sent')).toHaveTextContent('Accounts into review');
    expect(tile('Won')).toHaveTextContent('10% of sent · all sources 7%');
    expect(tile('Spend')).toHaveTextContent('$400');
    expect(tile('Spend')).toHaveTextContent('$10 per account sent');
    expect(tile('Cost per won account')).toHaveTextContent('$100');
    expect(tile('Cost per won account')).toHaveTextContent('Ranks 2 of 4 · target $200');
  });

  it('drops Ranks without a rank', async () => {
    serveDrill({ drill: drill({ rank: null }) });
    await open();
    expect(tile('Cost per won account')).toHaveTextContent('target $200');
    expect(tile('Cost per won account')).not.toHaveTextContent('Ranks');
  });

  it('says No target set without a target', async () => {
    serveDrill({ drill: drill({ target_cost_per_won_cents: null }) });
    await open();
    expect(tile('Cost per won account')).toHaveTextContent('No target set');
  });

  it('shows the insight as given', async () => {
    serveDrill();
    await open();
    expect(screen.getByText('Most accounts stall between Arrived and Reviewed.')).toBeInTheDocument();
  });

  it('leaves out the spend tiles and column without costs:read', async () => {
    const d = drill();
    serveDrill({
      scopes: NO_COSTS,
      drill: drill({
        target_cost_per_won_cents: null,
        totals: { ...d.totals, spend_cents: null, cost_per_sent_cents: null, cost_per_won_cents: null, status: null },
        stages: d.stages.map((s) => ({ ...s, cost_each_cents: null })),
      }),
    });
    await open();
    expect(screen.queryByText('Spend')).toBeNull();
    expect(screen.queryByText('Cost per won account')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Cost each' })).toBeNull();
  });
});

describe('Funnel drill stage table and lists', () => {
  it('has a row per stage with the bar, moved on, lost and cost each', async () => {
    serveDrill();
    await open();
    const table = screen.getByRole('table', { name: 'Stage by stage' });
    for (const n of ['Stage', 'Accounts', 'Moved on', 'Lost', 'Cost each']) expect(within(table).getByRole('columnheader', { name: n })).toBeInTheDocument();
    const reviewed = within(table).getByText('Reviewed').closest('tr')!;
    expect(reviewed).toHaveTextContent('20');
    expect(reviewed).toHaveTextContent('50%');
    expect(reviewed).toHaveTextContent('+11 points vs all sources');
    expect(reviewed).toHaveTextContent('$20');
    expect(within(reviewed).getByRole('meter', { name: 'Reviewed accounts' })).toHaveAttribute('aria-valuenow', '20');
    expect(within(table).getByText('Won').closest('tr')).toHaveTextContent('+3 points vs all sources');
  });

  it('opens a batch', async () => {
    serveDrill();
    await open();
    expect(screen.getByRole('link', { name: 'October list' }).getAttribute('href')).toBe('/t/taazaa/batches/b1');
  });

  it('lists won accounts with value, or No value', async () => {
    serveDrill();
    await open();
    const list = screen.getByRole('list', { name: 'Won accounts' });
    expect(within(list).getByText('Hollis Freight Lines').closest('li')).toHaveTextContent('Modernization Blueprint');
    expect(within(list).getByText('Hollis Freight Lines').closest('li')).toHaveTextContent('$50,000');
    expect(within(list).getByText('Birch Dental').closest('li')).toHaveTextContent('No value');
  });

  it('says there are no wins yet', async () => {
    serveDrill({ drill: drill({ won_accounts: [] }) });
    await open();
    expect(screen.getByText('No wins from this source yet.')).toBeInTheDocument();
  });
});

describe('Funnel drill when spend is not split', () => {
  it('hides the spend tiles and Cost each and says why', async () => {
    const d = drill();
    serveDrill({
      drill: drill({
        spend_split: false,
        rank: null,
        target_cost_per_won_cents: null,
        totals: { ...d.totals, spend_cents: null, cost_per_sent_cents: null, cost_per_won_cents: null, status: null },
        stages: d.stages.map((s) => ({ ...s, cost_each_cents: null })),
      }),
    });
    await open();
    expect(screen.getByText("Spend isn't split by practice, offer or batch.")).toBeInTheDocument();
    expect(screen.queryByText('Spend')).toBeNull();
    expect(screen.queryByText('Cost per won account')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Cost each' })).toBeNull();
  });
});

describe('Funnel drill for a seller', () => {
  it('has no Open source page and shows batches as plain text', async () => {
    serveDrill({ scopes: SELLER });
    await open();
    expect(screen.queryByRole('link', { name: 'Open source page' })).toBeNull();
    const batches = screen.getByRole('list', { name: 'Batches' });
    expect(within(batches).getByText('October list')).toBeInTheDocument();
    expect(within(batches).queryByRole('link')).toBeNull();
  });
});
