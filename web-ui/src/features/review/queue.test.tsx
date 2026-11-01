import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { COASTLINE, COLUMNS, FACETS, MIAMI, PINEGATE, RESCORE, row, serveQueue } from './testing';

const params = (href: string) => new URL(href, 'http://app').searchParams;
const rowOf = (name: string) => screen.getByRole('button', { name }).closest('tr')!;

beforeEach(() => localStorage.clear());

describe('Review queue', () => {
  it('shows the subtitle, tier tabs with counts from the API and the rows in the person’s columns', async () => {
    serveQueue();
    renderApp('/t/taazaa/queue');
    expect(await screen.findByRole('heading', { level: 1, name: 'Review queue' })).toBeInTheDocument();
    expect(await screen.findByText(/^3 accounts waiting for a decision\. Oldest arrived .+ ago\.$/)).toBeInTheDocument();
    const tiers = screen.getByRole('tablist', { name: 'Tier' });
    expect(within(tiers).getByRole('tab', { name: 'All 3' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tiers).getByRole('tab', { name: 'Act now 2' })).toBeInTheDocument();
    expect(within(tiers).getByRole('tab', { name: 'Good fit 0' })).toBeInTheDocument();
    expect(within(tiers).getByRole('tab', { name: 'Watch 1' })).toBeInTheDocument();
    // The lowest tier shows only when it has accounts.
    expect(within(tiers).queryByRole('tab', { name: /Not a fit/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Columns 8 of 12$/ })).toBeInTheDocument();

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['', 'Account', 'Best offer', 'Priority', 'Tier', 'Source', 'Review status', 'Flags', 'Notes']);
    const miami = await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    const r = miami.closest('tr')!;
    expect(r).toHaveTextContent('Public agency · Miami, FL · Arrived Oct 24, 2026');
    expect(r).toHaveTextContent('Modernization Blueprint');
    expect(r).toHaveTextContent('Data and Engineering for AI Readiness');
    expect(r).toHaveTextContent('79');
    expect(r).toHaveTextContent('Act now');
    expect(r).toHaveTextContent('RFP Watch');
    expect(r).toHaveTextContent('Marcus Lee · GovSpend');
    expect(r).toHaveTextContent('Ready for review');
    expect(r).toHaveTextContent('Warm intro');
    expect(within(r).getByText('note')).toHaveClass('sr-only');
    expect(rowOf('Coastline Credit Union')).toHaveTextContent('In review by Dana Whitfield');
    expect(within(rowOf('Coastline Credit Union')).getByText('Declined by Ash Patel')).toHaveAttribute('title', 'Outside my territory · Oct 25, 2026');
    expect(rowOf('Pinegate University')).toHaveTextContent('Changed by Dana Whitfield');
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('Sorted by priority, highest first')).toBeInTheDocument();
  });

  it('filters by tier tab and the Filter popover, with everything in the URL and sent to the API', async () => {
    const seen = serveQueue();
    const app = renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(screen.getByRole('tab', { name: 'Act now 2' }));
    await waitFor(() => expect(params(app.path()).get('tier')).toBe('act_now'));
    await waitFor(() => expect(seen['/api/v1/review-queue']!.at(-1)!.searchParams.get('tier')).toBe('act_now'));

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    await userEvent.click(within(panel).getByRole('tab', { name: 'Source' }));
    await userEvent.click(within(panel).getByRole('radio', { name: 'RFP Watch 3' }));
    await userEvent.click(within(panel).getByRole('tab', { name: 'Review status' }));
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'In review 1' }));
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Sent back to source 4' }));
    await waitFor(() => expect(params(app.path()).get('status')).toBe('needs_review,sent_back'));
    expect(params(app.path()).get('source')).toBe('src_rfp');
    await waitFor(() => {
      const last = seen['/api/v1/review-queue']!.at(-1)!.searchParams;
      expect(last.get('source_id')).toBe('src_rfp');
      expect(last.get('status')).toBe('needs_review,sent_back');
    });
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Remove Source RFP Watch' })).toBeInTheDocument();
  });

  it('the All tab counts every tier from total_all_tiers, with one facets request per render', async () => {
    const seen = serveQueue({ facets: { ...FACETS, total: 2, total_all_tiers: 3 } });
    renderApp('/t/taazaa/queue?tier=act_now');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    const tiers = screen.getByRole('tablist', { name: 'Tier' });
    expect(within(tiers).getByRole('tab', { name: 'All 3' })).toBeInTheDocument();
    expect(within(tiers).getByRole('tab', { name: 'Act now 2' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^3 accounts waiting for a decision\./)).toBeInTheDocument();
    expect(seen['/api/v1/review-queue/facets']).toHaveLength(1);
    expect(seen['/api/v1/review-queue/facets']![0]!.searchParams.get('tier')).toBe('act_now');
  });

  it.each([
    [0, 'Loading accounts'],
    [1, 'Loading accounts from 1 source'],
    [3, 'Loading accounts from 3 sources'],
  ])('the loading line names the sources from the facets (%i)', async (n, text) => {
    serveQueue({ facets: { ...FACETS, source_count: n } });
    server.use(
      http.get('/api/v1/review-queue', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderApp('/t/taazaa/queue');
    expect(await screen.findByText(text, { selector: 'p' })).toBeInTheDocument();
  });

  it('shows the rescore banner in the words of the API; Dismiss hides it for this change, and a newer change shows again', async () => {
    const seen = serveQueue({ rescore: RESCORE });
    const first = renderApp('/t/taazaa/queue');
    const banner = await screen.findByRole('region', { name: 'Scoring change' });
    expect(banner).toHaveTextContent(/^Scoring settings changed · .+ ago by Zach Wiant/);
    expect(banner).toHaveTextContent('Priorities were recalculated with Fit 60%, buying intent 40%. 12 accounts changed tier.');
    expect(within(banner).queryByRole('link', { name: 'Open settings' })).toBeNull();
    await userEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Scoring change' })).toBeNull();
    first.unmount();

    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await waitFor(() => expect(seen['/api/v1/scoring/last-rescore']).toHaveLength(2));
    expect(screen.queryByRole('region', { name: 'Scoring change' })).toBeNull();
    cleanup();

    serveQueue({ rescore: { ...RESCORE, version: 8, tier_changed_count: 1 } });
    renderApp('/t/taazaa/queue');
    expect(await screen.findByRole('region', { name: 'Scoring change' })).toHaveTextContent(
      'Priorities were recalculated with Fit 60%, buying intent 40%. 1 account changed tier.',
    );
  });

  it('the banner leaves out the count when no account changed tier, and is not shown without a recent change', async () => {
    serveQueue({ rescore: { ...RESCORE, tier_changed_count: 0 } });
    const first = renderApp('/t/taazaa/queue');
    const banner = await screen.findByRole('region', { name: 'Scoring change' });
    expect(banner).toHaveTextContent(/Priorities were recalculated with Fit 60%, buying intent 40%\.$/);
    first.unmount();

    const seen = serveQueue({ rescore: null });
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await waitFor(() => expect(seen['/api/v1/scoring/last-rescore']).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Scoring change' })).toBeNull();
  });

  it('a filtered queue with no rows says so and clears the filters', async () => {
    serveQueue({ rows: [], facets: { ...FACETS, total: 0, total_all_tiers: 0 } });
    const app = renderApp('/t/taazaa/queue?practice=prc_data');
    expect(await screen.findByRole('heading', { name: 'No accounts match these filters' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(params(app.path()).has('practice')).toBe(false));
  });

  it('an empty queue says it is clear, with the last review and the actions the person may take', async () => {
    serveQueue({ rows: [], facets: { ...FACETS, total: 0, total_all_tiers: 0 } });
    renderApp('/t/taazaa/queue');
    expect(await screen.findByRole('heading', { name: 'The queue is clear' })).toBeInTheDocument();
    expect(screen.getByText(/New accounts land here when a source sends them/)).toBeInTheDocument();
    expect(screen.getByText(/^Last account reviewed .+\.$/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Import a list' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Manage sources' })).toBeInTheDocument();
    expect(screen.getByText('Nothing waiting for a decision.')).toBeInTheDocument();
  });

  it('shows skeleton rows while loading', async () => {
    serveQueue({ facets: { ...FACETS, source_count: 0 } });
    server.use(
      http.get('/api/v1/review-queue', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderApp('/t/taazaa/queue');
    expect(await screen.findByText('Loading accounts', { selector: 'p' })).toBeInTheDocument();
  });

  it('says what failed with the error ref, and Try again loads it', async () => {
    serveQueue();
    let fail = true;
    server.use(
      http.get('/api/v1/review-queue', () =>
        fail ? problem(500, 'Something went wrong', { ref: 'q-7f31c2' }) : HttpResponse.json({ data: [MIAMI], next_cursor: null }),
      ),
    );
    renderApp('/t/taazaa/queue');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The review queue didn't load");
    expect(alert).toHaveTextContent('Nothing was lost, and no decisions were changed.');
    expect(alert).toHaveTextContent(/Error ref q-7f31c2 · /);
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Miami-Dade County DTPW' })).toBeInTheDocument();
  });

  it('saves the columns for the person and shows the new set', async () => {
    serveQueue();
    let saved: unknown = null;
    server.use(
      http.put('/api/v1/me/preferences/review-queue-columns', async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({
          ...COLUMNS,
          columns: COLUMNS.columns.map((c) => (c.key === 'fit' ? { ...c, visible: true } : c)),
          shown: 9,
          is_default: false,
        });
      }),
    );
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    const panel = screen.getByRole('dialog', { name: 'Customize columns' });
    expect(panel).toHaveTextContent('Show, hide and reorder. Saved for you only.');
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Fit' }));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Fit' })).toBeInTheDocument());
    expect((saved as { columns: { key: string; visible: boolean }[] }).columns.find((c) => c.key === 'fit')).toEqual({ key: 'fit', visible: true });
    expect(screen.getByRole('button', { name: /^Columns 9 of 12$/ })).toBeInTheDocument();
  });

  it('bulk send back takes one reason for every account and keeps the refused ones selected with the API’s words', async () => {
    serveQueue();
    let body: Record<string, unknown> = {};
    server.use(
      http.post('/api/v1/review-queue/bulk', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          results: [
            { account_id: 'acc_mdc', ok: true },
            { account_id: 'acc_ccu', ok: false, status: 409, message: 'Someone else just changed this account.' },
          ],
        });
      }),
    );
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Miami-Dade County DTPW' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Coastline Credit Union' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('2 selected');
    await userEvent.click(within(bar).getByRole('button', { name: 'Send back' }));

    const dialog = await screen.findByRole('dialog', { name: 'Send 2 accounts back to their sources' });
    const send = within(dialog).getByRole('button', { name: 'Send back' });
    expect(send).toBeDisabled();
    expect(dialog).toHaveTextContent('Pick a reason to continue.');
    // Archived and other lists' reasons are not offered.
    expect(within(dialog).queryByRole('radio', { name: 'Old reason' })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: 'Already a customer' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Bad or missing contact' }));
    expect(dialog).toHaveTextContent('This reason needs a note. Say what the source should fix.');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What should the source fix before sending this again?' }), 'No buyer named');
    await userEvent.click(send);

    expect(await screen.findByText('Sent 1 account back to its source.')).toBeInTheDocument();
    expect(body).toEqual({ account_ids: ['acc_mdc', 'acc_ccu'], action: 'status', to: 'sent_back', reason_key: 'bad_contact', note: 'No buyer named' });
    const refused = await screen.findByRole('alert');
    expect(refused).toHaveTextContent('Coastline Credit Union: Someone else just changed this account.');
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('1 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Coastline Credit Union' })).toBeChecked();
  });

  it('select all takes the first 50 and says so', async () => {
    const many = Array.from({ length: 52 }, (_, i) => row({ account_id: `acc_${i}`, name: `Account ${i}` }));
    serveQueue({ rows: many, facets: { ...FACETS, total: 52, total_all_tiers: 52 } });
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Account 0' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('50 selected');
    expect(bar).toHaveTextContent('Selected the first 50. Bulk actions take 50 accounts at a time.');
    expect(screen.getByRole('checkbox', { name: 'Select Account 51' })).not.toBeChecked();
    await userEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('a refresh never moves rows: it shows "{n} updates" and Show applies them', async () => {
    let rows = [MIAMI, COASTLINE, PINEGATE];
    serveQueue();
    server.use(http.get('/api/v1/review-queue', () => HttpResponse.json({ data: rows, next_cursor: null })));
    const app = renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    rows = [row({ account_id: 'acc_new', name: 'Larkspur Health Partners', priority: 90 }), MIAMI, PINEGATE];
    await act(() => app.queryClient.refetchQueries({ queryKey: ['review-queue'] }));
    expect(await screen.findByText('2 updates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Coastline Credit Union' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Larkspur Health Partners' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('button', { name: 'Larkspur Health Partners' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coastline Credit Union' })).toBeNull();
    expect(screen.queryByText('2 updates')).toBeNull();
  });

  it('hides Assign to an AE without assign:act', async () => {
    serveQueue({ scopes: ['review:act', 'accounts:read'] });
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Miami-Dade County DTPW' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).queryByRole('button', { name: 'Assign to an AE' })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Send back' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import a list' })).toBeNull();
  });
});
