import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import type { AccountScore } from './api';
import { SCORE, serveAccount } from './testing';

const PAGE = '/t/taazaa/accounts/acc_mdc';
const INTRO = SCORE.warm_intro!;
const scoreWith = (w: Partial<typeof INTRO>): AccountScore => ({ ...SCORE, warm_intro: { ...INTRO, ...w } });
const unconfirmed = { confirmed: false, points: 4, can_confirm: true };
const checklist = () => screen.findByRole('region', { name: 'Before you approve' });
const CONFIRM = exactly('/api/v1/warm-intros/wi_1:confirm');

beforeEach(() => localStorage.clear());

describe('Warm intro on the account page', () => {
  it('shows the confirmed line', async () => {
    serveAccount();
    renderApp(PAGE);
    const before = await checklist();
    expect(before).toHaveTextContent('Warm intro from Ash Patel (someone on our team knows them), +8');
    expect(before).not.toHaveTextContent('Unconfirmed');
    expect(within(before).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('shows the no-name variant, and still shows the card', async () => {
    serveAccount({ score: scoreWith({ introducer_name: null }) });
    renderApp(PAGE);
    expect(await checklist()).toHaveTextContent('Warm intro (someone on our team knows them), +8');
  });

  it('shows Unconfirmed with Confirm; clicking posts, toasts and refetches the score', async () => {
    serveAccount({ score: scoreWith(unconfirmed) });
    let posts = 0;
    let gets = 0;
    let confirmed = false;
    server.use(
      http.get('/api/v1/accounts/acc_mdc/score', () => {
        gets += 1;
        return HttpResponse.json(confirmed ? SCORE : scoreWith(unconfirmed));
      }),
      http.post(CONFIRM, () => {
        posts += 1;
        confirmed = true;
        return HttpResponse.json({ warm_intro: INTRO });
      }),
    );
    const app = renderApp(PAGE);
    const invalidate = vi.spyOn(app.queryClient, 'invalidateQueries');
    const before = await checklist();
    expect(await within(before).findByText(/Unconfirmed, \+4 of 8/)).toHaveTextContent(
      'Warm intro from Ash Patel (someone on our team knows them) · Unconfirmed, +4 of 8',
    );
    const seen = gets;
    await userEvent.click(within(before).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Warm intro confirmed. It now counts all 8 points.')).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'taazaa', 'acc_mdc'] });
    await waitFor(() => expect(gets).toBeGreaterThan(seen));
    await waitFor(() => expect(within(before).queryByRole('button', { name: 'Confirm' })).toBeNull());
    expect(before).not.toHaveTextContent('Unconfirmed');
  });

  it('shows no button when the caller cannot confirm', async () => {
    serveAccount({ score: scoreWith({ ...unconfirmed, can_confirm: false }) });
    renderApp(PAGE);
    const before = await checklist();
    expect(await within(before).findByText(/Unconfirmed, \+4 of 8/)).toBeInTheDocument();
    expect(within(before).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('shows the API message when confirming fails', async () => {
    serveAccount({ score: scoreWith(unconfirmed) });
    server.use(http.post(CONFIRM, () => problem(403, 'Forbidden', { detail: 'Only a reviewer or Ash Patel, who made the intro, can confirm it.', slug: 'forbidden' })));
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Only a reviewer or Ash Patel, who made the intro, can confirm it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });
});
