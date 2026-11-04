import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { draftPlaybook, rfp } from '../playbooks/testing';
import type { OfferPlaybook } from './api';
import { BLUEPRINT, MANAGER, emptyTiers, offer, serveOffers } from './testing';

const PICKER = [...MANAGER, 'playbooks:read'];
const patches = (seen: ReturnType<typeof serveOffers>) => seen.filter((r) => r.method === 'PATCH').map((r) => r.body as Record<string, unknown>);

describe('Offer form: objections round-trip', () => {
  const loaded = offer({ ...BLUEPRINT, objections: [{ objection: 'Too dear', answer: 'Fixed fee |\ncheap' }] });

  it('shows line breaks as spaces and sends objections only when that text changed', async () => {
    const seen = serveOffers({ offers: [loaded] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    const box = await within(d).findByLabelText('Objections');
    expect(box).toHaveValue('Too dear | Fixed fee | cheap');
    await user.type(within(d).getByLabelText('Title'), ' v2');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint v2 saved.');
    expect(patches(seen)[0]).not.toHaveProperty('objections');
    expect(patches(seen)[0]).not.toHaveProperty('talking_points');
    expect(patches(seen)[0]).not.toHaveProperty('avoid');
  });

  it('sends talking points and avoid only when their text changed', async () => {
    const seen = serveOffers({ offers: [offer({ ...BLUEPRINT, talking_points: ['One\nstill one'], avoid: ['Nope'] })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    await user.type(await within(d).findByLabelText('Talking points'), '{Enter}Two');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint saved.');
    expect(patches(seen)[0]!.talking_points).toEqual(['One', 'still one', 'Two']);
    expect(patches(seen)[0]).not.toHaveProperty('avoid');
  });

  it('sends them when edited', async () => {
    const seen = serveOffers({ offers: [loaded] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    await user.type(await within(d).findByLabelText('Objections'), '{Enter}Not now | Costs rise');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint saved.');
    expect(patches(seen)[0]!.objections).toEqual([
      { objection: 'Too dear', answer: 'Fixed fee | cheap' },
      { objection: 'Not now', answer: 'Costs rise' },
    ]);
  });

  it('an objection loaded with "|" is refused when objections are edited and left as it was', async () => {
    const seen = serveOffers({ offers: [offer({ ...BLUEPRINT, objections: [{ objection: 'A | B', answer: 'C' }] })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await screen.findByRole('dialog', { name: 'Edit offer' });
    const box = await within(d).findByLabelText('Objections');
    expect(box).toHaveValue('A | B | C');
    await user.type(box, '{Enter}Next | Answer');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByText('Take the | out of the objection.')).toBeInTheDocument();
    expect(patches(seen)).toHaveLength(0);
    await user.clear(box);
    await user.type(box, 'A and B | C');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint saved.');
    expect(patches(seen)[0]!.objections).toEqual([{ objection: 'A and B', answer: 'C' }]);
  });
});

describe('Offer page: tier selects states', () => {
  const draftMapped = (): Record<string, OfferPlaybook[]> => ({
    off_mb: emptyTiers().map((t) => (t.tier === 'watch' ? { ...t, playbook: { id: 'plb_draft', name: 'Warm intro', status: 'draft', steps: 1, days: 0 } } : t)),
  });

  it('a mapped playbook that is not active still shows in its tier select', async () => {
    serveOffers({ scopes: PICKER, playbooks: [rfp(), draftPlaybook()], tiers: draftMapped() });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const watch = await screen.findByRole('combobox', { name: 'Watch playbook' });
    expect(watch).toHaveValue('plb_draft');
    expect(within(watch).getByRole('option', { name: 'Warm intro' })).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Act now playbook' })).queryByRole('option', { name: 'Warm intro' })).toBeNull();
  });

  it('a retired offer shows its tiers as text', async () => {
    serveOffers({ offers: [offer({ ...BLUEPRINT, status: 'archived', status_label: 'Retired' })], playbooks: [rfp()], tiers: draftMapped() });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    const region = await screen.findByRole('region', { name: 'Playbook by tier' });
    expect(await within(region).findByText('Warm intro')).toBeInTheDocument();
    expect(within(region).queryByRole('combobox')).toBeNull();
  });

  it('shows a loading line while the playbooks load', async () => {
    serveOffers({ scopes: PICKER, playbooks: [rfp()] });
    server.use(http.get('/api/v1/playbooks', () => delay('infinite')));
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    expect((await screen.findAllByText('Loading playbooks')).length).toBe(3);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the error text when the playbooks fail to load, not a silent read-only list', async () => {
    serveOffers({ scopes: PICKER, playbooks: [rfp()] });
    server.use(http.get('/api/v1/playbooks', () => problem(500, 'The playbooks are down.')));
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
