import { http, HttpResponse } from 'msw';
import { server } from '../test/server';
import { fetchMe, hasScope, isPlatformAdmin, personOf, profileOf, userIdOf, workspacesOf, type Me } from './me';

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

  it('reads missing person fields and workspaces as absent', () => {
    expect(personOf(me)).toEqual({ name: null, email: null });
    expect(isPlatformAdmin(me)).toBe(false);
    expect(workspacesOf(me)).toEqual([{ id: 't1', slug: 'taazaa', name: 'Taazaa', role: null, member_count: null }]);
    expect(workspacesOf({ ...me, tenant: null } as unknown as Me)).toEqual([]);
  });

  it('uses the person, platform admin flag and workspaces /me carries', () => {
    const later = {
      ...me,
      user: { id: 'm1', name: 'Dana Whitfield', email: 'dana@taazaa.com', platform_admin: true },
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

describe('profile fields', () => {
  it('reads the role, sign-in method, access lines and user id', () => {
    const withProfile = {
      ...me,
      user: { id: 'usr_1', name: 'Dana', email: 'dana@taazaa.com', platform_admin: false, sign_in_method: 'microsoft' },
      role: 'leader',
      access_summary: ['Every account in this workspace', 7],
    } as unknown as Me;
    expect(profileOf(withProfile)).toEqual({ role: 'leader', signInMethod: 'microsoft', access: ['Every account in this workspace'] });
    expect(userIdOf(withProfile)).toBe('usr_1');
  });

  it('reads them as absent for an API key', () => {
    expect(profileOf(me)).toEqual({ role: null, signInMethod: null, access: [] });
    expect(userIdOf(me)).toBeNull();
  });
});
