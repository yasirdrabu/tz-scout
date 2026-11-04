import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { NEW_PREFLIGHT, row, servePlaybookChoice, serveQueue, WITH_PLAYBOOKS } from './testing';

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

  /** Five queue rows, all selected, with the bulk Assign dialog open; `preview` answers each account. */
  async function bulkOf(preview: (id: string) => Record<string, unknown>) {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((x, i) => row({ account_id: `acc_${x.toLowerCase()}`, name: `Account ${x}`, priority: 90 - i }));
    serveQueue({ rows });
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/v1/review-queue/assign-preview', async ({ request }) => {
        const { account_ids } = (await request.json()) as { account_ids: string[] };
        return HttpResponse.json({ data: account_ids.map((id) => ({ account_id: id, ...preview(id) })) });
      }),
      http.post('/api/v1/review-queue/bulk', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ results: (body.account_ids as string[]).map((id) => ({ account_id: id, ok: true })) });
      }),
    );
    renderApp('/t/taazaa/queue');
    await screen.findByRole('button', { name: 'Account A' });
    for (const x of ['A', 'B', 'C', 'D', 'E']) await userEvent.click(screen.getByRole('checkbox', { name: `Select Account ${x}` }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Assign to an AE' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign 5 accounts' });
    await within(dialog).findByRole('radio', { name: /^Ash Patel/ });
    return { dialog, body: () => body };
  }
  const ok = (preflight: Record<string, unknown>) => ({ ok: true, preflight, approves_to: null, replaces: null });

  it('bulk: keeps the HubSpot owner only for the stopped accounts, and the footer says what each group does', async () => {
    const { dialog, body } = await bulkOf((id) => ok(id === 'acc_b' || id === 'acc_d' ? OPEN_DEAL : NEW_PREFLIGHT));
    expect(await within(dialog).findByText('3 accounts move to Ash Patel; 2 keep their HubSpot owner.')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByText('Assigned 5 accounts to Ash Patel. Sending them to HubSpot.')).toBeInTheDocument();
    expect(body()).toEqual({
      account_ids: ['acc_a', 'acc_b', 'acc_c', 'acc_d', 'acc_e'],
      action: 'assign',
      seller_user_id: 'usr_ash',
      ownership_decisions: { acc_b: 'keep', acc_d: 'keep' },
    });
  });

  it('bulk: an account the preview refused is listed with its reason and left out; the rest are assigned', async () => {
    const { dialog, body } = await bulkOf((id) =>
      id === 'acc_c' ? { ok: false, status: 404, message: 'Not found or outside your data.' } : id === 'acc_e' ? { ok: false, status: 503, message: "HubSpot didn't answer. Try again in a minute." } : ok(NEW_PREFLIGHT),
    );
    const refused = await within(dialog).findByText(/Scout could not check 2 accounts, so they are left out:/);
    expect(refused.closest('[role="alert"]')).toHaveTextContent("Account C: Not found or outside your data.Account E: HubSpot didn't answer. Try again in a minute.");
    expect(dialog).toHaveTextContent('Scout sends 3 accounts to HubSpot with Ash Patel as owner and logs the brief.');
    const go = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByText('Assigned 3 accounts to Ash Patel. 2 could not be assigned.')).toBeInTheDocument();
    expect(body()).toEqual({ account_ids: ['acc_a', 'acc_b', 'acc_d'], action: 'assign', seller_user_id: 'usr_ash' });
    // The refused ones stay selected and are listed with the API's words.
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('2 selected');
    expect(screen.getByRole('alert')).toHaveTextContent('Account C: Not found or outside your data.');
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

  describe('playbook choice', () => {
    const assignBody = () => {
      const seen: { body: unknown } = { body: undefined };
      server.use(
        http.post(exactly('/api/v1/accounts/acc_mdc:assign'), async ({ request }) => {
          seen.body = await request.json();
          return HttpResponse.json({ id: 'asg_1', status: 'pending' }, { status: 202 });
        }),
      );
      return seen;
    };
    const go = async (dialog: HTMLElement) => {
      const button = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await screen.findByText('Assigned to Ash Patel. Sending Miami-Dade County DTPW to HubSpot.');
    };

    it('lists the active playbooks and No playbook, preselects the suggestion, and sends nothing when it is kept', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice('plb_rfp');
      const seen = assignBody();
      renderApp('/t/taazaa/queue?peek=acc_mdc');
      const dialog = await openFromPeek();
      const cards = await within(dialog).findByRole('group', { name: 'Playbook' });
      const rfp = within(cards).getByRole('radio', { name: /^Public sector RFP/ });
      expect(rfp).toBeChecked();
      expect(rfp.closest('label')).toHaveTextContent('Recommended for this account');
      expect(rfp.closest('label')).toHaveTextContent('3 steps over 14 days');
      expect(rfp.closest('label')).toHaveTextContent('For agencies with an open notice.');
      expect(within(cards).getByRole('radio', { name: /^Warm intro/ })).not.toBeChecked();
      expect(within(cards).getByRole('radio', { name: /^No playbook/ })).not.toBeChecked();
      // Draft and retired playbooks are not offered.
      expect(within(cards).getAllByRole('radio')).toHaveLength(3);
      expect(await within(dialog).findByText('Scout sends Miami-Dade County DTPW to HubSpot with Ash Patel as owner and logs the brief and starts Public sector RFP when Ash accepts.')).toBeInTheDocument();
      await go(dialog);
      expect(seen.body).toEqual({ seller_user_id: 'usr_ash' });
    });

    it('sends the playbook id when another one is picked, and the footer follows', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice('plb_rfp');
      const seen = assignBody();
      renderApp('/t/taazaa/queue?peek=acc_mdc');
      const dialog = await openFromPeek();
      await userEvent.click(await within(dialog).findByRole('radio', { name: /^Warm intro/ }));
      expect(await within(dialog).findByText(/and logs the brief and starts Warm intro when Ash accepts\.$/)).toBeInTheDocument();
      await go(dialog);
      expect(seen.body).toEqual({ seller_user_id: 'usr_ash', playbook_id: 'plb_warm' });
    });

    it('No playbook sends null and adds nothing to the footer', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice('plb_rfp');
      const seen = assignBody();
      renderApp('/t/taazaa/queue?peek=acc_mdc');
      const dialog = await openFromPeek();
      await userEvent.click(await within(dialog).findByRole('radio', { name: /^No playbook/ }));
      expect(await within(dialog).findByText('Scout sends Miami-Dade County DTPW to HubSpot with Ash Patel as owner and logs the brief.')).toBeInTheDocument();
      await go(dialog);
      expect(seen.body).toEqual({ seller_user_id: 'usr_ash', playbook_id: null });
    });

    it('with no suggestion, No playbook is preselected and tagged, and sending nothing keeps the default', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice(null);
      const seen = assignBody();
      renderApp('/t/taazaa/queue?peek=acc_mdc');
      const dialog = await openFromPeek();
      const none = await within(dialog).findByRole('radio', { name: /^No playbook/ });
      expect(none).toBeChecked();
      expect(none.closest('label')).toHaveTextContent('Recommended for this account');
      await go(dialog);
      expect(seen.body).toEqual({ seller_user_id: 'usr_ash' });
    });

    it('without playbooks:read the section is hidden and nothing is sent', async () => {
      serveQueue();
      servePlaybookChoice('plb_rfp');
      const seen = assignBody();
      renderApp('/t/taazaa/queue?peek=acc_mdc');
      const dialog = await openFromPeek();
      await within(dialog).findByRole('radio', { name: /^Ash Patel/ });
      expect(within(dialog).queryByRole('group', { name: 'Playbook' })).toBeNull();
      await go(dialog);
      expect(seen.body).toEqual({ seller_user_id: 'usr_ash' });
    });

    it('bulk: the first card is Recommended for each account and sends no playbook_id', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice();
      let body: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/review-queue/assign-preview', async ({ request }) => {
          const { account_ids } = (await request.json()) as { account_ids: string[] };
          return HttpResponse.json({ data: account_ids.map((id) => ({ account_id: id, ok: true, preflight: NEW_PREFLIGHT, approves_to: null, replaces: null })) });
        }),
        http.post('/api/v1/review-queue/bulk', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ results: (body.account_ids as string[]).map((id) => ({ account_id: id, ok: true })) });
        }),
      );
      renderApp('/t/taazaa/queue');
      await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select Miami-Dade County DTPW' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select Pinegate University' }));
      await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Assign to an AE' }));
      const dialog = await screen.findByRole('dialog', { name: 'Assign 2 accounts' });
      const cards = await within(dialog).findByRole('group', { name: 'Playbook' });
      expect(within(cards).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual([
        expect.stringMatching(/^Recommended for each account/),
        expect.stringMatching(/^Public sector RFP/),
        expect.stringMatching(/^Warm intro/),
        expect.stringMatching(/^No playbook/),
      ]);
      expect(within(cards).getByRole('radio', { name: /^Recommended for each account/ })).toBeChecked();
      expect(await within(dialog).findByText(/and starts each account's recommended playbook when Ash accepts\.$/)).toBeInTheDocument();
      const button = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await screen.findByText('Assigned 2 accounts to Ash Patel. Sending them to HubSpot.');
      expect(body).toEqual({ account_ids: ['acc_mdc', 'acc_pgu'], action: 'assign', seller_user_id: 'usr_ash' });
    });

    it('bulk: one playbook for every account is sent as playbook_id', async () => {
      serveQueue({ scopes: WITH_PLAYBOOKS });
      servePlaybookChoice();
      let body: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/review-queue/assign-preview', async ({ request }) => {
          const { account_ids } = (await request.json()) as { account_ids: string[] };
          return HttpResponse.json({ data: account_ids.map((id) => ({ account_id: id, ok: true, preflight: NEW_PREFLIGHT, approves_to: null, replaces: null })) });
        }),
        http.post('/api/v1/review-queue/bulk', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ results: (body.account_ids as string[]).map((id) => ({ account_id: id, ok: true })) });
        }),
      );
      renderApp('/t/taazaa/queue');
      await screen.findByRole('button', { name: 'Miami-Dade County DTPW' });
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select Miami-Dade County DTPW' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select Pinegate University' }));
      await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Assign to an AE' }));
      const dialog = await screen.findByRole('dialog', { name: 'Assign 2 accounts' });
      await userEvent.click(await within(dialog).findByRole('radio', { name: /^Warm intro/ }));
      const button = within(dialog).getByRole('button', { name: 'Assign to Ash Patel' });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await screen.findByText('Assigned 2 accounts to Ash Patel. Sending them to HubSpot.');
      expect(body).toEqual({ account_ids: ['acc_mdc', 'acc_pgu'], action: 'assign', seller_user_id: 'usr_ash', playbook_id: 'plb_warm' });
    });
  });
});
