import { http, HttpResponse } from 'msw';
import { server } from '../test/server';
import { fetchMe, hasScope, isPlatformAdmin, personOf, workspacesOf, type Me } from './me';

const me: Me = {
  tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa' },
  kind: 'user',
  id: 'm1',
  scopes: ['review:act', 'accounts:read'],
  data_limit: { kind: 'all' },
  source_id: null,
  environment: null,
};

describe('/me', () => {
  it('fetches today’s /v1/me for a tenant', async () => {
    let tenant: string | null = null;
    server.use(
      http.get('/v1/me', ({ request }) => {
        tenant = request.headers.get('x-scout-tenant');
        return HttpResponse.json(me);
      }),
    );
    expect(await fetchMe('taazaa')).toEqual(me);
    expect(tenant).toBe('taazaa');
  });

  it('checks scopes', () => {
    expect(hasScope(me, 'review:act')).toBe(true);
    expect(hasScope(me, 'sources:manage')).toBe(false);
  });

  it('reads the fields the backend does not send yet as absent', () => {
    expect(personOf(me)).toEqual({ name: null, email: null });
    expect(isPlatformAdmin(me)).toBe(false);
    expect(workspacesOf(me)).toEqual([{ id: 't1', slug: 'taazaa', name: 'Taazaa', role: null, member_count: null }]);
  });

  it('uses the person, platform admin flag and workspaces once /me carries them', () => {
    const later = {
      ...me,
      name: 'Dana Whitfield',
      email: 'dana@taazaa.com',
      platform_admin: true,
      workspaces: [
        { id: 't1', slug: 'taazaa', name: 'Taazaa', role: 'leader', member_count: 14 },
        { id: 't2', slug: 'brightline', name: 'Brightline Logistics', role: 'owner', member_count: 6 },
        { slug: 42 },
      ],
    };
    expect(personOf(later)).toEqual({ name: 'Dana Whitfield', email: 'dana@taazaa.com' });
    expect(isPlatformAdmin(later)).toBe(true);
    expect(workspacesOf(later).map((w) => w.slug)).toEqual(['taazaa', 'brightline']);
    expect(workspacesOf(later)[1]).toMatchObject({ member_count: 6, role: 'owner' });
  });
});
