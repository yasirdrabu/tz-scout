import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { RFP_STEPS, rfp, servePlaybooks } from '../playbooks/testing';
import { SELLER, serveAccount } from './testing';

const suggest = (playbook: unknown) =>
  server.use(http.get('/api/v1/accounts/acc_mdc/playbook-suggestion', () => HttpResponse.json({ playbook, reason: playbook ? 'offer_tier' : 'none', offer: null, tier: null })));
const SUGGESTED = { id: 'plb_rfp', name: 'Public sector RFP', steps: 3, days: 14 };
const card = () => screen.findByRole('region', { name: 'Playbook' });

describe('Playbook preview', () => {
  it('shows the header and each step as not started', async () => {
    servePlaybooks({ playbooks: [rfp()], steps: { plb_rfp: RFP_STEPS } });
    serveAccount();
    suggest(SUGGESTED);
    renderApp('/t/taazaa/accounts/acc_mdc');
    const c = await card();
    expect(await within(c).findByText('Public sector RFP · 3 steps over 14 days · starts when accepted')).toBeInTheDocument();
    const rows = within(c).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Day 0');
    expect(rows[0]).toHaveTextContent('Send the opening email');
    expect(rows[0]).toHaveTextContent('Seller');
    expect(rows[0]).toHaveTextContent('Not started');
    expect(rows[2]).toHaveTextContent('Day 14');
    expect(rows[2]).toHaveTextContent('Leader');
  });

  it('shows no card without a suggestion', async () => {
    serveAccount();
    suggest(null);
    renderApp('/t/taazaa/accounts/acc_mdc');
    await screen.findByRole('region', { name: 'Brief' });
    expect(screen.queryByRole('region', { name: 'Playbook' })).not.toBeInTheDocument();
  });

  it('shows no card without assign:act', async () => {
    servePlaybooks({ playbooks: [rfp()], steps: { plb_rfp: RFP_STEPS } });
    serveAccount({ scopes: [...SELLER, 'review:read'] });
    suggest(SUGGESTED);
    renderApp('/t/taazaa/accounts/acc_mdc');
    await screen.findByRole('region', { name: 'Brief' });
    expect(screen.queryByRole('region', { name: 'Playbook' })).not.toBeInTheDocument();
  });

  it('shows a loading line, then an error if the playbook does not load', async () => {
    serveAccount();
    suggest(SUGGESTED);
    server.use(http.get('/api/v1/playbooks/plb_rfp', () => problem(500, 'Server error.')));
    renderApp('/t/taazaa/accounts/acc_mdc');
    const c = await card();
    expect(within(c).getByText('Loading playbook')).toBeInTheDocument();
    expect(await within(c).findByRole('alert')).toHaveTextContent("Playbook didn't load.");
  });
});
