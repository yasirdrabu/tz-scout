import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { REQUESTER, serveEnrichment } from '../enrichment/testing';
import type { Plan } from './api';
import { ASSIGNED, PAGE_LEADER, PLAN, serveAccount } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';
const ACCEPTED = { ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, status: 'accepted', responded_at: '2026-10-27T09:00:00Z' } };
const VIEWER = ['accounts:read', 'playbooks:read'];

const card = async () => within(await screen.findByRole('region', { name: 'Playbook' }));
const row = (c: ReturnType<typeof within>, title: string) => c.getByRole('button', { name: title }).closest('li')!;

beforeEach(() => localStorage.clear());

describe('The plan card', () => {
  it('shows the header, the bar, the rows and their pills', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    expect(await c.findByText('Public sector RFP · Day 4 of 11')).toBeInTheDocument();
    expect(c.getByText('2 of 5 done')).toBeInTheDocument();
    expect(c.getByRole('progressbar', { name: 'Plan progress' })).toHaveAttribute('aria-valuenow', '2');
    expect(c.getByText('Day 1')).toBeInTheDocument();
    expect(within(row(c, 'Intro email')).getByText('Done')).toBeInTheDocument();
    expect(within(row(c, 'Connect on LinkedIn')).getByText('In progress')).toBeInTheDocument();
    expect(within(row(c, 'Follow-up email')).getByText('Due Nov 4')).toBeInTheDocument();
    expect(within(row(c, 'Call the sponsor')).getByText('Not started')).toBeInTheDocument();
    expect(within(row(c, 'Send the case study')).getByText('Skipped')).toBeInTheDocument();
    expect(row(c, 'Follow-up email').className).toMatch(/planRowDue/);
    expect(row(c, 'Intro email').className).not.toMatch(/planRowDue/);
    // The owner's name, or the role word when nobody owns it.
    expect(within(row(c, 'Intro email')).getByText('Ash Patel')).toBeInTheDocument();
    expect(within(row(c, 'Call the sponsor')).getByText('Leader')).toBeInTheDocument();
  });

  it('is the first card in the main column', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await screen.findByRole('region', { name: 'Playbook' });
    expect(c.parentElement!.firstElementChild).toBe(c);
  });

  it('ticking a step marks it done, and unticking returns it to todo', async () => {
    const { sent } = serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('checkbox', { name: 'Mark Call the sponsor done' }));
    expect(await screen.findByText('Step updated.')).toBeInTheDocument();
    await userEvent.click(await c.findByRole('checkbox', { name: 'Mark Call the sponsor not done' }));
    await waitFor(() => expect(c.getByRole('checkbox', { name: 'Mark Call the sponsor done' })).not.toBeChecked());
    expect(sent['/api/v1/plans/pln_1/steps/stp_4']).toEqual([{ status: 'done' }, { status: 'todo' }]);
    expect(c.getByText('2 of 5 done')).toBeInTheDocument();
  });

  it('opens a step in place and saves its note, owner, due date and status', async () => {
    const { sent } = serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    const title = await c.findByRole('button', { name: 'Call the sponsor' });
    expect(title).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    const save = c.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(c.getByLabelText('Note'), 'Left a voicemail');
    await userEvent.selectOptions(await c.findByRole('option', { name: 'Ash Patel' }).then(() => c.getByLabelText('Owner')), 'usr_ash');
    fireEvent.change(c.getByLabelText('Due date'), { target: { value: '2026-11-12' } });
    await userEvent.selectOptions(c.getByLabelText('Status'), 'in_progress');
    await userEvent.click(save);
    expect(await screen.findByText('Step updated.')).toBeInTheDocument();
    expect(sent['/api/v1/plans/pln_1/steps/stp_4']).toEqual([{ note: 'Left a voicemail', owner_user_id: 'usr_ash', due_date: '2026-11-12', status: 'in_progress' }]);
    await waitFor(() => expect(row(c, 'Call the sponsor').querySelector('[class*=planPill]')).toHaveTextContent('In progress'));
    expect(row(c, 'Call the sponsor').querySelector('[class*=planDetail]')).toHaveTextContent('Ash Patel');
  });

  it('shows the API field errors on the fields', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    server.use(
      http.patch('/api/v1/plans/pln_1/steps/stp_4', () =>
        HttpResponse.json(
          { type: 'x/validation', title: 'Check the form.', status: 400, errors: [{ path: 'due_date', message: 'Use a date like 2026-12-31.' }] },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Call the sponsor' }));
    await userEvent.type(c.getByLabelText('Note'), 'x');
    await userEvent.click(c.getByRole('button', { name: 'Save' }));
    expect(await c.findByText('Use a date like 2026-12-31.')).toBeInTheDocument();
  });

  it('shows the email draft with Copy, the people, and Find for a missing role', async () => {
    const user = userEvent.setup();
    serveAccount({ review: ACCEPTED, plan: PLAN, scopes: [...PAGE_LEADER, ...REQUESTER] });
    serveEnrichment();
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Follow-up email' }));
    expect(c.getByText('Mention the December RFP.')).toBeInTheDocument();
    expect(c.getByText('Following up on the RFP')).toBeInTheDocument();
    expect(c.getByText(/A short note on the RFP/)).toBeInTheDocument();
    expect(c.getByText('To: Jarice Rodriguez')).toBeInTheDocument();
    await user.click(c.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Draft copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('Subject: Following up on the RFP\n\nHi {person.first_name},\n\nA short note on the RFP.');

    expect(c.getByText('No technical buyer on file')).toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Find technical buyer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).not.toBeChecked();
  });

  it('no Find without enrichment:request', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Follow-up email' }));
    expect(c.getByText('No technical buyer on file')).toBeInTheDocument();
    expect(c.queryByRole('button', { name: /^Find/ })).toBeNull();
  });

  it('a viewer sees it read only: no checkbox, menu or fields', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN, scopes: VIEWER });
    renderApp(URL);
    const c = await card();
    await c.findByRole('button', { name: 'Follow-up email' });
    expect(c.queryByRole('checkbox')).toBeNull();
    expect(c.queryByRole('button', { name: 'Plan actions' })).toBeNull();
    await userEvent.click(c.getByRole('button', { name: 'Follow-up email' }));
    expect(c.queryByLabelText('Note')).toBeNull();
    expect(c.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(c.getByText(/Status: To do/)).toBeInTheDocument();
  });

  it('shows nothing when the account has no plan', async () => {
    serveAccount({ review: ACCEPTED, plan: null });
    renderApp(URL);
    await screen.findByRole('region', { name: 'Outcomes' });
    await waitFor(() => expect(screen.queryByText('Loading the plan')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Playbook' })).toBeNull();
  });

  it('shows the API words when the plan does not load', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    server.use(http.get('/api/v1/accounts/acc_mdc/plan', () => problem(500, 'Down for a minute.')));
    renderApp(URL);
    expect(await (await card()).findByRole('alert')).toHaveTextContent("The plan didn't load.");
  });

  it('says a newer version exists', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, newer_version: true } });
    renderApp(URL);
    expect(await (await card()).findByText('A newer version of Public sector RFP exists. This plan keeps the steps it started with.')).toBeInTheDocument();
  });

  it('lists the history, newest first, after opening it', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    const toggle = await c.findByRole('button', { name: 'History (2)' });
    expect(c.queryByText(/created the plan/)).toBeNull();
    await userEvent.click(toggle);
    const items = c.getAllByRole('listitem').filter((li) => /the plan|status/.test(li.textContent ?? ''));
    expect(items[0]).toHaveTextContent("Ash Patel changed a step's status · Nov 2, 10:00 AM");
    expect(items[1]).toHaveTextContent('Scout created the plan · Nov 2, 5:00 AM');
    expect(items).toHaveLength(2);
  });
});

