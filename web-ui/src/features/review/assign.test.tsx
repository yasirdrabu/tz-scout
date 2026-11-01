import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { NEW_PREFLIGHT, row, serveQueue } from './testing';

const OPEN_DEAL = {
  result: 'stop',
  message: 'Open deal owned by Vijay Kumar: will not change owner',
  reason: 'open_deal',
  current_owner_name: 'Vijay Kumar',
  deal: { name: 'Open Deal renewal', amount_cents: 5_000_000, currency: 'USD', last_activity_at: '2026-10-02T12:00:00Z' },
};
const stopPreview = (preflight: Record<string, unknown>) => () => HttpResponse.json({ preflight, approves_to: null, replaces: null });

beforeEach(() => localStorage.clear());

async function openFromPeek() {
  const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
  await userEvent.click(within(peek).getByRole('button', { name: 'Approve and assign' }));
  return screen.findByRole('dialog', { name: 'Assign Miami-Dade County DTPW' });
}

describe('Assign dialog', () => {
  it('shows the AEs with the API’s Best match picked, and one with no HubSpot user cannot be picked', async () => {
    serveQueue();
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    expect(dialog).toHaveTextContent('Modernization Blueprint · Data and Engineering for AI Readiness');
    const ash = await within(dialog).findByRole('radio', { name: /^Ash Patel/ });
    expect(ash).toBeChecked();
    const card = ash.closest('label')!;
    expect(card).toHaveTextContent('Best match');
    expect(card).toHaveTextContent('Covers Data and Engineering for AI Readiness and has the fewest active accounts (4).');
    expect(card).toHaveTextContent('4active accounts');
    expect(within(dialog).getByRole('radio', { name: /^Maya Chen/ }).closest('label')).toHaveTextContent('All practices');
    const jordan = within(dialog).getByRole('radio', { name: /^Jordan Ellis/ });
    expect(jordan).toBeDisabled();
    expect(jordan.closest('label')).toHaveTextContent('No HubSpot user linked');
    expect(within(dialog).getByRole('link', { name: 'Link in Members' })).toHaveAttribute('href', '/t/taazaa/settings/members');
    expect(await within(dialog).findByText('Scout sends Miami-Dade County DTPW to HubSpot with Ash Patel as owner and logs the brief.')).toBeInTheDocument();
  });

  it('assigns with the note: 202, the toast says it is sending, and the account leaves the queue view', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'asg_1', status: 'pending' }, { status: 202 });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    await within(dialog).findByRole('radio', { name: /^Ash Patel/ });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Note for Ash' }), 'Jarice knows you from APTA.');
    const go = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByText('Assigned to Ash Patel. Sending Miami-Dade County DTPW to HubSpot.')).toBeInTheDocument();
    expect(body).toEqual({ seller_user_id: 'usr_ash', notes: 'Jarice knows you from APTA.' });
    // The API still lists it until its read model catches up; the row leaves at once all the same.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Miami-Dade County DTPW', hidden: true })).toBeNull());
    // The peek moves on to the next account.
    expect(await screen.findByRole('dialog', { name: 'Coastline Credit Union' })).toBeInTheDocument();
    expect(screen.queryByText(/updates?$/)).toBeNull();
  });

  it('warns with the owner and the open deal when Scout can’t take over the HubSpot owner, and keeps the owner when assigning', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), stopPreview(OPEN_DEAL)),
      http.post(exactly('/api/v1/accounts/acc_mdc:assign'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'asg_1' }, { status: 202 });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    const warn = await within(dialog).findByText("Scout can't take over the HubSpot owner");
    expect(warn.closest('[role="alert"]')).toHaveTextContent(
      'Vijay Kumar owns an open deal on this company: Open Deal renewal, $50,000, last activity Oct 2. Scout will send the account and leave Vijay as owner. Ask Vijay to hand it over if Ash should lead.',
    );
    expect(dialog).toHaveTextContent('Scout sends Miami-Dade County DTPW to HubSpot and leaves Vijay Kumar as owner.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign to Ash Patel' }));
    await waitFor(() => expect(body).toEqual({ seller_user_id: 'usr_ash', ownership_decision: 'keep' }));
  });

  it.each([
    ['customer', 'Vijay Kumar owns this company and it is a customer in HubSpot. Scout will send the account and leave Vijay as owner. Ask Vijay to hand it over if Ash should lead.'],
    ['owned_elsewhere', 'Vijay Kumar owns this company in HubSpot. Scout will send the account and leave Vijay as owner. Ask Vijay to hand it over if Ash should lead.'],
  ])('words the %s warning', async (reason, text) => {
    serveQueue();
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), stopPreview({ ...OPEN_DEAL, reason, deal: null, message: 'Owned by Vijay Kumar: will not change owner' })));
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    const warn = await within(dialog).findByText("Scout can't take over the HubSpot owner");
    expect(warn.closest('[role="alert"]')).toHaveTextContent(text);
  });

  it('leaves out an open deal amount the API does not have, and formats one in the deal currency', async () => {
    serveQueue();
    let deal: Record<string, unknown> = { ...OPEN_DEAL.deal, amount_cents: null };
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () => HttpResponse.json({ preflight: { ...OPEN_DEAL, deal }, approves_to: null, replaces: null })));
    const first = renderApp('/t/taazaa/queue?peek=acc_mdc');
    let dialog = await openFromPeek();
    let warn = await within(dialog).findByText("Scout can't take over the HubSpot owner");
    expect(warn.closest('[role="alert"]')).toHaveTextContent('Vijay Kumar owns an open deal on this company: Open Deal renewal, last activity Oct 2. Scout will send');
    first.unmount();
    deal = { ...OPEN_DEAL.deal, amount_cents: 4_800_000, currency: 'EUR' };
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    dialog = await openFromPeek();
    warn = await within(dialog).findByText("Scout can't take over the HubSpot owner");
    expect(warn.closest('[role="alert"]')).toHaveTextContent('Open Deal renewal, €48,000, last activity Oct 2.');
  });

  it('is blocked when the preflight says the AE has no HubSpot owner', async () => {
    serveQueue();
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () =>
        HttpResponse.json({ preflight: { result: 'blocked', message: 'Ash has no HubSpot owner set.' }, approves_to: null, replaces: null }),
      ),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    expect(await within(dialog).findByText(/Ash Patel has no HubSpot user linked, so Scout can't make them the owner\./)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Assign to Ash Patel' })).toBeDisabled();
  });

  it('says HubSpot isn’t answering on a 503, and Try again checks again', async () => {
    serveQueue();
    let down = true;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () =>
        down
          ? problem(503, "HubSpot didn't answer. Try again in a minute.", { slug: 'crm_unavailable' })
          : HttpResponse.json({ preflight: { result: 'new', message: 'New in the CRM' }, approves_to: null, replaces: null }),
      ),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    const alert = await within(dialog).findByText(/HubSpot isn't answering, so Scout can't check who owns this company\./);
    expect(within(dialog).getByRole('button', { name: 'Assign to Ash Patel' })).toBeDisabled();
    down = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign to Ash Patel' })).toBeEnabled());
  });

  it('shows the API’s words when the assign is refused', async () => {
    serveQueue();
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:assign'), () => problem(409, 'Reopen it before assigning.')));
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    const go = await within(dialog).findByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await within(dialog).findByText('Reopen it before assigning.')).toBeInTheDocument();
  });

  it('bulk: one preview request for 5 accounts, and the warning lists each stopped account with its owner', async () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((x, i) => row({ account_id: `acc_${x.toLowerCase()}`, name: `Account ${x}`, priority: 90 - i }));
    serveQueue({ rows });
    const previews: unknown[] = [];
    let single = 0;
    server.use(
      http.post(/\/api\/v1\/accounts\/acc_\w+:assign-preview$/, () => {
        single++;
        return HttpResponse.json({ preflight: NEW_PREFLIGHT, approves_to: null, replaces: null });
      }),
      http.post('/api/v1/review-queue/assign-preview', async ({ request }) => {
        const body = (await request.json()) as { account_ids: string[] };
        previews.push(body);
        return HttpResponse.json({
          data: body.account_ids.map((id) =>
            id === 'acc_b'
              ? { account_id: id, ok: true, preflight: OPEN_DEAL, approves_to: null, replaces: null }
              : id === 'acc_d'
                ? { account_id: id, ok: true, preflight: { ...OPEN_DEAL, reason: 'customer', deal: null }, approves_to: null, replaces: null }
                : { account_id: id, ok: true, preflight: NEW_PREFLIGHT, approves_to: null, replaces: null },
          ),
        });
      }),
    );
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Account A' });
    for (const x of ['A', 'B', 'C', 'D', 'E']) await userEvent.click(screen.getByRole('checkbox', { name: `Select Account ${x}` }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Assign to an AE' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign 5 accounts' });
    const warn = (await within(dialog).findByText("Scout can't take over the HubSpot owner")).closest('[role="alert"]')!;
    expect(within(warn as HTMLElement).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Account B: Vijay Kumar, open deal Open Deal renewal, $50,000',
      'Account D: Vijay Kumar, a customer in HubSpot',
    ]);
    expect(previews).toEqual([{ account_ids: ['acc_a', 'acc_b', 'acc_c', 'acc_d', 'acc_e'], seller_user_id: 'usr_ash' }]);
    expect(single).toBe(0);
  });

  it('bulk assigns the selected accounts to one AE', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/review-queue/assign-preview', async ({ request }) => {
        const { account_ids } = (await request.json()) as { account_ids: string[] };
        return HttpResponse.json({ data: account_ids.map((id) => ({ account_id: id, ok: true, preflight: { ...NEW_PREFLIGHT, result: 'assign', message: 'ok' }, approves_to: null, replaces: null })) });
      }),
      http.post('/api/v1/review-queue/bulk', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ results: [{ account_id: 'acc_mdc', ok: true }, { account_id: 'acc_pgu', ok: true }] });
      }),
    );
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Miami-Dade County DTPW' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Pinegate University' }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Assign to an AE' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign 2 accounts' });
    expect(dialog).toHaveTextContent('Miami-Dade County DTPW, Pinegate University');
    await userEvent.click(await within(dialog).findByRole('radio', { name: /^Maya Chen/ }));
    const go = within(dialog).getByRole('button', { name: 'Assign to Maya Chen' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByText('Assigned 2 accounts to Maya Chen. Sending them to HubSpot.')).toBeInTheDocument();
    expect(body).toEqual({ account_ids: ['acc_mdc', 'acc_pgu'], action: 'assign', seller_user_id: 'usr_maya' });
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });
});
