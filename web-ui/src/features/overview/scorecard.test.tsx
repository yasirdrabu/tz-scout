import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { metricDetail, serveOverview, serveScorecard } from './testing';

const open = async (path = '/t/taazaa/overview') => {
  const app = renderApp(path);
  await screen.findByRole('heading', { name: 'Overview', level: 1 });
  return app;
};

const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

describe('Overview scorecard', () => {
  it('has the three tabs and keeps the tab in the URL', async () => {
    serveOverview();
    const app = await open();
    expect(await screen.findByRole('tab', { name: 'By seller' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'By offer' }));
    await waitFor(() => expect(app.path()).toContain('tab=offers'));
    expect(await screen.findByRole('columnheader', { name: 'Offer' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'By practice' }));
    await waitFor(() => expect(app.path()).toContain('tab=practices'));
  });

  it('opens on the tab in the URL', async () => {
    serveOverview();
    await open('/t/taazaa/overview?tab=practices');
    expect(await screen.findByRole('tab', { name: 'By practice' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the By seller columns, the accounts assigned and the footnote', async () => {
    serveOverview();
    await open();
    await screen.findByText('Priya Shah');
    expect(headers()).toEqual(['Seller', 'Accepted', 'Time to accept', 'Steps on time', 'Meetings', 'Opportunities', 'Won', 'Pipeline', 'Win rate']);
    expect(screen.getByText('14 accounts assigned')).toBeInTheDocument();
    expect(screen.getByText('Green is at or better than the team, amber needs attention.')).toBeInTheDocument();
  });

  it('shows the By offer columns, the practice under the name and the footnote', async () => {
    serveOverview();
    await open('/t/taazaa/overview?tab=offers');
    await screen.findByText('Cloud Migration');
    expect(headers()).toEqual(['Offer', 'Price', 'Matched', 'Opportunities', 'Won', 'Win rate', 'Won value', 'Pipeline']);
    expect(screen.getByText('$20k–$40k')).toBeInTheDocument();
    expect(screen.getByText("Won value and pipeline use deal amounts, or the offer's price when a deal has none.")).toBeInTheDocument();
  });

  it('shows the By practice columns, the lead and the footnote', async () => {
    serveOverview();
    await open('/t/taazaa/overview?tab=practices');
    await screen.findByText('Led by Maya Chen');
    expect(headers()).toEqual(['Practice', 'Offers', 'Matched', 'Opportunities', 'Won', 'Win rate', 'Won value', 'Pipeline']);
    expect(screen.getByText("Totals across each practice's offers. Won value and pipeline use deal amounts, or offer prices.")).toBeInTheDocument();
  });

  it('sorts descending on the first click and ascending on the second', async () => {
    serveOverview();
    await open();
    await screen.findByText('Priya Shah');
    const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    const meetings = screen.getByRole('columnheader', { name: 'Meetings' });
    expect(meetings).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(within(meetings).getByRole('button'));
    expect(meetings).toHaveAttribute('aria-sort', 'descending');
    expect(names()[0]).toContain('Sam Lee');
    await userEvent.click(within(meetings).getByRole('button'));
    expect(meetings).toHaveAttribute('aria-sort', 'ascending');
    expect(names()[0]).toContain('Priya Shah');
  });

  it('colours good green and attention amber, and shows a dash for no value', async () => {
    serveOverview();
    await open();
    await screen.findByText('Priya Shah');
    const priya = rowOf('Priya Shah');
    expect(within(priya).getByRole('button', { name: /^90%/ }).className).toMatch(/good/);
    expect(within(rowOf('Sam Lee')).getByRole('button', { name: /^50%/ }).className).toMatch(/attention/);
    expect(within(priya).getByRole('button', { name: /^–/ })).toBeInTheDocument();
  });

  it('says the tone in words as well as colour', async () => {
    serveOverview();
    const app = await open();
    await screen.findByText('Priya Shah');
    expect(within(rowOf('Priya Shah')).getByRole('button', { name: /^90%.*At or better than the team/ })).toBeInTheDocument();
    expect(within(rowOf('Sam Lee')).getByRole('button', { name: /^50%.*Needs attention/ })).toBeInTheDocument();
    expect(within(rowOf('Sam Lee')).getByRole('button', { name: /^60%/ }).textContent).not.toMatch(/team|attention|Good/);
    await userEvent.click(screen.getByRole('tab', { name: 'By practice' }));
    await waitFor(() => expect(app.path()).toContain('tab=practices'));
    expect(await screen.findByRole('button', { name: /^8%.*Needs attention/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'By offer' }));
    expect(await screen.findByRole('button', { name: /^15%.*Good/ })).toBeInTheDocument();
  });

  it('opens the drawer from a cell with the metric, its scope and the See all link', async () => {
    const seen: string[] = [];
    serveOverview();
    serveScorecard(seen);
    await open();
    await screen.findByText('Priya Shah');
    await userEvent.click(within(rowOf('Priya Shah')).getByRole('button', { name: /^90%/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Accepted' });
    expect(seen.at(-1)).toBe('/api/v1/analytics/metrics/seller.accepted?seller=u1');
    expect(within(drawer).getByText('Priya Shah · seller')).toBeInTheDocument();
    expect(within(drawer).getByText('90%')).toBeInTheDocument();
    expect(within(drawer).getByText('+20% vs last quarter at this point')).toHaveClass(/up/);
    expect(within(drawer).getByText('Share of assigned accounts this seller accepted.')).toBeInTheDocument();
    expect(within(drawer).getByText('Assigned')).toBeInTheDocument();
    expect(within(drawer).getByText('By offer')).toBeInTheDocument();
    expect(within(drawer).getByText('Offer 8')).toBeInTheDocument();
    expect(within(drawer).queryByText('Offer 9')).not.toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Northwind/ })).toBeInTheDocument();
    expect(within(drawer).getByText('Cloud Migration · Referral')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'See all 14' })).toHaveAttribute('href', '/t/taazaa/accounts?owner=u1');
    expect(drawer).toHaveFocus();
  });

  it('shows a negative change in red', async () => {
    serveOverview();
    serveScorecard([], metricDetail({ change_pct: -5 }));
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /Pipeline value/ }));
    expect(await screen.findByText('-5% vs last quarter at this point')).toHaveClass(/down/);
  });

  it('hides the change line when there is no base', async () => {
    serveOverview();
    serveScorecard([], metricDetail({ change_pct: null }));
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /Pipeline value/ }));
    await screen.findByRole('dialog');
    expect(screen.queryByText(/vs last quarter/)).not.toBeInTheDocument();
  });

  it('opens a funnel band in the drawer with its stage, and links See all to the stage', async () => {
    const seen: string[] = [];
    serveOverview();
    serveScorecard(seen, metricDetail({ see_all: { stage: 'reviewed' }, total: 62 }));
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Reviewed/ }));
    expect(await screen.findByRole('link', { name: 'See all 62' })).toHaveAttribute('href', '/t/taazaa/accounts?stage=reviewed');
    expect(seen.at(-1)).toBe('/api/v1/analytics/metrics/stage?stage=reviewed');
  });

  it('keeps a missing value last in both sort directions', async () => {
    serveOverview();
    await open();
    await screen.findByText('Priya Shah');
    const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    const steps = screen.getByRole('columnheader', { name: 'Steps on time' });
    await userEvent.click(within(steps).getByRole('button'));
    expect(steps).toHaveAttribute('aria-sort', 'descending');
    expect(names()[1]).toContain('Priya Shah');
    await userEvent.click(within(steps).getByRole('button'));
    expect(steps).toHaveAttribute('aria-sort', 'ascending');
    expect(names()[1]).toContain('Priya Shah');
  });

  it('links See all to the offer', async () => {
    serveOverview();
    serveScorecard([], metricDetail({ see_all: { offer: 'o1' } }));
    await open('/t/taazaa/overview?tab=offers');
    await userEvent.click(within(await screen.findByRole('row', { name: /Cloud Migration/ })).getAllByRole('button')[0]!);
    expect(await screen.findByRole('link', { name: 'See all 14' })).toHaveAttribute('href', '/t/taazaa/accounts?offer=o1');
  });

  it('links See all to the practice', async () => {
    serveOverview();
    serveScorecard([], metricDetail({ see_all: { practice: 'p1' } }));
    await open('/t/taazaa/overview?tab=practices');
    await userEvent.click(within(await screen.findByRole('row', { name: /Led by/ })).getAllByRole('button')[0]!);
    expect(await screen.findByRole('link', { name: 'See all 14' })).toHaveAttribute('href', '/t/taazaa/accounts?practice=p1');
  });

  it('closes on Escape and on the close button, one selection at a time', async () => {
    serveOverview();
    await open();
    await userEvent.click(within(await screen.findByText('Priya Shah').then(() => rowOf('Priya Shah'))).getByRole('button', { name: /^90%/ }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Pipeline value/ }));
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
