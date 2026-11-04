import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { draftPlaybook, rfp } from '../playbooks/testing';
import { BLUEPRINT, MANAGER, READER, emptyTiers, offer, serveOffers } from './testing';
import type { OfferPlaybook } from './api';

const LEADER = ['offers:read', 'playbooks:read', 'playbooks:manage'];
const WARM = rfp({ id: 'plb_warm', name: 'Warm intro', steps: 1, days: 0, runs_on: [] });
const PLAYBOOKS = [rfp(), WARM, draftPlaybook()];

const withRfp = (): Record<string, OfferPlaybook[]> => ({
  off_mb: emptyTiers().map((t) =>
    t.tier === 'act_now'
      ? { ...t, playbook: { id: 'plb_rfp', name: 'Public sector RFP', status: 'active', steps: 3, days: 14 }, first_email: { subject: 'Hi {person.first_name}', body: 'Line one.\n\nLine two for {account.name}.' } }
      : t,
  ),
});

const puts = (seen: ReturnType<typeof serveOffers>) => seen.filter((r) => r.method === 'PUT');

describe('Offer page: playbook by tier (§19)', () => {
  it('shows three rows with active playbooks, the empty-tier notes and the footer', async () => {
    serveOffers({ scopes: [...MANAGER, 'playbooks:read'], playbooks: PLAYBOOKS, tiers: withRfp() });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Playbook by tier' });
    expect(within(region).getByText('Starts when an AE accepts an account matched to this offer')).toBeInTheDocument();
    const act = await within(region).findByRole('combobox', { name: 'Act now playbook' });
    expect(act).toHaveValue('plb_rfp');
    expect(within(act).getAllByRole('option').map((o) => o.textContent)).toEqual(['No playbook', 'Public sector RFP', 'Warm intro']);
    expect(within(region).getByText('3 steps over 14 days')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Open Public sector RFP' })).toHaveAttribute('href', '/t/taazaa/playbooks/plb_rfp');
    expect(within(region).getByRole('combobox', { name: 'Good fit playbook' })).toHaveValue('');
    expect(within(region).getByText('AE works it with no set steps.')).toBeInTheDocument();
    expect(within(region).getByText('Stays in the queue as Watch. Scout re-scores it weekly.')).toBeInTheDocument();
    expect(within(region).getByText('Changing a playbook affects accounts accepted from now on. Accounts already running keep the playbook they started with.')).toBeInTheDocument();
  });

  it('changing a select PUTs that tier and shows the toast; choosing none sends null', async () => {
    const seen = serveOffers({ playbooks: PLAYBOOKS, tiers: withRfp() });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Good fit playbook' }), 'plb_warm');
    expect(await screen.findByText('Good fit now uses Warm intro.')).toBeInTheDocument();
    expect(puts(seen)[0]!.url.pathname).toBe('/api/v1/offers/off_mb/playbooks/good_fit');
    expect(puts(seen)[0]!.body).toEqual({ playbook_id: 'plb_warm' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Good fit playbook' })).toHaveValue('plb_warm'));
    expect(screen.getByText('1 step over 0 days')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Act now playbook' }), '');
    expect(await screen.findByText('Act now has no playbook now.')).toBeInTheDocument();
    expect(puts(seen)[1]!.body).toEqual({ playbook_id: null });
  });

  it('a leader (playbooks:manage, no offers:manage) changes tiers but the seller guide is read-only', async () => {
    const seen = serveOffers({ scopes: LEADER, playbooks: PLAYBOOKS, tiers: withRfp(), offers: [offer({ ...BLUEPRINT, talking_points: ['Lead with the funded plan'] })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Watch playbook' }), 'plb_warm');
    expect(await screen.findByText('Watch now uses Warm intro.')).toBeInTheDocument();
    expect(puts(seen)).toHaveLength(1);
    expect(screen.getByText('Lead with the funded plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit offer' })).toBeNull();
  });

  it('a reader sees text only: names without selects, and no playbook list request', async () => {
    const seen = serveOffers({ scopes: READER, playbooks: PLAYBOOKS, tiers: withRfp() });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Playbook by tier' });
    expect(await within(region).findByText('Public sector RFP')).toBeInTheDocument();
    expect(within(region).queryByRole('combobox')).toBeNull();
    expect(within(region).queryByRole('link', { name: /^Open/ })).toBeNull();
    expect(within(region).getByText('3 steps over 14 days')).toBeInTheDocument();
    expect(within(region).getAllByText('No playbook')).toHaveLength(2);
    expect(seen.some((r) => r.url.pathname.endsWith('/playbooks') && r.url.pathname === '/api/v1/playbooks')).toBe(false);
  });

  it('shows the API message when a change fails', async () => {
    serveOffers({ playbooks: PLAYBOOKS, tiers: withRfp(), answer: { 'PUT watch': () => HttpResponse.json({ type: 'x', title: 'No', status: 409, detail: 'That playbook is retired.' }, { status: 409, headers: { 'content-type': 'application/problem+json' } }) } });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Watch playbook' }), 'plb_warm');
    expect(await screen.findByText('That playbook is retired.')).toBeInTheDocument();
  });
});

describe('Offer page: initial message (§19)', () => {
  it('shows a block per tier with a first email and Copy puts the text on the clipboard', async () => {
    serveOffers({ playbooks: PLAYBOOKS, tiers: withRfp() });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Initial message' });
    expect(within(region).getByText('Scout fills in {account.name}, {person.first_name} and the other placeholders when the plan starts.')).toBeInTheDocument();
    const block = within(region).getByRole('group', { name: 'Act now initial message' });
    expect(within(block).getByText('Hi {person.first_name}')).toBeInTheDocument();
    expect(within(region).getAllByRole('group')).toHaveLength(1);
    await user.click(within(block).getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Initial message copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('Subject: Hi {person.first_name}\n\nLine one.\n\nLine two for {account.name}.');
  });

  it('is hidden when no tier has a first email', async () => {
    serveOffers({ playbooks: PLAYBOOKS });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await screen.findByRole('region', { name: 'Playbook by tier' });
    await screen.findByRole('combobox', { name: 'Act now playbook' });
    expect(screen.queryByRole('region', { name: 'Initial message' })).toBeNull();
  });
});

describe('Offer page: seller guide (§19)', () => {
  const GUIDE = offer({
    ...BLUEPRINT,
    talking_points: ['Lead with the funded plan', 'Ask who signs'],
    objections: [{ objection: 'We have no budget', answer: 'The plan pays for itself.' }],
    proof_points: ['Plan approved in 7 weeks'],
    avoid: ['Promising a date'],
  });

  it('shows numbered talking points, objections with answers, proof points and avoid', async () => {
    serveOffers({ offers: [GUIDE] });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Seller guide' });
    expect(within(region).getByText('What to say, what to expect, what to avoid. Shown to the AE on every account matched to this offer.')).toBeInTheDocument();
    const numbered = within(region).getAllByRole('list').find((l) => l.tagName === 'OL')!;
    expect(within(numbered).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['Lead with the funded plan', 'Ask who signs']);
    expect(within(region).getByRole('heading', { name: 'When they say' })).toBeInTheDocument();
    expect(within(region).getByText('“We have no budget”')).toBeInTheDocument();
    expect(within(region).getByText('The plan pays for itself.')).toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'Proof points' })).toBeInTheDocument();
    expect(within(region).getByText('Plan approved in 7 weeks')).toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'Avoid' })).toBeInTheDocument();
    expect(within(region).getByText('Promising a date')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Write one' })).toBeNull();
  });

  it('empty: "No seller guide yet." and Write one opens the form at the guide for offers:manage', async () => {
    serveOffers({ offers: [offer({ ...BLUEPRINT, proof_points: [] })] });
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Seller guide' });
    expect(within(region).getByText(/No seller guide yet\./)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Write one' }));
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    expect(app.path()).toContain('field=talking_points');
    await waitFor(() => expect(within(d).getByLabelText('Talking points')).toHaveFocus());
  });

  it('empty for a reader: no Write one button', async () => {
    serveOffers({ scopes: MANAGER.filter((s) => s !== 'offers:manage'), offers: [offer({ ...BLUEPRINT, proof_points: [] })] });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Seller guide' });
    expect(within(region).getByText(/No seller guide yet\./)).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Write one' })).toBeNull();
  });
});

describe('Offer form: seller guide group (§19)', () => {
  const bodies = (seen: ReturnType<typeof serveOffers>) => seen.filter((r) => r.method === 'PATCH').map((r) => r.body as Record<string, unknown>);

  it('round-trips the guide: lines in, lists out, objections split at the first "|"', async () => {
    const seen = serveOffers({ offers: [offer({ ...BLUEPRINT, objections: [{ objection: 'Too dear', answer: 'Compare the cost of waiting' }], avoid: ['Discounts'] })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    const group = await within(d).findByRole('group', { name: 'Seller guide' });
    expect(within(group).getByLabelText('Objections')).toHaveValue('Too dear | Compare the cost of waiting');
    expect(within(group).getByText('One per line, written as: objection | answer')).toBeInTheDocument();
    expect(within(group).getByLabelText('Proof points')).toHaveValue('Plan approved in 7 weeks');
    await user.type(within(group).getByLabelText('Talking points'), 'First{Enter}{Enter}Second');
    await user.type(within(group).getByLabelText('Objections'), '{Enter}Not now | Costs rise | later');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint saved.');
    expect(bodies(seen)[0]).toMatchObject({
      talking_points: ['First', 'Second'],
      objections: [
        { objection: 'Too dear', answer: 'Compare the cost of waiting' },
        { objection: 'Not now', answer: 'Costs rise | later' },
      ],
      proof_points: ['Plan approved in 7 weeks'],
      avoid: ['Discounts'],
    });
  });

  it('an objection line without "|" shows a field error and sends nothing', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    await user.type(await within(d).findByLabelText('Objections'), 'We have no budget');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByText('Write each line as: objection | answer')).toBeInTheDocument();
    expect(within(d).getByLabelText('Objections')).toHaveAttribute('aria-invalid', 'true');
    expect(bodies(seen)).toHaveLength(0);
    await user.clear(within(d).getByLabelText('Objections'));
    await user.type(within(d).getByLabelText('Objections'), 'We have no budget | ');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByText('Write each line as: objection | answer')).toBeInTheDocument();
    expect(bodies(seen)).toHaveLength(0);
  });

  it('a server error on objections.N.answer shows at the Objections field', async () => {
    serveOffers({
      answer: { 'PATCH off_mb': () => HttpResponse.json({ type: 'x', title: 'Invalid', status: 400, errors: [{ path: 'objections.0.answer', message: 'Keep this under 500 characters.' }] }, { status: 400, headers: { 'content-type': 'application/problem+json' } }) },
    });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    await user.type(await within(d).findByLabelText('Objections'), 'a | b');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByText('Keep this under 500 characters.')).toBeInTheDocument();
  });
});
