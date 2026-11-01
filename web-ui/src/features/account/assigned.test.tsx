import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { ASSIGNED, HANDOFFS, REVIEW, SELLER, serveAccount } from './testing';

const header = async () => (await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' })).closest('div[class]')!.parentElement!.parentElement!;

beforeEach(() => localStorage.clear());

describe('Account page after assignment', () => {
  it('the header shows the handoff state, who assigned it, Reassign and Open in HubSpot', async () => {
    serveAccount({ review: ASSIGNED });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(card).toHaveTextContent('Sending to HubSpot');
    expect(card).toHaveTextContent('Assigned to Ash Patel by Dana Whitfield on Oct 26, 2026');
    expect(within(card).getByRole('button', { name: 'Reassign' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Approve and assign' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Send back' })).toBeNull();
    const open = await within(card).findByRole('link', { name: 'Open in HubSpot' });
    expect(open).toHaveAttribute('href', 'https://app.hubspot.com/contacts/1/record/0-2/99');
    expect(open).toHaveAttribute('target', '_blank');
    expect(within(card).queryByRole('button', { name: 'Retry sending' })).toBeNull();
  });

  it('says In HubSpot with the seller, and no Open in HubSpot without a link', async () => {
    serveAccount({
      review: { ...ASSIGNED, flags: { handoff: { handoff_id: 'hnd_1', state: 'in_crm', at: '2026-10-27T09:00:00Z' } } },
      handoffs: { ...HANDOFFS, handoffs: [{ ...HANDOFFS.handoffs[0]!, crm_url: null }] },
    });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(await within(card).findByText('In HubSpot · Ash Patel')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'HubSpot activity' });
    expect(within(card).queryByRole('link', { name: 'Open in HubSpot' })).toBeNull();
  });

  it('Retry sending after a failed send, for crm:push', async () => {
    serveAccount({ review: { ...ASSIGNED, flags: { handoff: { handoff_id: 'hnd_1', state: 'failed', at: '2026-10-27T09:00:00Z' } } } });
    let pushed = false;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:push'), () => {
        pushed = true;
        return HttpResponse.json({ handoff_id: 'hnd_2' }, { status: 202 });
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(card).toHaveTextContent('HubSpot send failed');
    await userEvent.click(within(card).getByRole('button', { name: 'Retry sending' }));
    expect(await screen.findByText('Sending Miami-Dade County DTPW to HubSpot again.')).toBeInTheDocument();
    expect(pushed).toBe(true);
  });

  it('shows the API words when Retry sending fails, and no Retry without crm:push', async () => {
    serveAccount({ review: { ...ASSIGNED, flags: { handoff: { handoff_id: 'hnd_1', state: 'failed', at: '2026-10-27T09:00:00Z' } } } });
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:push'), () => problem(409, 'A send is already running.')));
    renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await header()).getByRole('button', { name: 'Retry sending' }));
    expect(await screen.findByText('A send is already running.')).toBeInTheDocument();
  });

  it('a seller sees no Reassign and no Retry sending', async () => {
    serveAccount({ scopes: SELLER, review: { ...ASSIGNED, flags: { handoff: { handoff_id: 'hnd_1', state: 'failed', at: '2026-10-27T09:00:00Z' } } } });
    renderApp('/t/taazaa/accounts/acc_mdc?from=my');
    const card = await header();
    expect(within(card).queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Retry sending' })).toBeNull();
  });

  it('Reassign opens the Assign dialog', async () => {
    serveAccount({ review: ASSIGNED });
    renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await header()).getByRole('button', { name: 'Reassign' }));
    expect(await screen.findByRole('dialog', { name: 'Assign Miami-Dade County DTPW' })).toBeInTheDocument();
  });

  it('shows the two companies notice from the handoffs', async () => {
    serveAccount({ review: ASSIGNED, handoffs: { ...HANDOFFS, conflict: true } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('This account is linked to two HubSpot companies. Merge them in HubSpot so Scout knows which one to update.')).toBeInTheDocument();
  });

  it('outcome tiles: Replies "{n} of {m}" since the handoff, and Opportunity Not yet or the open deal', async () => {
    serveAccount({ review: ASSIGNED });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const outcomes = await screen.findByRole('region', { name: 'Outcomes' });
    expect(await within(outcomes).findByText('3 of 9')).toBeInTheDocument();
    expect(outcomes).toHaveTextContent('Emails sent since Oct 27, 2026');
    expect(outcomes).toHaveTextContent('OpportunityNot yet');
    expect(outcomes).not.toHaveTextContent('Meetings held');
    expect(outcomes).not.toHaveTextContent('Buyers engaged');
  });

  it('the Opportunity tile names the open deal and its value', async () => {
    serveAccount({ review: ASSIGNED, handoffs: { ...HANDOFFS, deals: [{ id: 'd1', name: 'Transit data audit', status: 'open', amount_cents: 4800000, currency: 'USD' }] } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const outcomes = await screen.findByRole('region', { name: 'Outcomes' });
    expect(await within(outcomes).findByText('Transit data audit')).toBeInTheDocument();
    expect(outcomes).toHaveTextContent('$48,000');
  });

  it('HubSpot activity: synced when, the rows, Show more by cursor', async () => {
    serveAccount({ review: ASSIGNED });
    const cursors: (string | null)[] = [];
    server.use(
      http.get('/api/v1/accounts/acc_mdc/activity', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          cursor
            ? { data: [{ id: 'hnd_1:sent', kind: 'scout', at: '2026-10-27T09:00:00Z', summary: 'Scout sent the account to HubSpot with Ash Patel as owner and logged the brief.' }], next_cursor: null, synced_at: null }
            : { data: [{ id: 'a1', kind: 'reply', at: '2026-11-13T09:00:00Z', summary: 'Reply received' }], next_cursor: 'c2', synced_at: new Date(Date.now() - 2 * 60_000).toISOString() },
        );
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const activity = await screen.findByRole('region', { name: 'HubSpot activity' });
    expect(await within(activity).findByText('Reply received')).toBeInTheDocument();
    expect(activity).toHaveTextContent('Synced 2 minutes ago');
    await userEvent.click(within(activity).getByRole('button', { name: 'Show more' }));
    expect(await within(activity).findByText('Scout sent the account to HubSpot with Ash Patel as owner and logged the brief.')).toBeInTheDocument();
    expect(cursors).toEqual([null, 'c2']);
    expect(within(activity).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('HubSpot activity empty state', async () => {
    serveAccount({ review: ASSIGNED });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('No HubSpot activity yet. Replies, emails and meetings show here as HubSpot records them.')).toBeInTheDocument();
  });

  it('HubSpot activity that fails says so and tries again', async () => {
    serveAccount({ review: ASSIGNED });
    let calls = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc/activity', () => {
        calls += 1;
        return calls === 1 ? problem(500, 'Scout could not read the activity.') : HttpResponse.json({ data: [], next_cursor: null, synced_at: null });
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const activity = await screen.findByRole('region', { name: 'HubSpot activity' });
    expect(await within(activity).findByRole('alert')).toHaveTextContent("HubSpot activity didn't load. Scout could not read the activity.");
    await userEvent.click(within(activity).getByRole('button', { name: 'Try again' }));
    expect(await within(activity).findByText(/^No HubSpot activity yet/)).toBeInTheDocument();
  });

  it('the review record: approved by, the scores, first sentences, and the full brief read only on demand', async () => {
    serveAccount({ review: ASSIGNED });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const record = await screen.findByRole('region', { name: 'Review record' });
    expect(record).toHaveTextContent('Approved by Dana Whitfield on Oct 26, 2026');
    expect(await within(record).findByText('Miami-Dade County runs the transit system.')).toBeInTheDocument();
    expect(record).not.toHaveTextContent('It has 3,800 staff.');
    expect(record).toHaveTextContent('Priority79 / 100');
    const more = within(record).getByRole('button', { name: 'Show the full brief, signals and facts' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(await within(record).findByRole('region', { name: 'Why now' })).toBeInTheDocument();
    expect(within(record).getByRole('region', { name: 'Account facts' })).toBeInTheDocument();
    const brief = within(record).getByRole('region', { name: 'Brief' });
    expect(await within(brief).findByText('Miami-Dade County runs the transit system. It has 3,800 staff.')).toBeInTheDocument();
    expect(within(brief).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(record).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('the assignment card: waiting, accepted, accepted automatically, the quoted note and the handoff chip', async () => {
    serveAccount({ review: ASSIGNED });
    const app = renderApp('/t/taazaa/accounts/acc_mdc');
    let card = await screen.findByRole('region', { name: 'Assignment' });
    expect(card).toHaveTextContent('Ash Patel');
    expect(card).toHaveTextContent('Waiting for Ash Patel to accept');
    expect(card).toHaveTextContent('"Jarice knows you from APTA."');
    expect(card).toHaveTextContent('Dana Whitfield');
    expect(card).toHaveTextContent('Sending to HubSpot');

    const accepted = (how: string) => ({ ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, status: 'accepted', accepted_how: how, responded_at: '2026-10-27T12:15:00Z' } });
    server.use(http.get('/api/v1/accounts/acc_mdc/review', () => HttpResponse.json(accepted('seller'))));
    await app.queryClient.invalidateQueries({ queryKey: ['account', 'taazaa', 'acc_mdc', 'review'] });
    card = await screen.findByRole('region', { name: 'Assignment' });
    await waitFor(() => expect(card).toHaveTextContent(/Accepted Oct 27/));
    server.use(http.get('/api/v1/accounts/acc_mdc/review', () => HttpResponse.json(accepted('auto_timeout'))));
    await app.queryClient.invalidateQueries({ queryKey: ['account', 'taazaa', 'acc_mdc', 'review'] });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Assignment' })).toHaveTextContent(/Accepted automatically Oct 27/));
  });

  it('after Approve and assign the page shows the assigned view', async () => {
    serveAccount();
    let assigned = false;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign'), () => {
        assigned = true;
        return HttpResponse.json({ id: 'asg_1' }, { status: 202 });
      }),
      http.get('/api/v1/accounts/acc_mdc/review', () => HttpResponse.json(assigned ? ASSIGNED : REVIEW)),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await header()).getByRole('button', { name: 'Approve and assign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign Miami-Dade County DTPW' });
    const go = await within(dialog).findByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByRole('region', { name: 'Assignment' })).toHaveTextContent('Waiting for Ash Patel to accept');
    expect(within(await header()).getByRole('button', { name: 'Reassign' })).toBeInTheDocument();
    expect(screen.queryByText(/a moment ago/)).toBeNull();
  });
});
