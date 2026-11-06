import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { CSV, detail, HUBSPOT, KESTREL, MARCUS, OPERATOR, RFP, serveSources, source, SOURCES, STATS } from './testing';

beforeEach(() => localStorage.clear());

describe('Cost per win tile (§11)', () => {
  const withSpend = (over: Partial<(typeof STATS)[number]>) => [{ ...STATS[1]!, ...over }];
  const cases = [
    ['the money', { spend_cents: 60_000, cost_per_won_cents: 10_000 }, '$100'],
    ['None yet with no wins', { spend_cents: 60_000, cost_per_won_cents: null, won: 0 }, 'None yet'],
    ['Not tracked with no spend', { spend_cents: 0, cost_per_won_cents: null }, 'Not tracked'],
  ] as const;
  it.each(cases)('reads %s', async (_name, over, text) => {
    serveSources({ scopes: [...OPERATOR, 'costs:read'], stats: withSpend(over) });
    renderApp('/t/taazaa/sources/src_rfp');
    await screen.findByRole('heading', { name: 'RFP Watch' });
    const li = (await screen.findByText('Cost per win')).closest('li')!;
    expect(li).toHaveTextContent(text);
  });

  it('is hidden without costs:read', async () => {
    serveSources({ stats: withSpend({ spend_cents: null, cost_per_won_cents: null }) });
    renderApp('/t/taazaa/sources/src_rfp');
    await screen.findByRole('heading', { name: 'RFP Watch' });
    await screen.findByText('Sent');
    expect(screen.queryByText('Cost per win')).toBeNull();
  });
});

describe('Source page header and tiles (§11)', () => {
  it('leaves out See in funnel without analytics:read', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_marcus');
    await screen.findByRole('heading', { name: 'Marcus Lee' });
    expect(screen.queryByRole('link', { name: 'See in funnel' })).toBeNull();
  });

  it('shows the breadcrumb, the owner line and the API percentages on the tiles', async () => {
    serveSources({ scopes: [...OPERATOR, 'analytics:read'] });
    renderApp('/t/taazaa/sources/src_marcus');
    expect(await screen.findByRole('heading', { name: 'Marcus Lee' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByText(/^Owned by Marcus Lee · API key · Last sent/)).toBeInTheDocument();
    const tiles = screen.getByRole('list', { name: 'Source numbers' });
    // sent 2, reviewed 1: only the API could say 33%.
    expect(within(tiles).getByText('33% of sent')).toBeInTheDocument();
    expect(within(tiles).getByText('71% of reviewed')).toBeInTheDocument();
    expect(within(tiles).getByText('9% of assigned')).toBeInTheDocument();
    expect(within(tiles).getAllByText('Not enough data yet').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'See in funnel' }).getAttribute('href')).toBe('/t/taazaa/funnel/src_marcus');
  });

  it('says No owner and names the parent when there is one', async () => {
    serveSources({ sources: [...SOURCES.filter((s) => s.id !== 'src_rfp'), { ...RFP, owner: null }] });
    renderApp('/t/taazaa/sources/src_rfp');
    expect(await screen.findByText(/^No owner · Through Marcus Lee · Part of Marcus Lee · Last sent/)).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Marcus Lee' })).toBeInTheDocument();
  });

  it('pauses and resumes with the toasts', async () => {
    const seen = serveSources();
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources/src_rfp');
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('RFP Watch paused. Anything it sends is refused until you resume it.')).toBeInTheDocument();
    expect(seen.find((s) => s.method === 'PATCH')?.body).toEqual({ status: 'paused' });
    serveSources({ sources: [KESTREL] });
    renderApp('/t/taazaa/sources/src_kestrel');
    await user.click((await screen.findAllByRole('button', { name: 'Resume' }))[0]!);
    expect(await screen.findByText('Kestrel Advisory resumed. New accounts will reach review again.')).toBeInTheDocument();
  });

  it('offers Import a list for a list and Sync now for HubSpot', async () => {
    const seen = serveSources();
    const user = userEvent.setup();
    const list = renderApp('/t/taazaa/sources/src_csv');
    const importLink = await screen.findByRole('link', { name: 'Import a list' });
    expect(importLink.getAttribute('href')).toBe('/t/taazaa/batches/import?source=src_csv');
    list.unmount();
    renderApp('/t/taazaa/sources/src_hub');
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Sync started.')).toBeInTheDocument();
    expect(seen.some((s) => s.method === 'POST' && s.url.pathname.endsWith('src_hub:sync'))).toBe(true);
  });

  it('is read only when archived', async () => {
    const archived = source({ ...RFP, status: 'archived', status_label: 'Archived', can_archive: false });
    serveSources({ sources: [MARCUS, archived] });
    renderApp('/t/taazaa/sources/src_rfp/settings');
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive source' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull();
  });
});