describe('Plan actions', () => {
  it('pauses, then offers Resume', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Plan actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    expect(await screen.findByText('Plan paused.')).toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Plan actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resume' }));
    expect(await screen.findByText('Plan resumed.')).toBeInTheDocument();
  });

  it('completes, and closes the plan with its status line and read-only rows', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, history: [...PLAN.history, { id: 'his_3', kind: 'completed', step_id: null, detail: null, by: 'usr_ash', by_name: 'Ash Patel', at: '2026-11-04T12:00:00Z' }] } });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Plan actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Complete' }));
    expect(await screen.findByText('Plan completed.')).toBeInTheDocument();
    expect(await c.findByText('Completed Nov 4, 2026')).toBeInTheDocument();
    expect(c.queryByRole('button', { name: 'Plan actions' })).toBeNull();
    expect(c.queryByRole('checkbox')).toBeNull();
  });

  it("shows the API's words when open steps stop it completing", async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    server.use(http.post(/\/api\/v1\/plans\/pln_1:complete$/, () => problem(409, 'Finish or skip the open steps first.')));
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Plan actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Complete' }));
    expect(await screen.findByText('Finish or skip the open steps first.')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
  });

  it('abandon asks why, shows the API words when it is missing, then sends the reason', async () => {
    const { sent } = serveAccount({ review: ACCEPTED, plan: PLAN });
    let first = true;
    server.use(
      http.post(/\/api\/v1\/plans\/pln_1:abandon$/, async ({ request }) => {
        if (first) {
          first = false;
          return problem(400, "Say why you're abandoning it.");
        }
        sent.abandon = [await request.json()];
        return HttpResponse.json({ ...PLAN, status: 'abandoned', status_reason: 'Lost the champion' } satisfies Plan);
      }),
    );
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Plan actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Abandon' }));
    const dialog = await screen.findByRole('dialog', { name: 'Abandon this plan?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abandon plan' }));
    expect(await within(dialog).findByText("Say why you're abandoning it.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Why are you abandoning it?'), 'Lost the champion');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abandon plan' }));
    expect(await screen.findByText('Plan abandoned.')).toBeInTheDocument();
    expect(sent.abandon).toEqual([{ reason: 'Lost the champion' }]);
    expect(await c.findByText('Abandoned: Lost the champion')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a stopped plan says why', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, status: 'stopped', status_reason: 'They replied' } });
    renderApp(URL);
    const c = await card();
    expect(await c.findByText('Stopped: They replied')).toBeInTheDocument();
    expect(c.queryByRole('button', { name: 'Plan actions' })).toBeNull();
  });
});

