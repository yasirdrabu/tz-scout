import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { draftPlaybook, rfp, RFP_STEPS, SELLER, servePlaybooks } from './testing';

const bodies = (seen: ReturnType<typeof servePlaybooks>, method: string, end: string) =>
  seen.filter((r) => r.method === method && r.url.pathname.endsWith(end)).map((r) => r.body as Record<string, unknown>);
const step = (n: number) => screen.getByRole('group', { name: `Step ${n}` });

const STEP_KEYS = ['body', 'channel', 'crm_task', 'day', 'detail', 'order', 'owner_role', 'subject', 'target_buying_roles', 'title'];

describe('Playbook form (§20)', () => {
  it('New playbook shows every field and asks for a name and a step', async () => {
    servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks?edit=new');
    const d = await screen.findByRole('dialog', { name: 'New playbook' });
    for (const l of ['Name', 'Status', 'When to use it', 'Description', 'Stop when']) expect(within(d).getByLabelText(l)).toBeInTheDocument();
    expect(within(d).getByRole('option', { name: 'Retired' })).toBeInTheDocument();
    for (const o of ['They reply or book a meeting', 'They book a meeting', 'Run every step']) expect(within(d).getByRole('option', { name: o })).toBeInTheDocument();
    expect(within(d).getByText('Day counts from when the AE accepts the account. Day 1 is the accept day.')).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Create playbook' }));
    expect(await within(d).findByText('Give the playbook a name.')).toBeInTheDocument();
    expect(within(d).getByText('Add at least one step.')).toBeInTheDocument();
  });

  it('adds, edits, moves and removes steps; email steps show subject and body; roles are checkboxes', async () => {
    servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks?edit=new');
    const d = await screen.findByRole('dialog', { name: 'New playbook' });
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    await user.type(within(step(1)).getByLabelText('Title'), 'First');
    await user.type(within(step(2)).getByLabelText('Title'), 'Second');
    expect(within(step(1)).getByLabelText('Subject')).toBeInTheDocument();
    expect(within(step(1)).getByLabelText('Body')).toBeInTheDocument();
    await user.selectOptions(within(step(1)).getByLabelText('Channel'), 'call');
    expect(within(step(1)).queryByLabelText('Subject')).toBeNull();
    for (const c of ['Email', 'LinkedIn', 'Call', 'Meeting', 'Task']) expect(within(step(2)).getByRole('option', { name: c })).toBeInTheDocument();
    for (const o of ['Seller', 'Leader', 'Operator']) expect(within(step(2)).getByRole('option', { name: o })).toBeInTheDocument();
    expect(await within(step(1)).findByRole('checkbox', { name: 'Procurement' })).not.toBeChecked();
    expect(within(step(1)).getByRole('checkbox', { name: 'CRM task' })).toBeChecked();
    await user.click(within(step(2)).getByRole('button', { name: 'Move step 2 up' }));
    expect(within(step(1)).getByLabelText('Title')).toHaveValue('Second');
    expect(within(step(2)).getByLabelText('Title')).toHaveValue('First');
    expect(within(step(1)).getByRole('button', { name: 'Move step 1 up' })).toBeDisabled();
    await user.click(within(step(1)).getByRole('button', { name: 'Remove step 1' }));
    expect(screen.queryByRole('group', { name: 'Step 2' })).toBeNull();
    expect(within(step(1)).getByLabelText('Title')).toHaveValue('First');
  });

  it('creates a playbook: POST with ordered steps, the toast, and opens it', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/playbooks?edit=new');
    const d = await screen.findByRole('dialog', { name: 'New playbook' });
    await user.type(within(d).getByLabelText('Name'), 'Fresh start');
    await user.selectOptions(within(d).getByLabelText('Status'), 'active');
    await user.selectOptions(within(d).getByLabelText('Stop when'), 'meeting');
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    await user.type(within(step(1)).getByLabelText('Title'), 'Open');
    await user.type(within(step(1)).getByLabelText('Subject'), 'Hello');
    await user.click(await within(step(1)).findByRole('checkbox', { name: 'Procurement' }));
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    expect(within(step(2)).getByLabelText('Day')).toHaveValue(1);
    await user.clear(within(step(2)).getByLabelText('Day'));
    await user.type(within(step(2)).getByLabelText('Day'), '5');
    await user.selectOptions(within(step(2)).getByLabelText('Channel'), 'task');
    await user.type(within(step(2)).getByLabelText('Title'), 'Do it');
    await user.click(within(d).getByRole('button', { name: 'Create playbook' }));
    expect(await screen.findByText('Fresh start created.')).toBeInTheDocument();
    const [body] = bodies(seen, 'POST', '/playbooks') as { steps: Record<string, unknown>[] }[];
    expect(body).toMatchObject({ name: 'Fresh start', status: 'active', stop_when: 'meeting', description: null, when_to_use: null });
    expect(body!.steps).toHaveLength(2);
    expect(body!.steps[0]).toMatchObject({ order: 1, day: 0, channel: 'email', owner_role: 'seller', title: 'Open', subject: 'Hello', body: null, target_buying_roles: ['procurement'] });
    expect(body!.steps[1]).toMatchObject({ order: 2, day: 4, channel: 'task', subject: null, body: null });
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/playbooks/plb_new'));
  });

  it('Edit playbook fills the form and sends only the allowed step fields', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/playbooks/plb_rfp?edit=playbook');
    const d = await screen.findByRole('dialog', { name: 'Edit Public sector RFP' });
    await waitFor(() => expect(within(d).getByLabelText('Name')).toHaveValue('Public sector RFP'));
    expect(within(d).getByLabelText('Status')).toHaveValue('active');
    expect(within(step(1)).getByLabelText('Subject')).toHaveValue('Hello');
    expect(within(step(3)).getByLabelText('Done by')).toHaveValue('leader');
    await user.type(within(d).getByLabelText('When to use it'), 'Open notice');
    await user.click(within(step(3)).getByRole('button', { name: 'Move step 3 up' }));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes to Public sector RFP saved.')).toBeInTheDocument();
    const [body] = bodies(seen, 'PATCH', '/playbooks/plb_rfp') as { steps: Record<string, unknown>[] }[];
    expect(body).toMatchObject({ when_to_use: 'Open notice' });
    expect(body!.steps.map((s) => s.title)).toEqual(['Send the opening email', 'Call the sponsor', 'Connect on LinkedIn']);
    for (const [i, s] of body!.steps.entries()) {
      expect(Object.keys(s).sort()).toEqual(STEP_KEYS);
      expect(s.order).toBe(i + 1);
    }
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/playbooks/plb_rfp'));
    expect(screen.queryByRole('dialog', { name: /Edit/ })).toBeNull();
  });

  it('shows API field errors at the step field they name', async () => {
    servePlaybooks({
      answer: {
        'PATCH plb_rfp': () =>
          HttpResponse.json(
            {
              type: 'https://scout.taazaa.ai/problems/validation',
              title: 'Check the form',
              status: 400,
              errors: [
                { path: 'steps.2.title', message: 'Give the step a title.' },
                { path: 'name', message: 'That name is taken.' },
              ],
            },
            { status: 400, headers: { 'content-type': 'application/problem+json' } },
          ),
      },
    });
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp?edit=playbook');
    const d = await screen.findByRole('dialog', { name: 'Edit Public sector RFP' });
    await waitFor(() => expect(within(d).getByLabelText('Name')).toHaveValue('Public sector RFP'));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(step(3)).findByText('Give the step a title.')).toBeInTheDocument();
    expect(within(step(1)).queryByText('Give the step a title.')).toBeNull();
    expect(within(d).getByText('That name is taken.')).toBeInTheDocument();
  });
});

