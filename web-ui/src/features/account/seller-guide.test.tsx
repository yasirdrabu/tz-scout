import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { BLUEPRINT } from '../offers/testing';
import { ASSIGNED, PAGE_LEADER, REVIEW, serveAccount } from './testing';

const serveOffer = (o: object) => server.use(http.get('/api/v1/offers/off_mb', () => HttpResponse.json({ ...BLUEPRINT, practice_lead_name: null, can_delete: false, ...o })));

beforeEach(() => localStorage.clear());

describe('Seller guide on the account page', () => {
  it('shows the lead offer guide in the assigned view', async () => {
    serveAccount({ review: ASSIGNED });
    serveOffer({ talking_points: ['Lead with the mandate'], avoid: ['Do not promise a date'] });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('Lead with the mandate')).toBeInTheDocument();
    expect(screen.getByText('Do not promise a date')).toBeInTheDocument();
  });

  it('says there is no guide, with no button', async () => {
    serveAccount({ review: ASSIGNED });
    serveOffer({ proof_points: [] });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('No seller guide for Modernization Blueprint yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write one' })).toBeNull();
  });

  it('is hidden without a lead offer', async () => {
    serveAccount({ review: { ...ASSIGNED, lead_offer: null } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    await screen.findByRole('region', { name: 'HubSpot activity' });
    expect(screen.queryByText(/seller guide/i)).toBeNull();
  });

  it('is hidden without offers:read', async () => {
    serveAccount({ review: ASSIGNED, scopes: PAGE_LEADER.filter((s) => s !== 'offers:read') });
    serveOffer({ talking_points: ['Lead with the mandate'] });
    renderApp('/t/taazaa/accounts/acc_mdc');
    await screen.findByRole('region', { name: 'HubSpot activity' });
    expect(screen.queryByText('Lead with the mandate')).toBeNull();
  });

  it('is not in the review view', async () => {
    serveAccount({ review: REVIEW });
    serveOffer({ talking_points: ['Lead with the mandate'] });
    renderApp('/t/taazaa/accounts/acc_mdc');
    await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' });
    expect(screen.queryByText('Lead with the mandate')).toBeNull();
  });
});
