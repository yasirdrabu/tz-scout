import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { serveQueue } from './testing';

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

  it('warns when Scout can’t take over the HubSpot owner, and keeps the owner when assigning', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () =>
        HttpResponse.json({ preflight: { result: 'stop', message: 'Open deal owned by Rita Gomez: will not change owner' }, approves_to: null, replaces: null }),
      ),
      http.post(exactly('/api/v1/accounts/acc_mdc:assign'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'asg_1' }, { status: 202 });
      }),
    );
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const dialog = await openFromPeek();
    const warn = await within(dialog).findByText("Scout can't take over the HubSpot owner");
    expect(warn.closest('[role="alert"]')).toHaveTextContent('Open deal owned by Rita Gomez: will not change owner');
    expect(dialog).toHaveTextContent('Scout sends Miami-Dade County DTPW to HubSpot and leaves the current HubSpot owner as owner.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign to Ash Patel' }));
    await waitFor(() => expect(body).toEqual({ seller_user_id: 'usr_ash', ownership_decision: 'keep' }));
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

  it('bulk assigns the selected accounts to one AE', async () => {
    serveQueue();
    let body: unknown = null;
    server.use(
      http.post(/\/api\/v1\/accounts\/acc_\w+:assign-preview$/, () => HttpResponse.json({ preflight: { result: 'assign', message: 'ok' }, approves_to: null, replaces: null })),
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