describe('Playbook form: day and archived roles', () => {
  it('blocks save on an empty or out-of-range day', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp?edit=playbook');
    const d = await screen.findByRole('dialog', { name: 'Edit Public sector RFP' });
    await waitFor(() => expect(within(d).getByLabelText('Name')).toHaveValue('Public sector RFP'));
    await user.clear(within(step(2)).getByLabelText('Day'));
    await user.clear(within(step(3)).getByLabelText('Day'));
    await user.type(within(step(3)).getByLabelText('Day'), '400');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(step(2)).findByText('Use a day from 1 to 366.')).toBeInTheDocument();
    expect(within(step(3)).getByText('Use a day from 1 to 366.')).toBeInTheDocument();
    expect(within(step(1)).queryByText('Use a day from 1 to 366.')).toBeNull();
    expect(bodies(seen, 'PATCH', '/playbooks/plb_rfp')).toHaveLength(0);
  });

  it('shows an archived role as a checked box that can be unticked', async () => {
    const seen = servePlaybooks({ steps: { plb_rfp: RFP_STEPS.map((s, i) => (i === 0 ? { ...s, target_buying_roles: ['old_role'] } : s)) } });
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp?edit=playbook');
    const d = await screen.findByRole('dialog', { name: 'Edit Public sector RFP' });
    const box = await within(step(1)).findByRole('checkbox', { name: 'old_role (archived)' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Public sector RFP saved.');
    const [body] = bodies(seen, 'PATCH', '/playbooks/plb_rfp') as { steps: { target_buying_roles: string[] }[] }[];
    expect(body!.steps[0]!.target_buying_roles).toEqual([]);
  });
});

