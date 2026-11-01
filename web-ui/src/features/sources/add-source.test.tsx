import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { CSV, detail, RFP, serveSources, source } from './testing';

beforeEach(() => localStorage.clear());

async function openWizard() {
  const user = userEvent.setup();
  const app = renderApp('/t/taazaa/sources');
  await user.click(await screen.findByRole('button', { name: 'Add a source' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a source' });
  return { user, app, dialog };
}

describe('Add a source (§12)', () => {
  it('shows the kinds, without CRM when the workspace has its HubSpot source', async () => {
    serveSources();
    const { dialog } = await openWizard();
    expect(dialog).toHaveTextContent('Pick what kind of source this is. You can change the details later.');
    expect(within(dialog).getByRole('radio', { name: /Agent/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /List or research sheet/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /CRM/ })).toBeNull();
  });

  it('shows the CRM card when can_add_crm is true', async () => {
    serveSources({ meta: { can_add_crm: true } });
    const { dialog } = await openWizard();
    expect(within(dialog).getByRole('radio', { name: /CRM/ })).toBeInTheDocument();
  });

  it('an agent needs a person over it', async () => {
    serveSources();
    const { user, dialog } = await openWizard();
    await user.click(within(dialog).getByRole('radio', { name: /Agent/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Add an agent' });
    await user.type(within(step).getByRole('textbox', { name: 'Name' }), 'Hospital Expansion Watch');
    await user.click(within(step).getByRole('button', { name: 'Add source' }));
    expect(await within(step).findByText('An agent needs an owner. Pick the person who runs it.')).toBeInTheDocument();
  });

  it("shows the API's duplicate name error under Name", async () => {
    serveSources();
    server.use(
      http.post('/api/v1/sources', () =>
        HttpResponse.json(
          { type: 'x/conflict', title: 'A source called Apollo already exists. Pick another name.', status: 409, errors: [{ path: 'name', message: 'A source called Apollo already exists. Pick another name.' }] },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const { user, dialog } = await openWizard();
    await user.click(within(dialog).getByRole('radio', { name: /Data vendor/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Add a data vendor' });
    await user.type(within(step).getByRole('textbox', { name: 'Name' }), 'Apollo');
    await user.click(within(step).getByRole('button', { name: 'Add source' }));
    const name = within(step).getByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(within(step).getByText('A source called Apollo already exists. Pick another name.')).toBeInTheDocument();
  });

  it('an API agent gets its key once with a sample request', async () => {
    serveSources();
    let body: Record<string, unknown> = {};
    server.use(
      http.post('/api/v1/sources', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        const added = detail(source({ ...RFP, id: 'src_new', name: 'Hospital Expansion Watch' }));
        return HttpResponse.json({ ...added, api_key: { id: 'key_new', prefix: 'scout_live_NeWk1234', secret: 'scout_live_NeWk1234secretsecretsecretsecret', environment: 'live', created_at: '2026-11-01T00:00:00Z' } }, { status: 201 });
      }),
    );
    const { user, dialog } = await openWizard();
    await user.click(within(dialog).getByRole('radio', { name: /Agent/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Add an agent' });
    await user.type(within(step).getByRole('textbox', { name: 'Name' }), 'Hospital Expansion Watch');
    await user.selectOptions(within(step).getByRole('combobox', { name: 'Under' }), 'src_marcus');
    expect(within(step).getByRole('combobox', { name: 'Owner' })).toHaveValue('usr_marcus');
    expect(step).toHaveTextContent('Shows under Marcus Lee');
    expect(step).toHaveTextContent('Scout creates a key for this source.');
    await user.click(within(step).getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('Added Hospital Expansion Watch.')).toBeInTheDocument();
    expect(body).toEqual({ kind: 'agent', name: 'Hospital Expansion Watch', parent_id: 'src_marcus', owner_user_id: 'usr_marcus', create_key: true });
    const done = await screen.findByRole('dialog', { name: 'Source added' });
    expect(within(done).getByLabelText('New API key')).toHaveTextContent('scout_live_NeWk1234secretsecretsecretsecret');
    expect(done).toHaveTextContent("Copy this now. You won't see it again.");
    expect(done).toHaveTextContent(`curl -X POST ${location.origin}/api/v1/arrivals`);
    expect(done).toHaveTextContent('Authorization: Bearer scout_live_NeWk1234secretsecretsecretsecret');
  });

  it('a list leads to Upload the first list', async () => {
    serveSources();
    server.use(http.post('/api/v1/sources', () => HttpResponse.json(detail(source({ ...CSV, id: 'src_conf', name: 'Conference list' })), { status: 201 })));
    const { user, dialog, app } = await openWizard();
    await user.click(within(dialog).getByRole('radio', { name: /List or research sheet/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Add a list or research sheet' });
    await user.type(within(step).getByRole('textbox', { name: 'Name' }), 'Conference list');
    await user.click(within(step).getByRole('button', { name: 'Add source' }));
    expect(await within(step).findByText('A list needs an owner. Pick the person who uploads it.')).toBeInTheDocument();
    await user.selectOptions(within(step).getByRole('combobox', { name: 'Under' }), 'src_marcus');
    await user.click(within(step).getByRole('button', { name: 'Add source' }));
    const done = await screen.findByRole('dialog', { name: 'Source added' });
    await user.click(within(done).getByRole('link', { name: 'Upload the first list' }));
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/batches/import?source=src_conf'));
  });

  it('goes back to the kinds with Back', async () => {
    serveSources();
    server.use(http.post('/api/v1/sources', () => problem(500, 'Something went wrong')));
    const { user, dialog } = await openWizard();
    await user.click(within(dialog).getByRole('radio', { name: /Partner/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Add a partner' });
    expect(step).toHaveTextContent('Not enough data yet');
    await user.click(within(step).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Add a source' })).toBeInTheDocument();
  });
});
