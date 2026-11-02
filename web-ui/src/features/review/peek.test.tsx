import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { LEADER, serveQueue } from './testing';

const params = (href: string) => new URL(href, 'http://app').searchParams;
const drawer = () => screen.getByRole('dialog', { name: /Miami-Dade County DTPW|Coastline Credit Union|Pinegate University/ });

beforeEach(() => localStorage.clear());

describe('Queue peek drawer', () => {
  it('opens from a row with the account in the URL, and moves with the arrows and j and k', async () => {
    serveQueue();
    const app = renderApp('/t/taazaa/queue');
    await userEvent.click(await screen.findByRole('button', { name: 'Miami-Dade County DTPW' }));
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    expect(params(app.path()).get('peek')).toBe('acc_mdc');
    expect(peek).toHaveTextContent('Public agency · Miami, FL · miamidade.gov');
    expect(peek).toHaveTextContent('1 of 3');
    expect(within(peek).getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/t/taazaa/accounts/acc_mdc?from=queue');
    expect(within(peek).getByRole('button', { name: 'Previous account' })).toBeDisabled();
    expect(peek).toHaveTextContent('Priority79');
    expect(peek).toHaveTextContent('Fit85');
    expect(peek).toHaveTextContent('Buying intent70');
    expect(within(peek).getByRole('combobox', { name: 'Best offer' })).toHaveDisplayValue("Scout's pick (Modernization Blueprint)");
    expect(within(peek).getByRole('combobox', { name: 'Tier' })).toHaveDisplayValue("Scout's tier (Act now)");
    expect(within(peek).getByRole('combobox', { name: 'Review status' })).toHaveDisplayValue('Ready for review');
    expect(peek).toHaveTextContent('RFP Watch · Marcus Lee · GovSpend');
    expect(peek).toHaveTextContent('No dated signals yet. Run Enrich to search procurement portals, news and job posts.');

    await userEvent.click(within(peek).getByRole('button', { name: 'Next account' }));
    expect(await screen.findByRole('dialog', { name: 'Coastline Credit Union' })).toHaveTextContent('2 of 3');
    expect(drawer()).toHaveTextContent('Declined by Ash Patel on Oct 25, 2026: Outside my territory');
    await userEvent.keyboard('j');
    expect(await screen.findByRole('dialog', { name: 'Pinegate University' })).toHaveTextContent('3 of 3');
    expect(drawer()).toHaveTextContent('Scout scored this Good fit. You changed it.');
    expect(drawer()).toHaveTextContent('Changed by Dana Whitfield');
    await userEvent.keyboard('k');
    expect(await screen.findByRole('dialog', { name: 'Coastline Credit Union' })).toBeInTheDocument();
    expect(params(app.path()).get('peek')).toBe('acc_ccu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(params(app.path()).has('peek')).toBe(false));
  });

  it('shows Why now, notes and changes from the API', async () => {
    serveQueue();
    server.use(
      http.get('/api/v1/accounts/acc_mdc', () =>
        HttpResponse.json({
          id: 'acc_mdc',
          signals: [
            { id: 's1', title: 'RFP posted for transit data platform', detail: null, url: null, occurred_at: '2026-10-22T12:00:00Z' },
            { id: 's0', title: 'Undated news', detail: null, url: null, occurred_at: null },
            { id: 's2', title: 'New CIO hired', detail: null, url: null, occurred_at: '2026-10-10T12:00:00Z' },
            { id: 's3', title: 'Older', detail: null, url: null, occurred_at: '2026-09-10T12:00:00Z' },
          ],
        }),
      ),
      http.get('/api/v1/accounts/acc_mdc/notes', () =>
        HttpResponse.json({ data: [{ id: 'n1', body: 'We met Jarice at APTA.', by_user_id: 'u1', by_name: 'Priya Raman', at: '2026-10-25T12:00:00Z' }], total: 1 }),
      ),
      http.get('/api/v1/accounts/acc_mdc/changes', () =>
        HttpResponse.json({
          data: [
            { id: 'c2', at: '2026-10-26T12:00:00Z', kind: 'lead_offer', field: 'best_offer', from: "Scout's pick", to: 'AI Opportunity Map', by_name: 'Dana Whitfield', note: null, reason: null, priority: null },
            { id: 'c1', at: '2026-10-24T12:00:00Z', kind: 'scored', field: 'tier', from: null, to: 'Act now', by_name: null, note: 'New signals', reason: null, priority: 79 },
            { id: 'c0', at: '2026-10-24T11:00:00Z', kind: 'arrived', field: null, from: null, to: 'RFP Watch', by_name: null, note: null, reason: null, priority: null },
          ],
          next_cursor: null,
        }),
      ),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    expect(await within(peek).findByText('RFP posted for transit data platform')).toBeInTheDocument();
    expect(within(peek).getByText('New CIO hired')).toBeInTheDocument();
    expect(within(peek).queryByText('Undated news')).toBeNull();
    expect(within(peek).queryByText('Older')).toBeNull();
    expect(await within(peek).findByText('We met Jarice at APTA.')).toBeInTheDocument();
    expect(peek).toHaveTextContent('1 note');
    expect(peek).toHaveTextContent('Priya Raman · Oct 25, 2026');
    expect(await within(peek).findByText(/Best offer changed from Scout's pick to AI Opportunity Map/)).toHaveTextContent('Dana Whitfield');
    expect(within(peek).getByText(/Scored 79 and placed in Act now/)).toHaveTextContent('Scout');
    expect(within(peek).getByText(/Arrived from RFP Watch/)).toBeInTheDocument();
  });

  it('shows a date-only signal on its own day in a US workspace', async () => {
    serveQueue();
    serveMe({ taazaa: { scopes: LEADER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
    server.use(
      http.get('/api/v1/accounts/acc_mdc', () =>
        HttpResponse.json({ id: 'acc_mdc', signals: [{ id: 's1', title: 'RFP posted', detail: null, url: null, occurred_at: '2026-10-14T00:00:00.000Z' }] }),
      ),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    expect(await within(peek).findByText('Oct 14, 2026')).toBeInTheDocument();
  });

  it('adds a note, and says to write it first when empty', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/accounts/acc_mdc/notes', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'n2', body: 'x', by_user_id: 'u', by_name: 'Dana', at: '2026-10-31T10:00:00Z' }, { status: 201 });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(within(peek).getByRole('button', { name: 'Add note' }));
    expect(peek).toHaveTextContent('Write the note first, then add it.');
    expect(body).toBeNull();
    await userEvent.type(within(peek).getByRole('textbox', { name: 'Add a note' }), 'Ash knows their CIO.');
    await userEvent.click(within(peek).getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Note added. Everyone reviewing this account can see it.')).toBeInTheDocument();
    expect(body).toEqual({ body: 'Ash knows their CIO.' });
  });

  it('changes the best offer and the tier inline, with a note for the tier', async () => {
    serveQueue();
    const sent: Record<string, unknown> = {};
    server.use(
      http.put('/api/v1/accounts/acc_mdc/lead-offer', async ({ request }) => {
        sent.offer = await request.json();
        return HttpResponse.json({});
      }),
      http.put('/api/v1/accounts/acc_mdc/tier', async ({ request }) => {
        sent.tier = await request.json();
        return HttpResponse.json({});
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await waitFor(() => expect(within(peek).getByRole('combobox', { name: 'Best offer' })).toBeEnabled());
    await userEvent.selectOptions(within(peek).getByRole('combobox', { name: 'Best offer' }), 'AI Opportunity Map');
    expect(await screen.findByText('Best offer changed to AI Opportunity Map.')).toBeInTheDocument();
    expect(sent.offer).toEqual({ offer_id: 'off_aom' });

    await userEvent.type(within(peek).getByRole('textbox', { name: 'Why change it?' }), 'Board meets monthly');
    await userEvent.selectOptions(within(peek).getByRole('combobox', { name: 'Tier' }), 'Watch');
    expect(await screen.findByText('Tier changed to Watch.')).toBeInTheDocument();
    expect(sent.tier).toEqual({ tier: 'watch', note: 'Board meets monthly' });
  });

  it('shows the API’s words when an inline change fails', async () => {
    serveQueue();
    server.use(http.put('/api/v1/accounts/acc_mdc/lead-offer', () => problem(400, 'Pick an approved offer.')));
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await waitFor(() => expect(within(peek).getByRole('combobox', { name: 'Best offer' })).toBeEnabled());
    await userEvent.selectOptions(within(peek).getByRole('combobox', { name: 'Best offer' }), 'AI Opportunity Map');
    expect(await screen.findByText('Pick an approved offer.')).toBeInTheDocument();
  });

  it('a plain status saves at once; a declined status asks for a reason; a send-back status opens Send back', async () => {
    serveQueue();
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/v1/accounts/:id/review-status', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ review_status_key: 'x' });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    const select = within(peek).getByRole('combobox', { name: 'Review status' });
    await userEvent.selectOptions(select, 'In review');
    expect(await screen.findByText('Review status changed to In review.')).toBeInTheDocument();
    expect(bodies[0]).toEqual({ to: 'needs_review' });

    await userEvent.selectOptions(select, 'Not pursued');
    const decline = await screen.findByRole('dialog', { name: 'Why is Miami-Dade County DTPW not pursued?' });
    expect(within(decline).getByRole('radio', { name: 'Already a customer' })).toBeInTheDocument();
    expect(within(decline).getByRole('radio', { name: 'Something else' })).toBeInTheDocument();
    expect(within(decline).queryByRole('radio', { name: 'Bad or missing contact' })).toBeNull();
    const mark = within(decline).getByRole('button', { name: 'Mark Not pursued' });
    expect(mark).toBeDisabled();
    await userEvent.click(within(decline).getByRole('radio', { name: 'Something else' }));
    expect(mark).toBeDisabled();
    await userEvent.type(within(decline).getByRole('textbox', { name: 'Note' }), 'Partner owns it');
    await userEvent.click(mark);
    await waitFor(() => expect(bodies[1]).toEqual({ to: 'declined', reason_key: 'other', note: 'Partner owns it' }));

    await userEvent.selectOptions(within(screen.getByRole('dialog', { name: 'Miami-Dade County DTPW' })).getByRole('combobox', { name: 'Review status' }), 'Sent back to source');
    expect(await screen.findByRole('dialog', { name: 'Send back to RFP Watch (Marcus Lee)' })).toBeInTheDocument();
  });

  it('a status changed while the changes are still loading shows in the changes once saved', async () => {
    serveQueue();
    let saved = false;
    let release = () => {};
    const firstLoad = new Promise<void>((resolve) => (release = resolve));
    const changed = { id: 'c1', at: '2026-10-26T12:00:00Z', kind: 'status', field: 'review_status', from: 'Ready for review', to: 'In review', by_name: 'Dana Whitfield', note: null, reason: null, priority: null };
    server.use(
      http.get('/api/v1/accounts/acc_mdc/changes', async () => {
        // The first load read the account before the change: it answers after the change, without it.
        const before = !saved;
        if (before) await firstLoad;
        return HttpResponse.json({ data: before ? [] : [changed], next_cursor: null });
      }),
      http.patch('/api/v1/accounts/:id/review-status', () => {
        saved = true;
        setTimeout(release, 0);
        return HttpResponse.json({ review_status_key: 'needs_review' });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await userEvent.selectOptions(within(peek).getByRole('combobox', { name: 'Review status' }), 'In review');
    expect(await screen.findByText('Review status changed to In review.')).toBeInTheDocument();
    expect(await within(peek).findByText(/^Review status changed from Ready for review to In review/)).toBeInTheDocument();
  });

  it('Send back from the peek names the source owner, sends the reason and opens the next account', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.patch('/api/v1/accounts/acc_mdc/review-status', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const app = renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(within(peek).getByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back to RFP Watch (Marcus Lee)' });
    const go = await within(dialog).findByRole('button', { name: 'Send back to Marcus' });
    expect(go).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Not our kind of customer' }));
    await userEvent.click(go);
    expect(await screen.findByText('Sent back to Marcus Lee. Miami-Dade County DTPW left the queue.')).toBeInTheDocument();
    expect(body).toEqual({ to: 'sent_back', reason_key: 'not_our_kind_of_customer' });
    await waitFor(() => expect(params(app.path()).get('peek')).toBe('acc_ccu'));
  });

  it('a single send back that the API refuses shows its words in the dialog', async () => {
    serveQueue();
    server.use(http.patch('/api/v1/accounts/acc_mdc/review-status', () => problem(409, 'Someone else just changed this account.')));
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(within(peek).getByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back to RFP Watch (Marcus Lee)' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: 'Not our kind of customer' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back to Marcus' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Someone else just changed this account.');
  });
});