describe('Assigned, not yet accepted', () => {
  const pending = (extra: object) => ({ ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, ...extra } });

  it('says when the playbook starts', async () => {
    serveAccount({ review: pending({ playbook_name: 'Public sector RFP' }) });
    renderApp(URL);
    expect(await (await card()).findByText('Public sector RFP starts when Ash accepts.')).toBeInTheDocument();
  });

  it('says there is no playbook', async () => {
    serveAccount({ review: pending({ no_playbook: true }) });
    renderApp(URL);
    expect(await (await card()).findByText('No playbook. Ash works it with no set steps.')).toBeInTheDocument();
  });

  it('shows no card when the API names no playbook', async () => {
    serveAccount({ review: pending({}) });
    renderApp(URL);
    await screen.findByRole('region', { name: 'Outcomes' });
    expect(screen.queryByRole('region', { name: 'Playbook' })).toBeNull();
  });
});

describe('Plan step details stay in sync', () => {
  it('ticking the row updates the open form and leaves Save disabled', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Call the sponsor' }));
    await userEvent.click(c.getByRole('checkbox', { name: 'Mark Call the sponsor done' }));
    await waitFor(() => expect(c.getByLabelText('Status')).toHaveValue('done'));
    expect(c.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('caps the day at the last day', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, day: 40 } });
    renderApp(URL);
    expect(await (await card()).findByText('Public sector RFP · Day 11 of 11')).toBeInTheDocument();
  });

  it('a failed tick reverts the checkbox and shows the error', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    server.use(http.patch('/api/v1/plans/pln_1/steps/stp_4', () => problem(409, 'This plan has ended.')));
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('checkbox', { name: 'Mark Call the sponsor done' }));
    expect(await screen.findByText('This plan has ended.')).toBeInTheDocument();
    expect(c.getByRole('checkbox', { name: 'Mark Call the sponsor done' })).not.toBeChecked();
  });
});