describe('Assign playbook (§20)', () => {
  it('lists active offers as "offer · practice" and the tier notes', async () => {
    servePlaybooks({ playbooks: [rfp({ runs_on: [{ offer_id: 'off_mb', tier: 'act_now' }] }), draftPlaybook({ status: 'active', id: 'plb_other', name: 'Other', runs_on: [{ offer_id: 'off_mb', tier: 'watch' }] })] });
    renderApp('/t/taazaa/playbooks/plb_rfp?assign=offer');
    const d = await screen.findByRole('dialog', { name: 'Assign Public sector RFP' });
    expect(d).toHaveTextContent('Accounts matched to this offer and tier will start this playbook when an AE accepts them.');
    const select = within(d).getByLabelText('Offer');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Modernization Blueprint · AI Transformation', 'Data Readiness Assessment · Data Readiness']);
    const act = await within(d).findByRole('checkbox', { name: /Act now/ });
    expect(act).toBeChecked();
    expect(act.closest('label')).toHaveTextContent('Already uses this playbook');
    expect(within(d).getByRole('checkbox', { name: /Good fit/ }).closest('label')).toHaveTextContent('No playbook now');
    expect(within(d).getByRole('checkbox', { name: /Watch/ }).closest('label')).toHaveTextContent('Replaces Other');
  });

  it('PUTs each changed tier and toasts', async () => {
    const seen = servePlaybooks({ playbooks: [rfp({ runs_on: [{ offer_id: 'off_mb', tier: 'act_now' }] }), draftPlaybook({ status: 'active', id: 'plb_other', name: 'Other', runs_on: [{ offer_id: 'off_mb', tier: 'watch' }] })] });
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/playbooks/plb_rfp?assign=offer');
    const d = await screen.findByRole('dialog', { name: 'Assign Public sector RFP' });
    await user.click(await within(d).findByRole('checkbox', { name: /Good fit/ }));
    await user.click(within(d).getByRole('checkbox', { name: /Watch/ }));
    await user.click(within(d).getByRole('checkbox', { name: /Act now/ }));
    await user.click(within(d).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Public sector RFP now runs on Modernization Blueprint · AI Transformation · Good fit, Watch. Removed from Act now.')).toBeInTheDocument();
    const puts = seen.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => [r.url.pathname.split('/').pop(), r.body])).toEqual([
      ['good_fit', { playbook_id: 'plb_rfp' }],
      ['watch', { playbook_id: 'plb_rfp' }],
      ['act_now', { playbook_id: null }],
    ]);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/playbooks/plb_rfp'));
  });

  it('shows Assign only for an active playbook, and only to a manager', async () => {
    servePlaybooks();
    const { unmount } = renderApp('/t/taazaa/playbooks/plb_draft');
    await screen.findByRole('heading', { name: 'Warm intro', level: 1 });
    expect(screen.queryByRole('link', { name: 'Assign' })).toBeNull();
    unmount();
    servePlaybooks({ scopes: SELLER });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 });
    expect(screen.queryByRole('link', { name: 'Assign' })).toBeNull();
  });

  it('Assign opens the dialog from the Runs on card', async () => {
    servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await user.click(await screen.findByRole('link', { name: 'Assign' }));
    expect(await screen.findByRole('dialog', { name: 'Assign Public sector RFP' })).toBeInTheDocument();
  });

  it('removes a tier from the Runs on row with a toast', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await user.click(await screen.findByRole('button', { name: 'Remove from Modernization Blueprint Act now' }));
    expect(await screen.findByText('Public sector RFP removed from Modernization Blueprint · Act now.')).toBeInTheDocument();
    const [put] = seen.filter((r) => r.method === 'PUT');
    expect(put!.url.pathname).toBe('/api/v1/offers/off_mb/playbooks/act_now');
    expect(put!.body).toEqual({ playbook_id: null });
    expect(await screen.findByText(/Not assigned to any offer yet/)).toBeInTheDocument();
  });
});

