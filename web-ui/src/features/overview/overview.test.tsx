import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { ADMIN, emptyOverview, overview, serveOverview } from './testing';

const open = async () => {
  const app = renderApp('/t/taazaa/overview');
  await screen.findByRole('heading', { name: 'Overview', level: 1 });
  return app;
};

describe('Overview', () => {
  it('shows the title and the sub with the quarter and week', async () => {
    serveOverview();
    await open();
    expect(await screen.findByText('Where every account is this quarter, and who and what moved it there. Q4 2026, week 6 of 14. Click any number to see what made it up.')).toBeInTheDocument();
  });

  it('shows the four tiles with their notes', async () => {
    serveOverview();
    await open();
    const tiles = await screen.findByRole('list', { name: 'Overview totals' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li')!;
    expect(tile('Pipeline value')).toHaveTextContent('$125,000');
    expect(tile('Pipeline value')).toHaveTextContent('7 accounts at Opportunity');
    expect(tile('Won value')).toHaveTextContent('$40,000');
    expect(tile('Won value')).toHaveTextContent('3 accounts won');
    expect(tile('Sent to Won')).toHaveTextContent('8.5%');
    expect(tile('Sent to Won')).toHaveTextContent('Of accounts that entered this quarter');
    expect(tile('Days to win')).toHaveTextContent('41');
    expect(tile('Days to win')).toHaveTextContent('Median, sent to won');
  });

  it('shows the bands with their share, target and pace', async () => {
    serveOverview();
    await open();
    expect(await screen.findByText('Into the pipeline')).toBeInTheDocument();
    expect(screen.getByText('62% of Sent')).toBeInTheDocument();
    expect(screen.getByText('30 of 100')).toBeInTheDocument();
    expect(screen.getByText('Behind pace')).toBeInTheDocument();
    expect(screen.getByText('On pace')).toBeInTheDocument();
    expect(screen.getByText('Ahead')).toBeInTheDocument();
    expect(screen.getAllByText('No target set')).toHaveLength(1);
    expect(screen.getByText('Where we should be today')).toBeInTheDocument();
  });

  it('lists the exits under Left the pipeline', async () => {
    serveOverview();
    await open();
    const group = (await screen.findByText('Left the pipeline')).closest('section')!;
    expect(within(group).getByText('Rejected')).toBeInTheDocument();
    expect(within(group).getByText('12')).toBeInTheDocument();
    expect(within(group).getByText('Lost')).toBeInTheDocument();
  });

  it('shows Configure stages only with settings:manage', async () => {
    serveOverview({ scopes: ADMIN });
    await open();
    expect(await screen.findByRole('link', { name: 'Configure stages' })).toHaveAttribute('href', '/t/taazaa/settings/pipeline-stages');
  });

  it('hides Configure stages without settings:manage', async () => {
    serveOverview();
    await open();
    await screen.findByText('Left the pipeline');
    expect(screen.queryByRole('link', { name: 'Configure stages' })).not.toBeInTheDocument();
  });

  it('reads $0, a dash and None yet when nothing has happened', async () => {
    serveOverview({ data: emptyOverview() });
    await open();
    const tiles = await screen.findByRole('list', { name: 'Overview totals' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li')!;
    expect(tile('Pipeline value')).toHaveTextContent('$0');
    expect(tile('Won value')).toHaveTextContent('$0');
    expect(tile('Sent to Won')).toHaveTextContent('–');
    expect(tile('Days to win')).toHaveTextContent('None yet');
    expect(screen.queryByText(/% of Sent/)).not.toBeInTheDocument();
  });

  it('says it is loading, then explains a failure with Try again', async () => {
    serveOverview({ fail: true });
    renderApp('/t/taazaa/overview');
    expect(await screen.findByText('Loading the overview')).toBeInTheDocument();
    expect(await screen.findByText("The overview didn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('marks the clicked tile, band and exit as the selection for the drawer slot', async () => {
    serveOverview();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /Pipeline value/ }));
    expect(screen.getByRole('button', { name: /Pipeline value/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^Reviewed/ }));
    expect(screen.getByRole('button', { name: /^Reviewed/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Pipeline value/ })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: /Rejected/ }));
    expect(screen.getByRole('button', { name: /Rejected/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Overview bands', () => {
  it('shows a Pipeline heading and gives only the Won band the won style', async () => {
    serveOverview();
    await open();
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Won\d/ }).className).toMatch(/won/);
    expect(screen.getByRole('button', { name: /^Reviewed/ }).className).not.toMatch(/won/);
  });
});

describe('Overview band edge cases', () => {
  const stage = (key: string, name: string, count: number, target: number | null) => ({ key, name, count, pct_of_previous: null, value_cents: null, target, expected: target === null ? null : 0, pace: null });
  const widthOf = (name: RegExp) => Number.parseFloat((screen.getByRole('button', { name }).firstElementChild as HTMLElement).style.width);

  it('clamps a band to 100% when a later stage is larger than the first', async () => {
    serveOverview({ data: overview({ stages: [stage('sent', 'Sent', 5, null), stage('reviewed', 'Reviewed', 40, null), stage('opportunity', 'Opportunity', 10, null), stage('won', 'Won', 3, null)] }) });
    await open();
    await screen.findByRole('heading', { name: 'Pipeline' });
    expect(widthOf(/^Reviewed/)).toBe(100);
    expect(widthOf(/^Sent[0-9]/)).toBeLessThan(widthOf(/^Opportunity/));
    for (const n of [/^Sent[0-9]/, /^Reviewed/, /^Opportunity/, /^Won\d/]) expect(widthOf(n)).toBeLessThanOrEqual(100);
  });

  it('shows No target set, and no legend, when no stage has a target', async () => {
    serveOverview({ data: overview({ stages: [stage('sent', 'Sent', 5, null), stage('won', 'Won', 3, null)] }) });
    await open();
    await screen.findByRole('heading', { name: 'Pipeline' });
    expect(screen.getAllByText('No target set')).toHaveLength(2);
    expect(screen.queryByText(/Where we should be today/)).not.toBeInTheDocument();
  });

  it('treats a target of 0 as no target', async () => {
    serveOverview({ data: overview({ stages: [stage('sent', 'Sent', 5, 0), stage('won', 'Won', 3, null)] }) });
    await open();
    await screen.findByRole('heading', { name: 'Pipeline' });
    expect(screen.queryByText(/of 0/)).not.toBeInTheDocument();
    expect(screen.getAllByText('No target set')).toHaveLength(2);
    expect(screen.queryByText(/Where we should be today/)).not.toBeInTheDocument();
  });

  it('shows the legend when a stage has a target', async () => {
    serveOverview();
    await open();
    expect(await screen.findByText(/Where we should be today/)).toBeInTheDocument();
  });
});
