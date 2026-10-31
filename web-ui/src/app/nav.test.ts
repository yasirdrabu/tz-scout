import type { Me } from '../api/me';
import { landingPath, visibleNav, visibleSettingsTabs } from './nav';

const meWith = (scopes: string[], extra: Record<string, unknown> = {}): Me =>
  ({
    tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa' },
    kind: 'user',
    id: 'm1',
    scopes,
    data_limit: { kind: 'all' },
    source_id: null,
    environment: null,
    ...extra,
  }) as Me;

const labels = (me: Me) => visibleNav(me).flatMap((g) => g.items.map((i) => i.label));

describe('nav', () => {
  it('shows a seller only their items', () => {
    const seller = meWith(['accounts:read', 'assignments:respond', 'analytics:read', 'offers:read', 'playbooks:read']);
    expect(labels(seller)).toEqual([
      'Overview',
      'My accounts',
      'All accounts',
      'Offers and practices',
      'Playbooks',
      'Funnel by source',
      'Costs',
    ]);
  });

  it('needs both scopes for Sources and either for Batches', () => {
    expect(labels(meWith(['sources:manage']))).toEqual([]);
    expect(labels(meWith(['sources:manage', 'arrivals:read']))).toEqual(['Sources', 'Batches and imports']);
    expect(labels(meWith(['imports:run']))).toEqual(['Batches and imports']);
  });

  it('drops empty groups', () => {
    expect(visibleNav(meWith(['accounts:read'])).map((g) => g.group)).toEqual(['Work']);
  });

  it('shows Admin only to platform admins', () => {
    expect(visibleNav(meWith([])).map((g) => g.group)).not.toContain('Admin');
    expect(labels(meWith([], { user: { id: 'm1', name: 'Dana', email: 'dana@taazaa.com', platform_admin: true } }))).toEqual(['Tenants', 'System health', 'AI runs']);
  });

  it('shows only Admin with no workspace', () => {
    const admin = { user: { id: 'm1', name: 'Sam', email: 'sam@taazaa.com', platform_admin: true }, tenant: null };
    expect(labels(meWith(['accounts:read'], admin))).toEqual(['Tenants', 'System health', 'AI runs']);
  });

  it('lands on the first of Review queue, My accounts, All accounts', () => {
    expect(landingPath(meWith(['accounts:read', 'assignments:respond', 'review:act']))).toBe('/t/$tenant/queue');
    expect(landingPath(meWith(['accounts:read', 'assignments:respond']))).toBe('/t/$tenant/my');
    expect(landingPath(meWith(['accounts:read']))).toBe('/t/$tenant/accounts');
    expect(landingPath(meWith(['offers:read']))).toBeNull();
  });

  it('hides settings tabs without their scope and the redesign tabs', () => {
    expect(visibleSettingsTabs(meWith(['members:read', 'settings:manage', 'scoring:manage'])).map((t) => t.tab)).toEqual([
      'members',
      'review-statuses',
      'ai-runs',
    ]);
  });
});