describe('Retired playbook', () => {
  it('offers neither Delete nor Retire nor Assign', async () => {
    servePlaybooks({ playbooks: [draftPlaybook({ status: 'archived' })] });
    renderApp('/t/taazaa/playbooks/plb_draft');
    await screen.findByRole('heading', { name: 'Warm intro', level: 1 });
    for (const name of ['Delete', 'Retire']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Assign' })).toBeNull();
  });
});

describe('Playbook form focus and errors', () => {
  it('moves focus on Add step, Remove and Move', async () => {
    servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks?edit=new');
    const d = await screen.findByRole('dialog', { name: 'New playbook' });
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    expect(within(step(1)).getByLabelText('Title')).toHaveFocus();
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    await user.click(within(d).getByRole('button', { name: 'Add step' }));
    expect(within(step(3)).getByLabelText('Title')).toHaveFocus();
    await user.click(within(step(2)).getByRole('button', { name: 'Move step 2 up' }));
    expect(screen.getByRole('button', { name: 'Move step 1 down' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(screen.getByRole('button', { name: 'Move step 2 down' })).toHaveFocus();
    await user.click(within(step(2)).getByRole('button', { name: 'Move step 2 down' }));
    expect(screen.getByRole('button', { name: 'Move step 3 up' })).toHaveFocus();
    await user.click(within(step(1)).getByRole('button', { name: 'Remove step 1' }));
    expect(screen.getByRole('button', { name: 'Remove step 1' })).toHaveFocus();
    await user.click(within(step(2)).getByRole('button', { name: 'Remove step 2' }));
    expect(screen.getByRole('button', { name: 'Remove step 1' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove step 1' }));
    expect(within(d).getByRole('button', { name: 'Add step' })).toHaveFocus();
  });

  it('shows the notice for an error on a field the form does not draw, and clears a field error on edit', async () => {
    servePlaybooks({
      answer: {
        'PATCH plb_rfp': () =>
          HttpResponse.json(
            {
              type: 'https://scout.taazaa.ai/problems/validation',
              title: 'Check the form',
              status: 400,
              errors: [
                { path: 'steps.1.order', message: 'Order is off.' },
                { path: 'name', message: 'That name is taken.' },
              ],
            },
            { status: 400, headers: { 'content-type': 'application/problem+json' } },
          ),
      },
    });
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp?edit=playbook');
    const d = await screen.findByRole('dialog', { name: 'Edit Public sector RFP' });
    await waitFor(() => expect(within(d).getByLabelText('Name')).toHaveValue('Public sector RFP'));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('Check the form');
    expect(within(d).getByText('That name is taken.')).toBeInTheDocument();
    await user.type(within(d).getByLabelText('Name'), 'x');
    expect(within(d).queryByText('That name is taken.')).toBeNull();
  });
});
