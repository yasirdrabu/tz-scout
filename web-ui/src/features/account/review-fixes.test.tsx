import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { RFP_STEPS, rfp, servePlaybooks } from '../playbooks/testing';
import { ASSIGNED, PAGE_LEADER, PLAN, serveAccount } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';
const ACCEPTED = { ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, status: 'accepted', responded_at: '2026-10-27T09:00:00Z' } };
const pending = (extra: object) => ({ ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, ...extra } });
const card = async () => within(await screen.findByRole('region', { name: 'Playbook' }));
const suggest = () =>
  server.use(
    http.get('/api/v1/accounts/acc_mdc/playbook-suggestion', () =>
      HttpResponse.json({ playbook: { id: 'plb_rfp', name: 'Public sector RFP', steps: 3, days: 14 }, reason: 'offer_tier', offer: null, tier: null }),
    ),
  );

describe('Day numbers are 1-based wherever a person sees one', () => {
  it('the same step reads the same Day n on the card and in the Edit plan drawer', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    // "Call the sponsor" is stored as day 5.
    const onCard = within((await c.findByRole('button', { name: 'Call the sponsor' })).closest('li')!).getByText(/^Day \d+$/).textContent;
    await userEvent.click(c.getByRole('button', { name: 'Edit plan' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Edit plan' }));
    const inDrawer = /^(Day \d+) · /.exec(drawer.getByRole('button', { name: 'Edit Call the sponsor' }).closest('li')!.querySelector('p')!.textContent!)![1];
    expect(onCard).toBe("Day 6");
    expect(inDrawer).toBe(onCard);
  });

  it('Add step starts on the plan current day, shown 1-based', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN });
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Edit plan' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Edit plan' }));
    // PLAN is on day 3 (0-based), which the header shows as Day 4.
    expect(within(drawer.getByRole('form', { name: 'Add step' })).getByLabelText('Day')).toHaveValue(4);
  });
});

describe('A plan that is open already', () => {
  it('PendingPlan says it resumes', async () => {
    serveAccount({ review: pending({ playbook_name: 'Public sector RFP', plan_resumes: true }) });
    renderApp(URL);
    expect(await (await card()).findByText('Public sector RFP resumes when Ash accepts.')).toBeInTheDocument();
  });

  it.each(['paused', 'active'] as const)('hides the playbook preview when the plan is %s', async (status) => {
    servePlaybooks({ playbooks: [rfp()], steps: { plb_rfp: RFP_STEPS } });
    let asked = false;
    serveAccount({ plan: { ...PLAN, status } });
    server.use(
      http.get('/api/v1/accounts/acc_mdc/plan', () => {
        asked = true;
        return HttpResponse.json({ ...PLAN, status });
      }),
    );
    suggest();
    renderApp(URL);
    await screen.findByRole('region', { name: 'Brief' });
    await waitFor(() => expect(asked).toBe(true));
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole('region', { name: 'Playbook' })).not.toBeInTheDocument();
  });

  it('shows the preview when the account has no plan (404)', async () => {
    servePlaybooks({ playbooks: [rfp()], steps: { plb_rfp: RFP_STEPS } });
    serveAccount();
    suggest();
    renderApp(URL);
    expect(await screen.findByRole('region', { name: 'Playbook' })).toBeInTheDocument();
  });
});

describe('The plan card', () => {
  it('a paused plan says Paused and the menu offers Resume', async () => {
    serveAccount({ review: ACCEPTED, plan: { ...PLAN, status: 'paused' } });
    renderApp(URL);
    const c = await card();
    expect(await c.findByText('Paused')).toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Plan actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Resume' })).toBeInTheDocument();
  });

  it('a plan write refreshes the nav counts', async () => {
    let counts = 0;
    serveAccount({ review: ACCEPTED, plan: PLAN });
    server.use(
      http.get('/api/v1/me/counts', () => {
        counts += 1;
        return HttpResponse.json({ review_queue: null, new_assignments: null });
      }),
    );
    renderApp(URL);
    const c = await card();
    await waitFor(() => expect(counts).toBeGreaterThan(0));
    const before = counts;
    await userEvent.click(await c.findByRole('checkbox', { name: 'Mark Call the sponsor done' }));
    expect(await screen.findByText('Step updated.')).toBeInTheDocument();
    await waitFor(() => expect(counts).toBeGreaterThan(before));
  });

  it('keeps asking every 2 seconds for a plan that is still starting after an accept', async () => {
    let asked = 0;
    serveAccount({ review: ACCEPTED });
    server.use(http.get('/api/v1/accounts/acc_mdc/plan', () => (++asked < 2 ? problem(404, 'That account has no plan.') : HttpResponse.json(PLAN))));
    renderApp(URL);
    expect(await screen.findByText('Public sector RFP · Day 4 of 11', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(asked).toBe(2);
  }, 10_000);

  it('does not poll a 404 when the assignment is not accepted', async () => {
    let asked = 0;
    serveAccount({ review: { ...ACCEPTED, current_assignment: { ...ACCEPTED.current_assignment!, status: 'declined' } } });
    server.use(
      http.get('/api/v1/accounts/acc_mdc/plan', () => {
        asked += 1;
        return problem(404, 'That account has no plan.');
      }),
    );
    renderApp(URL);
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 2500));
    expect(asked).toBe(1);
  }, 10_000);

  it('keeps an acronym role label as written: No CIO on file', async () => {
    serveAccount({ review: ACCEPTED, plan: PLAN, scopes: [...PAGE_LEADER, 'enrichment:request'] });
    server.use(http.get('/api/v1/buying-roles', () => HttpResponse.json({ data: [{ key: 'technical_buyer', label: 'CIO' }] })));
    renderApp(URL);
    const c = await card();
    await userEvent.click(await c.findByRole('button', { name: 'Follow-up email' }));
    expect(await c.findByText('No CIO on file')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Find CIO' })).toBeInTheDocument();
  });
});
