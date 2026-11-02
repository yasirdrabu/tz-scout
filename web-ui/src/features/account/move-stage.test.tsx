import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { PAGE_LEADER, REVIEW, SELLER, serveAccount, STAGES } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';

// A workspace that renamed Reviewed and put "Triage" (where a reviewer sets a tier) after a new second stage.
const CUSTOM = {
  ...STAGES,
  stages: [
    STAGES.stages[0]!,
    { ...STAGES.stages[2]!, key: 'stg_a', name: 'Screened', position: 1, trigger: 'by_hand' },
    { ...STAGES.stages[1]!, key: 'reviewed', name: 'Triage', position: 2 },
    ...STAGES.stages.slice(3),
  ],
};
const CUSTOM_REVIEW = {
  ...REVIEW,
  stages: [
    { key: 'arrived', label: 'Arrived', at: '2026-10-24T14:00:00Z', current: true },
    { key: 'stg_a', label: 'Screened', at: null, current: false },
    { key: 'reviewed', label: 'Triage', at: null, current: false },
    { key: 'won', label: 'Won', at: null, current: false },
  ],
};

describe('Stage tracker', () => {
  it('says "Waiting on you" on the next step when it is the reviewer_sets_tier stage and the person reviews', async () => {
    serveAccount();
    renderApp(URL);
    const tracker = await screen.findByRole('list', { name: 'Stages' });
    const reviewed = within(tracker).getByText('Reviewed').closest('li')!;
    await waitFor(() => expect(reviewed).toHaveTextContent('Waiting on you'));
    expect(within(tracker).getByText('Assigned').closest('li')).not.toHaveTextContent('Next');
  });

  it('follows the stage with the trigger, not a stage key', async () => {
    serveAccount({ stages: CUSTOM, review: CUSTOM_REVIEW });
    renderApp(URL);
    const tracker = await screen.findByRole('list', { name: 'Stages' });
    expect(within(tracker).getByText('Screened').closest('li')).toHaveTextContent('Next');
    expect(within(tracker).getByText('Screened').closest('li')).not.toHaveTextContent('Waiting on you');
    expect(within(tracker).getByText('Triage').closest('li')).not.toHaveTextContent('Waiting on you');
  });

  it('waits on you at the custom stage when it is the next one', async () => {
    serveAccount({ stages: CUSTOM, review: { ...CUSTOM_REVIEW, stages: CUSTOM_REVIEW.stages.map((s) => ({ ...s, current: s.key === 'stg_a', at: s.key === 'arrived' || s.key === 'stg_a' ? '2026-10-24T14:00:00Z' : null })) } });
    renderApp(URL);
    const tracker = await screen.findByRole('list', { name: 'Stages' });
    await waitFor(() => expect(within(tracker).getByText('Triage').closest('li')).toHaveTextContent('Waiting on you'));
  });

  it('says only "Next" to someone who cannot review', async () => {
    serveAccount({ scopes: SELLER });
    renderApp(URL);
    const tracker = await screen.findByRole('list', { name: 'Stages' });
    expect(within(tracker).getByText('Reviewed').closest('li')).toHaveTextContent('Next');
    expect(within(tracker).getByText('Reviewed').closest('li')).not.toHaveTextContent('Waiting on you');
  });
});

describe('Move to stage', () => {
  it('is only for review:act', async () => {
    serveAccount({ scopes: SELLER });
    renderApp(URL);
    await screen.findByRole('list', { name: 'Stages' });
    expect(screen.queryByRole('button', { name: 'Move to stage' })).toBeNull();
  });

  it('lists the live stages except the current one, then moves with an optional note, toasts and refreshes', async () => {
    const view = serveAccount({ scopes: PAGE_LEADER });
    let reviewReads = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc/review', () => {
        reviewReads++;
        return HttpResponse.json(reviewReads > 1 ? { ...REVIEW, stage: 'engaged' } : REVIEW);
      }),
      http.post(exactly('/api/v1/accounts/acc_mdc:move-stage'), async ({ request }) => {
        await view.note(request);
        return HttpResponse.json({ ...REVIEW, stage: 'engaged' });
      }),
    );
    renderApp(URL);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Move to stage' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Reviewed', 'Assigned', 'Engaged', 'Opportunity', 'Won', 'Disqualified']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Engaged' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Miami-Dade County DTPW to Engaged' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Met at the conference');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Miami-Dade County DTPW moved to Engaged.')).toBeInTheDocument();
    expect(view.sent['/api/v1/accounts/acc_mdc:move-stage']).toEqual([{ stage: 'engaged', note: 'Met at the conference' }]);
    await waitFor(() => expect(reviewReads).toBeGreaterThan(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends no note when none is typed, and shows the API words when it refuses', async () => {
    const view = serveAccount({ scopes: PAGE_LEADER });
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:move-stage'), async ({ request }) => {
        await view.note(request);
        return problem(400, 'Pick a stage from your list.');
      }),
    );
    renderApp(URL);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Move to stage' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Won' }));
    const dialog = await screen.findByRole('dialog', { name: /Move Miami-Dade County DTPW to Won/ });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Pick a stage from your list.');
    expect(view.sent['/api/v1/accounts/acc_mdc:move-stage']).toEqual([{ stage: 'won' }]);
    expect(screen.queryByText(/moved to Won/)).toBeNull();
  });
});
