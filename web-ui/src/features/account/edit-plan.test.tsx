import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Plan, PlanStep } from './api';
import { ASSIGNED, PLAN, serveAccount } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';
const ACCEPTED = { ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, status: 'accepted', responded_at: '2026-10-27T09:00:00Z' } };
const VIEWER = ['accounts:read', 'playbooks:read'];

const fieldProblem = (path: string, message: string) =>
  HttpResponse.json(
    { type: 'https://scout.taazaa.ai/problems/validation', title: 'Check the form.', status: 400, correlation_id: 'cor_t', errors: [{ path, message }] },
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  );

const step = (id: string, order: number, day: number, title: string, extra: Partial<PlanStep> = {}): PlanStep => ({
  ...PLAN.steps[3]!,
  id,
  order,
  day,
  title,
  channel: 'task',
  status: 'todo',
  ...extra,
});

async function openDrawer() {
  await screen.findByRole('button', { name: 'Edit plan' });
  const c = within(screen.getByRole('region', { name: 'Playbook' }));
  await userEvent.click(c.getByRole('button', { name: 'Edit plan' }));
  return { card: c, drawer: within(await screen.findByRole('dialog', { name: 'Edit plan' })) };
}

/** Answers the write endpoints with `next`, recording what was sent. */
function serveWrites(next: () => Plan | Response) {
  const seen: { post: unknown[]; patch: unknown[]; delete: string[] } = { post: [], patch: [], delete: [] };
  const answer = (r: Plan | Response) => (r instanceof Response ? r : HttpResponse.json(r));
  server.use(
    http.post('/api/v1/plans/pln_1/steps', async ({ request }) => {
      seen.post.push(await request.json());
      return answer(next());
    }),
    http.patch('/api/v1/plans/pln_1/steps/:id', async ({ request }) => {
      seen.patch.push(await request.json());
      return answer(next());
    }),
    http.delete('/api/v1/plans/pln_1/steps/:id', ({ params }) => {
      seen.delete.push(String(params.id));
      return answer(next());
    }),
  );
  return seen;
}