describe('Source page tabs', () => {
  it('counts the Batches tab from the API total, not the rows loaded (C8)', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_marcus');
    expect(await screen.findByRole('tab', { name: 'Batches 7' })).toBeInTheDocument();
  });

  it('lists the batches in the shared Batches table, with the API status and progress', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_marcus/batches');
    const link = await screen.findByRole('link', { name: 'bat_1042' });
    expect(link.getAttribute('href')).toBe('/t/taazaa/batches/bat_1042');
    const row = link.closest('tr')!;
    expect(within(row).getByText('Complete')).toBeInTheDocument();
    expect(within(row).getByText('0 resolved, 0 rejected, 0 waiting')).toBeInTheDocument();
  });

  it('Overview shows where the accounts went from by_stage and the recent activity', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_rfp');
    const went = await screen.findByRole('region', { name: 'Where its accounts went' });
    expect(within(went).getByText('Not pursued')).toBeInTheDocument();
    expect(within(went).getByText('19')).toBeInTheDocument();
    const recent = screen.getByRole('region', { name: 'Recent activity' });
    expect(await within(recent).findByText('Sent back by Dana Whitfield: Wrong practice')).toBeInTheDocument();
  });

  it('Accounts shows Came in through from first_arrival, with the filters in the URL', async () => {
    const seen = serveSources();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/sources/src_marcus/accounts');
    const row = (await screen.findByRole('link', { name: 'Hollis Freight Lines' })).closest('tr')!;
    expect(row).toHaveTextContent('B-1042 · RFP Watch');
    expect(row).toHaveTextContent('Act now');
    expect(row).toHaveTextContent('Modernization Blueprint');
    expect(seen.find((s) => s.url.pathname === '/api/v1/accounts')?.url.searchParams.get('source_id')).toBe('src_marcus');
    await user.click(screen.getByRole('button', { name: /Filter/ }));
    await user.click(await screen.findByRole('tab', { name: /Tier/ }));
    await user.click(await screen.findByRole('radio', { name: /Act now/ }));
    await waitFor(() => expect(new URL(app.path(), 'http://app').searchParams.get('tier')).toBe('act_now'));
  });

  it('Runs lists the children; the tab is hidden without children', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_marcus/runs');
    const runs = await screen.findByRole('tab', { name: /Runs/ });
    expect(runs).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('link', { name: 'RFP Watch' })).toBeInTheDocument();
    serveSources();
    const other = renderApp('/t/taazaa/sources/src_csv');
    await within(other.container).findByRole('heading', { name: 'CSV imports' });
    expect(within(other.container).queryByRole('tab', { name: /Pulls from/ })).toBeNull();
  });
});

