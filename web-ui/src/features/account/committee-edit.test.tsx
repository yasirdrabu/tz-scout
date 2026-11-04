import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { ACCOUNT_DANA, SELLER, serveAccount } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';
const rail = async () => within(await screen.findByRole('complementary', { name: 'Account details' }));

/** Answers the PATCH, keeps what was sent, and counts reads of the account and the committee. */
function servePatch(respond?: () => Response) {
  const sent: unknown[] = [];
  const reads = { account: 0, committee: 0 };
  server.use(
    http.get('/api/v1/accounts/acc_mdc', () => {
      reads.account += 1;
      return HttpResponse.json(ACCOUNT_DANA);
    }),
    http.get('/api/v1/accounts/acc_mdc/committee', () => {
      reads.committee += 1;
      return HttpResponse.json({ offer: null, roles: [], summary: { covered: 1, required: 3, text: '1 of 3 roles covered' }, gaps: [] });
    }),
    http.patch('/api/v1/people/per_dana', async ({ request }) => {
      sent.push(await request.json());
      return respond ? respond() : HttpResponse.json(ACCOUNT_DANA.people[0]);
    }),
  );
  return { sent, reads };
}

beforeEach(() => localStorage.clear());

describe('Editing the buying committee', () => {
  it('shows a guessed role with its chip, and the note with who and when', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Guessed from title')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Confirm Technical buyer for Dana Ortiz' })).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Remove Technical buyer from Dana Ortiz' })).toBeInTheDocument();
    expect(r.getByText('Wants a pilot first · Zach Lee, Nov 3')).toBeInTheDocument();
  });

  it('Confirm sends only the key, then refetches', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    const { sent, reads } = servePatch();
    renderApp(URL);
    const r = await rail();
    const button = await r.findByRole('button', { name: 'Confirm Technical buyer for Dana Ortiz' });
    await waitFor(() => expect(reads.committee).toBeGreaterThan(0));
    const before = { ...reads };
    await userEvent.click(button);
    expect(await screen.findByText('Technical buyer confirmed for Dana Ortiz.')).toBeInTheDocument();
    expect(sent).toEqual([{ confirm_role_keys: ['technical_buyer'] }]);
    await waitFor(() => {
      expect(reads.account).toBeGreaterThan(before.account);
      expect(reads.committee).toBeGreaterThan(before.committee);
    });
  });

  it('Remove sends the roles without it', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    const { sent } = servePatch();
    renderApp(URL);
    await userEvent.click(await (await rail()).findByRole('button', { name: 'Remove Technical buyer from Dana Ortiz' }));
    expect(await screen.findByText('Technical buyer removed from Dana Ortiz.')).toBeInTheDocument();
    expect(sent).toEqual([{ role_keys: ['business_owner'] }]);
  });

  it('Edit changes roles and the note, and sends both without confirming', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    const { sent } = servePatch();
    renderApp(URL);
    await userEvent.click(await (await rail()).findByRole('button', { name: 'Edit Dana Ortiz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Dana Ortiz' });
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).toBeChecked();
    expect(within(dialog).getByText('Where they stand. Up to 1,000 characters.')).toBeInTheDocument();
    await userEvent.click(within(roles).getByRole('checkbox', { name: 'Business owner' }));
    const note = within(dialog).getByRole('textbox', { name: 'Decision note' });
    await userEvent.clear(note);
    await userEvent.type(note, 'Ready to buy');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Dana Ortiz.')).toBeInTheDocument();
    expect(sent).toEqual([{ role_keys: ['technical_buyer'], decision_note: 'Ready to buy' }]);
  });

  it('clearing the note sends an empty string', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    const { sent } = servePatch();
    renderApp(URL);
    await userEvent.click(await (await rail()).findByRole('button', { name: 'Edit Dana Ortiz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Dana Ortiz' });
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Decision note' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Dana Ortiz.');
    expect(sent).toEqual([{ decision_note: '' }]);
  });

  it('shows the message from the API on the note field', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    servePatch(() =>
      HttpResponse.json(
        { type: 'https://scout.taazaa.ai/problems/validation', title: 'Check the request.', status: 400, errors: [{ path: 'decision_note', message: 'Keep the note under 1,000 characters.' }] },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    renderApp(URL);
    await userEvent.click(await (await rail()).findByRole('button', { name: 'Edit Dana Ortiz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Dana Ortiz' });
    await userEvent.click(within(dialog).getByRole('textbox', { name: 'Decision note' }));
    await userEvent.paste('x'.repeat(1001));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const note = within(dialog).getByRole('textbox', { name: 'Decision note' });
    await waitFor(() => expect(note).toHaveAccessibleDescription(/Keep the note under 1,000 characters\./));
    await userEvent.type(note, 'y');
    expect(within(dialog).queryByText('Keep the note under 1,000 characters.')).toBeNull();
  });

  it('Save in the Edit dialog refetches the account and the committee', async () => {
    serveAccount({ account: ACCOUNT_DANA });
    const { reads } = servePatch();
    renderApp(URL);
    await userEvent.click(await (await rail()).findByRole('button', { name: 'Edit Dana Ortiz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Dana Ortiz' });
    await waitFor(() => expect(reads.committee).toBeGreaterThan(0));
    const before = { ...reads };
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Decision note' }), '!');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Dana Ortiz.');
    await waitFor(() => {
      expect(reads.account).toBeGreaterThan(before.account);
      expect(reads.committee).toBeGreaterThan(before.committee);
    });
  });

  it('without people:write there is no Confirm, Remove or Edit', async () => {
    serveAccount({ account: ACCOUNT_DANA, scopes: SELLER.filter((s) => s !== 'people:write') });
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Guessed from title')).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /^Confirm / })).toBeNull();
    expect(r.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(r.queryByRole('button', { name: /^Edit / })).toBeNull();
  });
});
