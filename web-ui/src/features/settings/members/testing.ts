import { http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { Member } from './api';

// Test data for the Members tab tests.

export const OWNER = ['members:read', 'members:manage', 'integrations:manage', 'keys:manage', 'settings:manage', 'audit:read', 'offers:read'];
export const PRIYA = { id: 'usr_priya', name: 'Priya Raman', email: 'priya@taazaa.com', platform_admin: false };

export const member = (m: Partial<Member> & Pick<Member, 'id' | 'name'>): Member => ({
  user_id: `usr_${m.id}`,
  email: `${m.name.split(' ')[0]!.toLowerCase()}@taazaa.com`,
  role: 'seller',
  status: 'active',
  last_active_at: '2026-10-31T09:00:00Z',
  sign_in_method: 'microsoft',
  data_limit: null,
  crm_owner_ids: {},
  extra_permissions: [],
  open_account_count: 0,
  ...m,
});

export const MEMBERS: Member[] = [
  member({ id: 'mbr_ash', name: 'Ash Patel', data_limit: { kind: 'practices', ids: ['p1'] }, open_account_count: 23 }),
  member({ id: 'mbr_dana', name: 'Dana Whitfield', role: 'leader', crm_owner_ids: { hubspot: '7001' } }),
  member({ id: 'mbr_lena', name: 'Lena Brooks', status: 'suspended', open_account_count: 9 }),
  member({ id: 'mbr_priya', name: 'Priya Raman', user_id: 'usr_priya', role: 'owner' }),
  member({ id: 'mbr_ravi', name: 'ravi.menon@taazaa.com', email: 'ravi.menon@taazaa.com', status: 'invited', last_active_at: null, sign_in_method: null }),
];

export const ROLES = {
  roles: [
    { role: 'owner', permissions: ['accounts:read', 'members:manage'] },
    { role: 'leader', permissions: ['accounts:read'] },
    { role: 'seller', permissions: [] },
    { role: 'operator', permissions: ['accounts:read'] },
  ],
  permissions: [
    { key: 'accounts:read', label: 'See every account', group: 'Accounts' },
    { key: 'members:manage', label: 'Invite and manage members', group: 'Workspace' },
  ],
};

export function serve(members: Member[] = MEMBERS, scopes = OWNER) {
  serveMe({ taazaa: { scopes, user: PRIYA } });
  server.use(
    http.get('/v1/members', () => HttpResponse.json({ data: members })),
    http.get('/v1/roles', () => HttpResponse.json(ROLES)),
    http.get('/v1/practices', () => HttpResponse.json({ data: [{ id: 'p1', name: 'Public sector' }, { id: 'p2', name: 'Health' }], next_cursor: null })),
  );
}

export const fail = () => problem(409, 'That did not work.', { detail: 'The API refused this change.' });

