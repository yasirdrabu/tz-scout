import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Conflict } from './api';
import { CONFLICT, CONTRACT_FACT, FACTS, SELLER, serveAccount } from './testing';

const PAGE = '/t/taazaa/accounts/acc_mdc';
const FACTS_WITH_CONTRACT = [...FACTS, CONTRACT_FACT];
const factsCard = () => screen.findByRole('region', { name: 'Account facts' });
const checklist = () => screen.findByRole('region', { name: 'Before you approve' });
const KEEP = /^Keep .* from /;

beforeEach(() => localStorage.clear());

describe('Conflicting facts on the account page', () => {
  it('shows both values side by side with source and date, a badge, and the checklist line', async () => {
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT] });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText('1 conflict to resolve')).toBeInTheDocument();
    expect(facts).toHaveTextContent('Sources disagree');
    expect(facts).toHaveTextContent('$20,900,000GovSpend · Oct 1, 2026');
    expect(facts).toHaveTextContent('$18,400,000RFP Watch · Oct 10, 2026');
    // Each button reads "Keep this one" and tells a screen reader which value it keeps.
    expect(within(facts).getAllByRole('button', { name: KEEP }).map((b) => [b.textContent, b.getAttribute('aria-label')])).toEqual([
      ['Keep this one', 'Keep $20,900,000 from GovSpend'],
      ['Keep this one', 'Keep $18,400,000 from RFP Watch'],
    ]);
    // Other facts still read as before; the money fact is not shown twice.
    expect(facts).toHaveTextContent('Staff3,800GovSpend · Sep 1, 2026');
    expect(within(facts).getAllByText('Contract value')).toHaveLength(1);

    const before = await checklist();
    expect(await within(before).findByText('Resolve 1 conflicting fact: Contract value.')).toBeInTheDocument();
    expect(before).toHaveTextContent('Warm intro available through Ash Patel.');
    await userEvent.click(within(before).getByRole('button', { name: 'Resolve' }));
    expect(document.activeElement).toHaveAttribute('id', 'conflict-cfl_1');
    expect(document.activeElement).toHaveTextContent('Contract valueSources disagree');
  });

  it('counts several open conflicts, and leaves person conflicts out', async () => {
    const employees: Conflict = { ...CONFLICT, id: 'cfl_2', key: 'employees', label: 'Staff', facts: CONFLICT.facts.map((f, i) => ({ ...f, id: `fct_e${i}`, value: 3000 + i * 1000 })) };
    const email: Conflict = { ...CONFLICT, id: 'cfl_3', key: 'email', label: 'Email', person_id: 'per_jr' };
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT, employees, email] });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText('2 conflicts to resolve')).toBeInTheDocument();
    expect(await within(await checklist()).findByText('Resolve 2 conflicting facts.')).toBeInTheDocument();
  });

  it('keeps a value: posts it, toasts, then shows who kept it with the other dimmed', async () => {
    const { sent } = serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT] });
    const app = renderApp(PAGE);
    const invalidate = vi.spyOn(app.queryClient, 'invalidateQueries');
    const facts = await factsCard();
    const keep = await within(facts).findAllByRole('button', { name: KEEP });
    await userEvent.click(keep[1]!);

    expect(await screen.findByText('Kept $18,400,000 from RFP Watch. Scout will use it in the brief and HubSpot.')).toBeInTheDocument();
    expect(sent['/api/v1/conflicts/cfl_1:resolve']).toEqual([{ kept_fact_id: 'fct_cv2' }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'taazaa', 'acc_mdc'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['review-queue', 'taazaa'] });

    expect(await within(facts).findByText(/^Kept by Zach Wiant/)).toHaveTextContent('Kept by Zach Wiant · Change');
    expect(within(facts).getByText('All facts agree')).toBeInTheDocument();
    expect(within(facts).queryByRole('button', { name: KEEP })).toBeNull();
    // The kept value says so to a screen reader; the other is only dimmed.
    expect(within(facts).getAllByText('(kept)')).toHaveLength(1);
    expect(within(facts).getByText('(kept)').parentElement).toHaveTextContent('$18,400,000 (kept)');
    expect(document.activeElement).toHaveAttribute('id', 'conflict-cfl_1');
    expect(await within(await checklist()).findByText('Facts agree. Contract value set to $18,400,000.')).toBeInTheDocument();
  });

  it('Change reopens the choice, and keeping the other value posts again', async () => {
    const kept: Conflict = { ...CONFLICT, status: 'resolved', resolution: 'kept', kept_fact_id: 'fct_cv1', resolved_by_name: 'Dana Whitfield', resolved_at: '2026-11-01T12:00:00Z' };
    const { sent } = serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [kept] });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText(/^Kept by Dana Whitfield/)).toHaveTextContent('Kept by Dana Whitfield · Change');
    // Cancel returns to the kept value, with focus back on Change.
    await userEvent.click(within(facts).getByRole('button', { name: 'Change' }));
    expect(document.activeElement).toHaveAccessibleName('Keep $18,400,000 from RFP Watch');
    await userEvent.click(within(facts).getByRole('button', { name: 'Cancel' }));
    expect(within(facts).queryByRole('button', { name: KEEP })).toBeNull();
    expect(document.activeElement).toHaveAccessibleName('Change');

    await userEvent.click(within(facts).getByRole('button', { name: 'Change' }));
    const keep = within(facts).getAllByRole('button', { name: KEEP });
    expect(keep).toHaveLength(1);
    await userEvent.click(keep[0]!);
    expect(await screen.findByText('Kept $18,400,000 from RFP Watch. Scout will use it in the brief and HubSpot.')).toBeInTheDocument();
    expect(sent['/api/v1/conflicts/cfl_1:resolve']).toEqual([{ kept_fact_id: 'fct_cv2' }]);
    expect(await within(facts).findByText(/^Kept by Zach Wiant/)).toHaveTextContent('Kept by Zach Wiant · Change');
  });

  it('on a 409 shows the API title and reloads the conflicts', async () => {
    let gets = 0;
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT] });
    server.use(
      http.get('/api/v1/accounts/acc_mdc/conflicts', () => {
        gets += 1;
        return Response.json({ data: [CONFLICT], next_cursor: null });
      }),
      http.post(/\/api\/v1\/conflicts\/[^/]+:resolve$/, () => problem(409, 'That value was replaced. Pick again from the latest values.', { slug: 'conflict' })),
    );
    const app = renderApp(PAGE);
    const invalidate = vi.spyOn(app.queryClient, 'invalidateQueries');
    const facts = await factsCard();
    const keep = await within(facts).findAllByRole('button', { name: KEEP });
    const before = gets;
    await userEvent.click(keep[0]!);
    expect(await screen.findByText('That value was replaced. Pick again from the latest values.')).toBeInTheDocument();
    await waitFor(() => expect(gets).toBeGreaterThan(before));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'taazaa', 'acc_mdc'] });
  });

  it('a later edit hides an older Kept by for the same fact', async () => {
    const older: Conflict = { ...CONFLICT, id: 'cfl_0', status: 'resolved', resolution: 'kept', kept_fact_id: 'fct_cv2', resolved_by_name: 'Dana Whitfield', resolved_at: '2026-10-20T12:00:00Z' };
    const edited: Conflict = { ...CONFLICT, status: 'resolved', resolution: 'edited', kept_fact_id: 'fct_cv1', resolved_by_name: 'Zach Wiant', resolved_at: '2026-11-01T12:00:00Z' };
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [edited, older] });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText('All facts agree')).toBeInTheDocument();
    expect(facts).toHaveTextContent('Contract value$20,900,000GovSpend · Oct 1, 2026');
    expect(facts).not.toHaveTextContent('Kept by');
    expect(facts).not.toHaveTextContent('$18,400,000');
  });

  it('says when the conflicts did not load, and still shows the facts', async () => {
    serveAccount({ facts: FACTS_WITH_CONTRACT });
    server.use(http.get('/api/v1/accounts/acc_mdc/conflicts', () => problem(500, 'Scout had a problem.')));
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText("Conflicts didn't load. Scout had a problem.")).toBeInTheDocument();
    expect(facts).toHaveTextContent('Staff3,800');
  });

  it('shows the values read-only to someone who cannot review', async () => {
    serveAccount({ scopes: SELLER, facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT] });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText('Sources disagree')).toBeInTheDocument();
    expect(facts).toHaveTextContent('$18,400,000');
    expect(within(facts).queryByRole('button', { name: KEEP })).toBeNull();
  });

  it('says All facts agree with none', async () => {
    serveAccount({ facts: FACTS_WITH_CONTRACT });
    renderApp(PAGE);
    const facts = await factsCard();
    expect(await within(facts).findByText('All facts agree')).toBeInTheDocument();
    expect(facts).not.toHaveTextContent('Sources disagree');
    expect(within(await checklist()).queryByText(/conflicting|Facts agree/)).toBeNull();
  });

  it('shows an explanation only when there is one', async () => {
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [CONFLICT] });
    renderApp(PAGE);
    expect(await within(await factsCard()).findByText('Sources disagree')).toBeInTheDocument();
    expect(screen.queryByText(/reports the/)).toBeNull();
  });

  it('shows the explanation under the two values', async () => {
    serveAccount({ facts: FACTS_WITH_CONTRACT, conflicts: [{ ...CONFLICT, explanation: 'GovSpend reports the awarded total; RFP Watch reports the base year.' }] });
    renderApp(PAGE);
    expect(await within(await factsCard()).findByText('GovSpend reports the awarded total; RFP Watch reports the base year.')).toBeInTheDocument();
  });
});
