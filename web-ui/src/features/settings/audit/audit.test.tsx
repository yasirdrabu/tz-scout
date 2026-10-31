import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { AuditEntry } from './api';

const entry = (e: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'action'>): AuditEntry => ({
  actor_kind: 'user',
  actor_id: 'usr_priya',
  api_key_id: null,
  support_access: false,
  subject_type: 'membership',
  subject_id: 'mbr_ash',
  ip: '10.4.2.18',
  at: '2026-10-31T13:10:00Z',
  area: 'members',
  actor_name: 'Priya Raman',
  api_key_name: null,
  ...e,
});

const PAGE_1 = [
  entry({ id: 'a1', action: 'tenancy.member.invited' }),
  entry({ id: 'a2', action: 'integrations.connection.mode_changed', area: 'integrations', actor_name: null, actor_kind: 'system', actor_id: 'system', ip: null }),
];
const PAGE_2 = [entry({ id: 'a3', action: 'tenancy.api_key.created', area: 'api_keys' })];

let seen: URLSearchParams[] = [];

function serve(scopes = ['audit:read', 'members:read']) {
  seen = [];
  serveMe({ taazaa: { scopes, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  server.use(
    http.get('/v1/audit', ({ request }) => {
      const p = new URL(request.url).searchParams;
      seen.push(p);
      if (p.get('q') === 'nothing') return HttpResponse.json({ data: [], next_cursor: null });
      if (p.get('cursor') === 'c2') return HttpResponse.json({ data: PAGE_2, next_cursor: null });
      return HttpResponse.json({ data: PAGE_1, next_cursor: 'c2' });
    }),
    http.get('/v1/members', () =>
      HttpResponse.json({ data: [{ id: 'mbr_priya', user_id: 'usr_priya', name: 'Priya Raman', email: 'priya@taazaa.com', role: 'owner', status: 'active' }] }),
    ),
  );
}

beforeEach(() => localStorage.clear());

describe('Audit log', () => {
  it('lists entries with when, who, area, what happened and IP, and pages with Show more', async () => {
    serve();
    renderApp('/t/taazaa/settings/audit-log');
    const row = (await screen.findByText('tenancy.member.invited')).closest('tr')!;
    expect(row).toHaveTextContent('Oct 31, 9:10 AM');
    expect(row).toHaveTextContent('Priya Raman');
    expect(row).toHaveTextContent('Members');
    expect(row).toHaveTextContent('membership mbr_ash');
    expect(row).toHaveTextContent('10.4.2.18');
    expect(screen.getByText('integrations.connection.mode_changed').closest('tr')).toHaveTextContent('Scout');
    expect(screen.getByText('Showing 2 events, newest first')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('tenancy.api_key.created')).toBeInTheDocument();
    expect(screen.getByText('Showing 3 events, newest first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('searches and filters by area and who', async () => {
    serve();
    renderApp('/t/taazaa/settings/audit-log');
    await screen.findByText('tenancy.member.invited');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Area' }), 'API keys');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Who' }), 'Priya Raman');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an action, person or target' }), 'nothing');
    expect(await screen.findByRole('heading', { name: 'No events match' })).toBeInTheDocument();
    const last = seen[seen.length - 1]!;
    expect(last.get('q')).toBe('nothing');
    expect(last.get('area')).toBe('api_keys');
    expect(last.get('actor_id')).toBe('usr_priya');
  });

  it('hides Who for someone who cannot list members', async () => {
    serve(['audit:read']);
    renderApp('/t/taazaa/settings/audit-log');
    await screen.findByText('tenancy.member.invited');
    expect(screen.queryByRole('combobox', { name: 'Who' })).toBeNull();
  });

  it('shows loading and error states', async () => {
    serve();
    server.use(http.get('/v1/audit', async () => {
      await delay('infinite');
      return HttpResponse.json({ data: [], next_cursor: null });
    }));
    const first = renderApp('/t/taazaa/settings/audit-log');
    expect(await screen.findByText('Loading the audit log')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/audit', () => problem(400, 'Check the request.', { detail: 'That cursor is not valid.', ref: 'cor_a1' })));
    renderApp('/t/taazaa/settings/audit-log');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The audit log didn't load");
    expect(alert).toHaveTextContent('That cursor is not valid.');
    expect(within(alert).getByText('Error ref cor_a1')).toBeInTheDocument();
  });
});