describe('Source page Settings', () => {
  it('changes the owner with the toast', async () => {
    const seen = serveSources();
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources/src_rfp/settings');
    const owner = await screen.findByRole('combobox', { name: 'Owner' });
    expect(screen.getByText('Answers for what this source sends.')).toBeInTheDocument();
    await waitFor(() => expect(within(owner).getByRole('option', { name: 'Priya Raman' })).toBeInTheDocument());
    await user.selectOptions(owner, 'usr_priya');
    expect(await screen.findByText('Priya Raman now owns RFP Watch.')).toBeInTheDocument();
    expect(seen.find((s) => s.method === 'PATCH')?.body).toEqual({ owner_user_id: 'usr_priya' });
  });

  it('rotates a key: confirm copy, then the new key once', async () => {
    serveSources();
    let rotated = 0;
    server.use(
      http.post(exactly('/api/v1/sources/src_marcus/keys/key_m:rotate'), () => {
        rotated++;
        return HttpResponse.json({ id: 'key_n', prefix: 'scout_live_ZzYy9876', secret: 'scout_live_ZzYy9876secretsecretsecretsecret12', environment: 'live', created_at: '2026-11-01T12:00:00Z' }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources/src_marcus/settings');
    expect(await screen.findByText('scout_live_AbCd1234…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate Marcus key?' });
    expect(dialog).toHaveTextContent('The old key stops working within a minute.');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }));
    const reveal = await screen.findByRole('dialog', { name: 'New key for Marcus key' });
    expect(within(reveal).getByLabelText('New API key')).toHaveTextContent('scout_live_ZzYy9876secretsecretsecretsecret12');
    expect(reveal).toHaveTextContent("Copy this now. You won't see it again.");
    expect(within(reveal).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('scout_live_ZzYy9876secretsecretsecretsecret12')).toBeNull();
    expect(rotated).toBe(1);
  });

  it('revokes a key with the confirm and toast', async () => {
    serveSources();
    server.use(http.delete('/api/v1/sources/src_marcus/keys/key_m', () => new HttpResponse(null, { status: 204 })));
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources/src_marcus/settings');
    await user.click(await screen.findByRole('button', { name: 'Revoke key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke Marcus key?' });
    expect(dialog).toHaveTextContent('Calls with it fail from now on.');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('Marcus key revoked. Calls with it now fail.')).toBeInTheDocument();
  });

  it('offers Remove only when can_remove, and goes back to Sources', async () => {
    serveSources();
    server.use(http.delete('/api/v1/sources/src_csv', () => new HttpResponse(null, { status: 204 })));
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/sources/src_csv/settings');
    await user.click(await screen.findByRole('button', { name: 'Remove source' }));
    expect(screen.queryByRole('button', { name: 'Archive source' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Remove CSV imports?' });
    expect(dialog).toHaveTextContent('It has sent nothing, so nothing else changes.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('CSV imports removed.')).toBeInTheDocument();
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/sources'));
  });

  it("offers Archive only when can_archive, and shows the API's 409 title", async () => {
    serveSources();
    server.use(http.patch('/api/v1/sources/src_rfp', () => problem(409, 'Remove or archive the sources under RFP Watch first.')));
    const user = userEvent.setup();
    renderApp('/t/taazaa/sources/src_rfp/settings');
    await user.click(await screen.findByRole('button', { name: 'Archive source' }));
    expect(screen.queryByRole('button', { name: 'Remove source' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Archive RFP Watch?' });
    expect(dialog).toHaveTextContent('It stops sending for good and its keys stop working. Its accounts and history stay.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Remove or archive the sources under RFP Watch first.')).toBeInTheDocument();
  });

  it('says to remove the children first, with no button, when it has children', async () => {
    serveSources();
    renderApp('/t/taazaa/sources/src_marcus/settings');
    expect(await screen.findByText('Remove or archive the sources under Marcus Lee first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove source' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive source' })).toBeNull();
  });

  it('shows the HubSpot sync and Connect HubSpot first', async () => {
    serveSources({ one: detail(HUBSPOT, { sync: { last_polled_at: null, last_error: 'HubSpot said 401', connected: false } }), scopes: [...['arrivals:read', 'sources:manage'], 'integrations:manage'] });
    renderApp('/t/taazaa/sources/src_hub/settings');
    expect(await screen.findByText('HubSpot said 401')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect HubSpot first' }).getAttribute('href')).toBe('/t/taazaa/settings/integrations');
  });

  it('a list connects through files', async () => {
    serveSources({ sources: [MARCUS, CSV] });
    renderApp('/t/taazaa/sources/src_csv/settings');
    const conn = await screen.findByRole('region', { name: 'Connection' });
    expect(within(conn).getByRole('link', { name: 'Import a list' })).toBeInTheDocument();
    expect(within(conn).getByRole('link', { name: 'Open Marcus Lee' })).toBeInTheDocument();
  });
});
