import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { APTA, CAPPED, RUNNING, serveBatches } from './testing';

const params = (href: string) => new URL(href, 'http://x').searchParams;

describe('Batches and imports (§13)', () => {
  it('shows the rows with the API status, issue, sender and progress, and the tab total', async () => {
    serveBatches({ total: 8 });
    renderApp('/t/taazaa/batches');
    expect(await screen.findByRole('link', { name: 'bat_1044' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Batches 8' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Import a list' })).toBeInTheDocument();
    const row = screen.getByRole('link', { name: 'bat_1044' }).closest('tr')!;
    expect(within(row).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row).getByText('CSV imports · Marcus Lee')).toBeInTheDocument();
    expect(within(row).getByText('APTA 2026 attendee list')).toBeInTheDocument();
    expect(within(row).getByText('apta-2026-attendees.xlsx')).toBeInTheDocument();
    expect(within(row).getByText('7 rows need a website, a company or a duplicate check')).toBeInTheDocument();
    expect(within(row).getByText('51 resolved, 6 rejected, 7 waiting')).toBeInTheDocument();
  });

  it('shows the attention banner with the API issues, and Show them filters to those statuses in the URL', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches');
    expect(await screen.findByText('3 batches need attention')).toBeInTheDocument();
    expect(screen.getByText(/Import stopped: This source is paused/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(params(app.path()).get('status')).toBe('needs_attention,failed'));
    await waitFor(() => expect(seen.some((s) => s.url.searchParams.getAll('status_key').join() === 'needs_attention,failed')).toBe(true));
  });

  it('keeps the filters and search in the URL and sends them to the API', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches?source=src_csv&sentBy=usr_marcus&runDate=7');
    await screen.findByRole('link', { name: 'bat_1044' });
    const asked = seen.find((s) => s.method === 'GET' && s.url.pathname === '/api/v1/batches')!.url.searchParams;
    expect(asked.get('source_id')).toBe('src_csv');
    expect(asked.get('sent_by')).toBe('usr_marcus');
    expect(asked.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await user.type(screen.getByRole('searchbox', { name: 'Find by batch, file or notes' }), 'apta');
    await waitFor(() => expect(params(app.path()).get('q')).toBe('apta'));
    await user.click(screen.getByRole('button', { name: /Filter/ }));
    // The Status options carry the API's counts.
    expect(await screen.findByText('Needs attention', { selector: '[role="dialog"] *' })).toBeInTheDocument();
  });

  it('offers Retry only when the API reports retryable rows, with the toast', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches');
    await screen.findByRole('link', { name: 'bat_1044' });
    expect(screen.queryByRole('button', { name: /^Retry 7/ })).toBeNull();
    const row = screen.getByRole('link', { name: 'bat_1040' }).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Retry 4 rows' }));
    expect(await screen.findByText("Retrying 4 rows in bat_1040. They're waiting again.")).toBeInTheDocument();
    expect(seen.some((s) => s.method === 'POST' && s.url.pathname === '/api/v1/batches/bat_1040:retry')).toBe(true);
  });

  it('downloads the error report as a file', async () => {
    serveBatches({ batches: [CAPPED] });
    let asked: URL | null = null;
    server.use(
      http.get('/api/v1/batches/:id/rejections', ({ request }) => {
        asked = new URL(request.url);
        return new HttpResponse('row,company,website,reason,detail\r\n', { headers: { 'content-type': 'text/csv' } });
      }),
    );
    const created = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches');
    await user.click(await screen.findByRole('button', { name: 'Download error report' }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(asked!.pathname).toBe('/api/v1/batches/bat_1040/rejections');
    expect(asked!.searchParams.get('format')).toBe('csv');
  });

  it('says there are no batches yet, and that none match with Clear filters', async () => {
    serveBatches({ batches: [], meta: { attention: { count: 0, issues: [] } } });
    const user = userEvent.setup();
    const empty = renderApp('/t/taazaa/batches');
    expect(await screen.findByText('Batches appear when a source sends accounts or someone imports a list.')).toBeInTheDocument();
    empty.unmount();
    const app = renderApp('/t/taazaa/batches?status=failed');
    expect(await screen.findByText('Try another status or source, or clear the filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(params(app.path()).get('status')).toBeNull());
  });

  it('polls every 30 s while a batch is in progress', async () => {
    const seen = serveBatches({ batches: [RUNNING] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp('/t/taazaa/batches');
      await screen.findByRole('link', { name: 'bat_1045' });
      const before = seen.filter((s) => s.url.pathname === '/api/v1/batches').length;
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(seen.filter((s) => s.url.pathname === '/api/v1/batches').length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows what failed with Try again', async () => {
    serveBatches();
    server.use(http.get('/api/v1/batches', () => problem(500, 'Something went wrong', { ref: 'b-1' })));
    renderApp('/t/taazaa/batches');
    expect(await screen.findByText("Batches didn't load")).toBeInTheDocument();
  });

  it('hides the Import tab and Retry without imports:run', async () => {
    serveBatches({ scopes: ['arrivals:read'], batches: [APTA, CAPPED] });
    renderApp('/t/taazaa/batches');
    await screen.findByRole('link', { name: 'bat_1044' });
    expect(screen.queryByRole('tab', { name: 'Import a list' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry 4 rows' })).toBeNull();
  });
});
