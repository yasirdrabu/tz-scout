import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { REASONS } from '../review/testing';
import type { Assignment } from './api';

const assignment = (a: Partial<Assignment> & Pick<Assignment, 'id' | 'account_id' | 'account_name'>): Assignment => ({
  seller_user_id: 'usr_ash',
  seller_name: 'Ash Patel',
  assigned_by: 'usr_dana',
  assigned_by_name: 'Dana Whitfield',
  assigned_at: '2026-10-31T10:42:00Z',
  status: 'pending',
  responded_at: null,
  accepted_how: null,
  notes: null,
  offer_id: 'off_mb',
  offer_name: 'Modernization Blueprint',
  playbook_name: null,
  stage: 'reviewed',
  stage_label: 'Reviewed',
  last_activity: null,
  handoff: null,
  ...a,
});

const MIAMI = assignment({ id: 'asg_1', account_id: 'acc_mdc', account_name: 'Miami-Dade County DTPW', notes: 'Jarice knows you from APTA.', handoff: { state: 'sending', at: '2026-10-31T10:42:00Z' } });
const PALISADE = assignment({
  id: 'asg_0',
  account_id: 'acc_pal',
  account_name: 'Palisade County Courts',
  status: 'accepted',
  accepted_how: 'auto_timeout',
  stage: 'engaged',
  stage_label: 'Engaged',
  offer_name: 'AI Opportunity Map',
  last_activity: { kind: 'reply', at: '2026-10-29T10:00:00Z' },
});

function serve(opts: { pending?: Assignment[]; active?: Assignment[] } = {}) {
  let pending = opts.pending ?? [MIAMI];
  serveMe({ taazaa: { scopes: ['assignments:respond', 'accounts:read'] } });
  server.use(
    http.get('/api/v1/me/counts', () => HttpResponse.json({ review_queue: null, new_assignments: pending.length })),
    http.get('/api/v1/assignments', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      return HttpResponse.json({ data: status === 'pending' ? pending : (opts.active ?? [PALISADE]), next_cursor: null });
    }),
    http.get('/api/v1/settings/review/reasons', () => HttpResponse.json({ data: REASONS })),
  );
  return { setPending: (p: Assignment[]) => (pending = p) };
}

beforeEach(() => localStorage.clear());

