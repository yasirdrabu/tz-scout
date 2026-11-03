import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { EnrichmentRequest } from './api';
import { APPROVER, REQUEST, REQUESTER } from './testing';

const URL_ = '/t/taazaa/enrichment';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 3_600_000).toISOString();

const FLAGGED: EnrichmentRequest = {
  ...REQUEST,
  status: 'flagged',
  status_text: 'Waiting for approval',
  requested_by_label: 'Dana Ruiz',
  reason: 'Strong fit, no technical buyer yet.',
  decided_by_label: null,
  decided_at: null,
  created_at: daysAgo(3),
};
const DECLINED: EnrichmentRequest = { ...FLAGGED, id: 'enr_2', status: 'declined', status_text: 'Declined: Too early', created_at: daysAgo(0) };

function serve(scopes: string[], opts: { rows?: EnrichmentRequest[]; next?: string | null } = {}) {
  serveMe({ taazaa: { scopes } });
  const lists: URL[] = [];
  server.use(
    http.get('/api/v1/enrichment-requests', ({ request }) => {
      const u = new URL(request.url);
      lists.push(u);
      const flagged = u.searchParams.get('status') === 'flagged';
      const rows = opts.rows ?? [FLAGGED, DECLINED];
      return HttpResponse.json({ data: flagged ? rows.filter((r) => r.status === 'flagged') : rows, next_cursor: opts.next ?? null });
    }),
  );
  return lists;
}

beforeEach(() => localStorage.clear());

describe('Enrichment requests (§22)', () => {
  it('lists the flagged requests with every column, the account as a link, and the age', async () => {
    const lists = serve(APPROVER);
    renderApp(URL_);
    const link = await screen.findByRole('link', { name: 'Miami-Dade County DTPW' });
    const row = link.closest('tr')!;
    expect(link).toHaveAttribute('href', '/t/taazaa/accounts/acc_mdc');
    expect(within(row).getByText('People for buying roles')).toBeInTheDocument();
    expect(within(row).getByText('Apollo')).toBeInTheDocument();
    expect(within(row).getByText('Dana Ruiz')).toBeInTheDocument();
    expect(within(row).getByText('Strong fit, no technical buyer yet.')).toBeInTheDocument();
    expect(within(row).getByText('Up to 3 credits, about $0.30')).toBeInTheDocument();
    expect(within(row).getByText('3 days')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Age' })).toBeInTheDocument();
    expect(lists.at(-1)!.searchParams.get('status')).toBe('flagged');
    expect(screen.queryByText('Declined: Too early')).toBeNull();
  });

  it('shows Approve and Decline only to an approver', async () => {
    serve(REQUESTER);
    renderApp(URL_);
    await screen.findByRole('link', { name: 'Miami-Dade County DTPW' });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('Approve posts and shows the toast', async () => {
    serve(APPROVER);
    const posted: string[] = [];
    server.use(
      http.post(exactly('/api/v1/enrichment-requests/enr_1:approve'), ({ request }) => {
        posted.push(request.url);
        return HttpResponse.json({ ...FLAGGED, status: 'approved' }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderApp(URL_);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. Enrichment started for Miami-Dade County DTPW.')).toBeInTheDocument();
    expect(posted).toHaveLength(1);
  });

  it('Decline needs a reason, then posts it and shows the toast', async () => {
    serve(APPROVER);
    const bodies: unknown[] = [];
    server.use(
      http.post(exactly('/api/v1/enrichment-requests/enr_1:decline'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...FLAGGED, status: 'declined' });
      }),
    );
    const user = userEvent.setup();
    renderApp(URL_);
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(within(dialog).getByText("Say why you're declining.")).toBeInTheDocument();
    expect(bodies).toEqual([]);
    await user.type(within(dialog).getByRole('textbox', { name: 'Why decline?' }), 'Too early');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined. Dana Ruiz will see your reason.')).toBeInTheDocument();
    expect(bodies).toEqual([{ reason: 'Too early' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the API error when approving fails', async () => {
    serve(APPROVER);
    server.use(http.post(exactly('/api/v1/enrichment-requests/enr_1:approve'), () => problem(409, 'Someone already decided this.')));
    const user = userEvent.setup();
    renderApp(URL_);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Someone already decided this.')).toBeInTheDocument();
  });

  it('says what an empty Waiting tab and an empty All tab mean', async () => {
    serve(APPROVER, { rows: [] });
    const user = userEvent.setup();
    renderApp(URL_);
    expect(await screen.findByText('Nothing waiting. Requests from sellers and agents show here for a leader to approve.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('No enrichment requests yet.')).toBeInTheDocument();
  });

  it('the All tab asks with no status and shows the status text instead of the age', async () => {
    const lists = serve(APPROVER);
    const user = userEvent.setup();
    renderApp(URL_);
    await screen.findByRole('link', { name: 'Miami-Dade County DTPW' });
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('Declined: Too early')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Age' })).toBeNull();
    expect(lists.at(-1)!.searchParams.has('status')).toBe(false);
  });

  it('shows Today for a request made today, and Load more follows the cursor', async () => {
    const lists = serve(APPROVER, { rows: [{ ...FLAGGED, created_at: new Date().toISOString() }], next: 'c2' });
    const user = userEvent.setup();
    renderApp(URL_);
    expect(await screen.findByText('Today')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(lists.at(-1)!.searchParams.get('cursor')).toBe('c2'));
  });

  it('offers Try again when the list fails', async () => {
    serveMe({ taazaa: { scopes: APPROVER } });
    server.use(http.get('/api/v1/enrichment-requests', () => problem(500, 'Something went wrong.')));
    renderApp(URL_);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