describe('Edit plan', () => {
  it('is for people who can write, on an open plan', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN, scopes: VIEWER });
    renderApp(URL);
    const c = within(await screen.findByRole('region', { name: 'Playbook' }));
    await c.findByText('Intro email');
    expect(c.queryByRole('button', { name: 'Edit plan' })).not.toBeInTheDocument();
  });

  it('is not offered once the plan has ended', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, status: 'completed' } });
    renderApp(URL);
    const c = within(await screen.findByRole('region', { name: 'Playbook' }));
    await c.findByText('Intro email');
    expect(c.queryByRole('button', { name: 'Edit plan' })).not.toBeInTheDocument();
  });

  it('lists the steps in order and will not remove a done one', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const { drawer } = await openDrawer();
    const titles = drawer.getAllByRole('listitem').map((li) => within(li).getAllByRole('button')[0]!.getAttribute('aria-label'));
    expect(titles).toEqual(['Edit Intro email', 'Edit Connect on LinkedIn', 'Edit Follow-up email', 'Edit Call the sponsor', 'Edit Send the case study']);
    expect(drawer.getByText('Day 3 · Email · Ash Patel · To do')).toBeInTheDocument();
    expect(drawer.getByRole('button', { name: 'Remove Intro email' })).toBeDisabled();
    expect(drawer.getAllByText('Skip it instead.')).toHaveLength(1);
    expect(drawer.getByRole('button', { name: 'Remove Call the sponsor' })).toBeEnabled();
  });

  it('adds a step, refreshes the card and focuses the new row', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    const added = step('stp_new', 4, 4, 'Extra touch', { channel: 'email', owner_role: 'leader' });
    const seen = serveWrites(() => ({ ...PLAN, steps: [...PLAN.steps.slice(0, 3), added, ...PLAN.steps.slice(3).map((s) => ({ ...s, order: s.order + 1 }))] }));
    renderApp(URL);
    const { card, drawer } = await openDrawer();
    const form = within(drawer.getByRole('form', { name: 'Add step' }));
    await userEvent.clear(form.getByLabelText('Day'));
    await userEvent.type(form.getByLabelText('Day'), '4');
    await userEvent.selectOptions(form.getByLabelText('Done by'), 'leader');
    await userEvent.type(form.getByLabelText('Title'), 'Extra touch');
    await userEvent.type(form.getByLabelText('Subject'), 'Hello');
    await userEvent.click(form.getByRole('checkbox', { name: 'Technical buyer' }));
    await userEvent.click(form.getByRole('button', { name: 'Add step' }));
    expect(await screen.findByText('Step added.')).toBeInTheDocument();
    expect(seen.post).toEqual([
      { day: 4, channel: 'email', owner_role: 'leader', title: 'Extra touch', detail: null, subject: 'Hello', body: null, target_buying_roles: ['technical_buyer'], crm_task: true },
    ]);
    expect(await card.findByText('Extra touch')).toBeInTheDocument();
    await waitFor(() => expect(drawer.getByText('Extra touch').closest('li')).toHaveFocus());
    expect(within(drawer.getByRole('form', { name: 'Add step' })).getByLabelText('Title')).toHaveValue('');
  });

  it('edits a step and sends only what changed', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    const seen = serveWrites(() => ({ ...PLAN, customised: true, steps: PLAN.steps.map((s) => (s.id === 'stp_4' ? { ...s, title: 'Call the sponsor now', origin: 'edited' as const } : s)) }));
    renderApp(URL);
    const { card, drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Edit Call the sponsor' }));
    const form = within(drawer.getByRole('form', { name: 'Edit Call the sponsor' }));
    expect(form.getByLabelText('Day')).toHaveValue(5);
    expect(form.queryByLabelText('Subject')).not.toBeInTheDocument();
    await userEvent.type(form.getByLabelText('Title'), ' now');
    await userEvent.click(form.getByRole('button', { name: 'Save step' }));
    expect(await screen.findByText('Step saved.')).toBeInTheDocument();
    expect(seen.patch).toEqual([{ title: 'Call the sponsor now' }]);
    expect(await card.findByText('Call the sponsor now')).toBeInTheDocument();
    await waitFor(() => expect(drawer.getByRole('button', { name: 'Edit Call the sponsor now' })).toHaveFocus());
  });

  it('shows email fields, the held archived role, and sends role changes', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, steps: PLAN.steps.map((s) => (s.id === 'stp_3' ? { ...s, target_buying_roles: ['technical_buyer', 'retired_role'] } : s)) } });
    const seen = serveWrites(() => PLAN);
    renderApp(URL);
    const { drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Edit Follow-up email' }));
    const form = within(drawer.getByRole('form', { name: 'Edit Follow-up email' }));
    expect(form.getByLabelText('Subject')).toHaveValue('Following up on the RFP');
    expect(form.getByLabelText('Body')).toHaveValue('Hi {person.first_name},\n\nA short note on the RFP.');
    expect(form.getByRole('checkbox', { name: 'retired_role (archived)' })).toBeChecked();
    expect(form.getByRole('checkbox', { name: 'HubSpot task' })).not.toBeChecked();
    await userEvent.click(form.getByRole('checkbox', { name: 'retired_role (archived)' }));
    await userEvent.click(form.getByRole('button', { name: 'Save step' }));
    await waitFor(() => expect(seen.patch).toEqual([{ target_buying_roles: ['technical_buyer'] }]));
  });

  it('sends nothing when nothing changed', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    const seen = serveWrites(() => PLAN);
    renderApp(URL);
    const { drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Edit Call the sponsor' }));
    await userEvent.click(drawer.getByRole('button', { name: 'Save step' }));
    await waitFor(() => expect(drawer.queryByRole('form', { name: 'Edit Call the sponsor' })).not.toBeInTheDocument());
    expect(seen.patch).toEqual([]);
  });

  it('removes a step and focuses the next row', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    const seen = serveWrites(() => ({ ...PLAN, steps: PLAN.steps.filter((s) => s.id !== 'stp_4') }));
    renderApp(URL);
    const { card, drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Remove Call the sponsor' }));
    expect(await screen.findByText('Step removed.')).toBeInTheDocument();
    expect(seen.delete).toEqual(['stp_4']);
    await waitFor(() => expect(card.queryByText('Call the sponsor')).not.toBeInTheDocument());
    await waitFor(() => expect(drawer.getByRole('button', { name: 'Edit Send the case study' })).toHaveFocus());
  });

  it('focuses Add step after removing the last row', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    serveWrites(() => ({ ...PLAN, steps: PLAN.steps.filter((s) => s.id !== 'stp_5') }));
    renderApp(URL);
    const { drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Remove Send the case study' }));
    await waitFor(() => expect(within(drawer.getByRole('form', { name: 'Add step' })).getByRole('button', { name: 'Add step' })).toHaveFocus());
  });

  it('puts the API field errors on the fields', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    serveWrites(() => fieldProblem('owner_user_id', 'Pick someone from this workspace.'));
    server.use(http.post('/api/v1/plans/pln_1/steps', () => fieldProblem('target_buying_roles', 'Unknown buying role: x'), { once: true }));
    renderApp(URL);
    const { drawer } = await openDrawer();
    const form = within(drawer.getByRole('form', { name: 'Add step' }));
    await userEvent.click(form.getByRole('button', { name: 'Add step' }));
    expect(await form.findByText('Give the step a title.')).toBeInTheDocument();
    await userEvent.type(form.getByLabelText('Title'), 'Something');
    await userEvent.click(form.getByRole('button', { name: 'Add step' }));
    expect(await form.findByText('Unknown buying role: x')).toBeInTheDocument();
    expect(screen.queryByText('Step added.')).not.toBeInTheDocument();
    await userEvent.clear(form.getByLabelText('Day'));
    await userEvent.type(form.getByLabelText('Day'), '400');
    await userEvent.click(form.getByRole('button', { name: 'Add step' }));
    expect(await form.findByText('Use a day from 0 to 365.')).toBeInTheDocument();
  });

  it('maps an edit title error from the API onto the title', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    serveWrites(() => fieldProblem('title', 'Give the step a title.'));
    renderApp(URL);
    const { drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Edit Call the sponsor' }));
    const form = within(drawer.getByRole('form', { name: 'Edit Call the sponsor' }));
    await userEvent.type(form.getByLabelText('Title'), '!');
    await userEvent.click(form.getByRole('button', { name: 'Save step' }));
    expect(await form.findByText('Give the step a title.')).toBeInTheDocument();
    expect(form.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a 409 as a toast', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    serveWrites(() => problem(409, 'This plan has ended.'));
    renderApp(URL);
    const { drawer } = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: 'Remove Call the sponsor' }));
    expect(await screen.findByText('This plan has ended.')).toBeInTheDocument();
    expect(drawer.getByRole('button', { name: 'Edit Call the sponsor' })).toBeInTheDocument();
  });
});