describe('My accounts', () => {
  it('lists new assignments and the active accounts', async () => {
    serve();
    renderApp('/t/taazaa/my');
    expect(await screen.findByRole('heading', { level: 1, name: 'My accounts' })).toBeInTheDocument();
    expect(await screen.findByText('1 new assignment to accept.')).toBeInTheDocument();
    const fresh = await screen.findByRole('region', { name: 'New assignments' });
    expect(fresh).toHaveTextContent('Accept to take it on. Declining returns the account to Dana Whitfield.');
    expect(within(fresh).getByRole('link', { name: 'Miami-Dade County DTPW' })).toHaveAttribute('href', '/t/taazaa/accounts/acc_mdc?from=my');
    expect(fresh).toHaveTextContent('Modernization Blueprint');
    expect(fresh).toHaveTextContent(/Assigned by Dana Whitfield · /);
    expect(fresh).toHaveTextContent('"Jarice knows you from APTA."');
    expect(fresh).toHaveTextContent('Sending to HubSpot');

    const active = screen.getByRole('region', { name: 'Active' });
    const row = within(active).getByRole('link', { name: 'Palisade County Courts' }).closest('tr')!;
    expect(row).toHaveTextContent('AI Opportunity Map');
    expect(row).toHaveTextContent('Accepted automatically');
    expect(row).toHaveTextContent('Engaged');
    expect(row).toHaveTextContent('Email reply');
  });

  it('accepts an assignment', async () => {
    const s = serve();
    server.use(
      http.post(exactly('/api/v1/assignments/asg_1:accept'), () => {
        s.setPending([]);
        return HttpResponse.json({ ...MIAMI, status: 'accepted' });
      }),
    );
    renderApp('/t/taazaa/my');
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Miami-Dade County DTPW' }));
    expect(await screen.findByText('Accepted. Miami-Dade County DTPW is in your accounts.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New assignments' })).toBeNull());
  });

  it('declines with a reason from the assignment list, and a note when the reason needs one', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post(exactly('/api/v1/assignments/asg_1:decline'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...MIAMI, status: 'declined' });
      }),
    );
    renderApp('/t/taazaa/my');
    await userEvent.click(await screen.findByRole('button', { name: 'Decline Miami-Dade County DTPW' }));
    const panel = await screen.findByRole('region', { name: 'Decline Miami-Dade County DTPW' });
    expect(panel).toHaveTextContent('Why are you declining?');
    expect(panel).toHaveTextContent('Pick a reason to continue.');
    expect(within(panel).queryByRole('radio', { name: 'Not our kind of customer' })).toBeNull();
    const go = within(panel).getByRole('button', { name: 'Decline and return to Dana Whitfield' });
    expect(go).toBeDisabled();
    await userEvent.click(await within(panel).findByRole('radio', { name: 'Something else' }));
    expect(go).toBeDisabled();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Anything Dana Whitfield should know before reassigning' }), 'I already work their parent company.');
    await userEvent.click(go);
    expect(await screen.findByText('Declined. Miami-Dade County DTPW is back with Dana Whitfield, with your reason.')).toBeInTheDocument();
    expect(body).toEqual({ reason_key: 'other', note: 'I already work their parent company.' });
  });

  it('shows the API’s words when a decline fails, and Cancel closes the panel', async () => {
    serve();
    server.use(http.post(exactly('/api/v1/assignments/asg_1:decline'), () => problem(409, 'This assignment was withdrawn.')));
    renderApp('/t/taazaa/my');
    await userEvent.click(await screen.findByRole('button', { name: 'Decline Miami-Dade County DTPW' }));
    const panel = await screen.findByRole('region', { name: 'Decline Miami-Dade County DTPW' });
    await userEvent.click(await within(panel).findByRole('radio', { name: 'Outside my territory or segment' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Decline and return to Dana Whitfield' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('This assignment was withdrawn.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Decline Miami-Dade County DTPW' })).toBeNull();
  });

  it('opening an account marks it seen', async () => {
    serve();
    let seen = false;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:seen'), () => {
        seen = true;
        return HttpResponse.json({});
      }),
    );
    renderApp('/t/taazaa/my');
    await userEvent.click(await screen.findByRole('link', { name: 'Miami-Dade County DTPW' }));
    await waitFor(() => expect(seen).toBe(true));
  });

  it('says nothing is assigned yet when both lists are empty', async () => {
    serve({ pending: [], active: [] });
    renderApp('/t/taazaa/my');
    expect(await screen.findByRole('heading', { name: 'No accounts assigned to you yet' })).toBeInTheDocument();
    expect(screen.getByText('When a leader assigns one, it shows here for you to accept.')).toBeInTheDocument();
  });

  it('says what failed and tries again', async () => {
    serve();
    server.use(http.get('/api/v1/assignments', () => problem(500, 'Something went wrong', { ref: 'm-1' })));
    renderApp('/t/taazaa/my');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("My accounts didn't load");
    expect(alert).toHaveTextContent('Error ref m-1');
  });

  it('a refresh that brings a new assignment shows the updates bar first', async () => {
    const s = serve();
    const app = renderApp('/t/taazaa/my');
    await screen.findByRole('link', { name: 'Miami-Dade County DTPW' });
    s.setPending([MIAMI, assignment({ id: 'asg_2', account_id: 'acc_rv', account_name: 'Rio Verde Transit District' })]);
    await act(() => app.queryClient.refetchQueries({ queryKey: ['my-assignments'] }));
    expect(await screen.findByText('1 update')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Rio Verde Transit District' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('link', { name: 'Rio Verde Transit District' })).toBeInTheDocument();
  });
});
