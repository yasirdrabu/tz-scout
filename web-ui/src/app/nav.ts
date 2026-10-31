import { hasScope, isPlatformAdmin, type Counts, type Me, type Scope } from '../api/me';

/** Who sees an item: every scope in `all`, or any scope in `any`, or platform admins only. */
export type Rule = { all: Scope[] } | { any: Scope[] } | 'platform-admin';

export type TenantPath =
  | '/t/$tenant/overview'
  | '/t/$tenant/queue'
  | '/t/$tenant/my'
  | '/t/$tenant/accounts'
  | '/t/$tenant/sources'
  | '/t/$tenant/batches'
  | '/t/$tenant/offers'
  | '/t/$tenant/playbooks'
  | '/t/$tenant/funnel'
  | '/t/$tenant/costs';

export type AdminPath = '/admin/tenants' | '/admin/health' | '/admin/ai-runs';

/** A count from `GET /me/counts` shown next to the item, and what it counts. */
export type NavBadge = { count: keyof Counts; label: string };

export type NavItem =
  | { label: string; kind: 'tenant'; to: TenantPath; rule: Rule; badge?: NavBadge }
  | { label: string; kind: 'admin'; to: AdminPath; rule: Rule };

export type NavGroup = { group: string; items: NavItem[] };

/** The sidebar, from the Shell table in docs/spec/web-ui/index.md. Names are the backend's permissions. */
export const NAV: NavGroup[] = [
  {
    group: 'Work',
    items: [
      { label: 'Overview', kind: 'tenant', to: '/t/$tenant/overview', rule: { all: ['analytics:read'] } },
      {
        label: 'Review queue',
        kind: 'tenant',
        to: '/t/$tenant/queue',
        rule: { all: ['review:act'] },
        badge: { count: 'review_queue', label: 'accounts waiting' },
      },
      {
        label: 'My accounts',
        kind: 'tenant',
        to: '/t/$tenant/my',
        rule: { all: ['assignments:respond'] },
        badge: { count: 'new_assignments', label: 'new assignments' },
      },
      { label: 'All accounts', kind: 'tenant', to: '/t/$tenant/accounts', rule: { all: ['accounts:read'] } },
    ],
  },
  {
    group: 'Sources',
    items: [
      { label: 'Sources', kind: 'tenant', to: '/t/$tenant/sources', rule: { all: ['sources:manage', 'arrivals:read'] } },
      { label: 'Batches and imports', kind: 'tenant', to: '/t/$tenant/batches', rule: { any: ['arrivals:read', 'imports:run'] } },
    ],
  },
  {
    group: 'Plan',
    items: [
      { label: 'Offers and practices', kind: 'tenant', to: '/t/$tenant/offers', rule: { all: ['offers:read'] } },
      { label: 'Playbooks', kind: 'tenant', to: '/t/$tenant/playbooks', rule: { all: ['playbooks:read'] } },
    ],
  },
  {
    group: 'Results',
    items: [
      { label: 'Funnel by source', kind: 'tenant', to: '/t/$tenant/funnel', rule: { all: ['analytics:read'] } },
      { label: 'Costs', kind: 'tenant', to: '/t/$tenant/costs', rule: { all: ['analytics:read'] } },
    ],
  },
  {
    group: 'Admin',
    items: [
      { label: 'Tenants', kind: 'admin', to: '/admin/tenants', rule: 'platform-admin' },
      { label: 'System health', kind: 'admin', to: '/admin/health', rule: 'platform-admin' },
      { label: 'AI runs', kind: 'admin', to: '/admin/ai-runs', rule: 'platform-admin' },
    ],
  },
];

/** Settings in the sidebar footer. */
export const SETTINGS_RULE: Rule = {
  any: ['members:read', 'members:manage', 'integrations:manage', 'keys:manage', 'settings:manage', 'scoring:manage', 'audit:read'],
};

export type SettingsTab = { tab: string; label: string; section: string; tag: string; rule: Rule; hidden?: boolean };

/** Settings tabs in order (screens.md §21). Pipeline stages and Scoring weights stay hidden until their redesigns land. */
export const SETTINGS_TABS: SettingsTab[] = [
  { tab: 'members', label: 'Members', section: '21a', tag: 'R1', rule: { any: ['members:read', 'members:manage'] } },
  { tab: 'integrations', label: 'Integrations', section: '21b', tag: 'R1', rule: { all: ['integrations:manage'] } },
  { tab: 'api-keys', label: 'API keys', section: '21c', tag: 'R1', rule: { all: ['keys:manage'] } },
  { tab: 'review-statuses', label: 'Review statuses', section: '21d', tag: 'R1', rule: { all: ['settings:manage'] } },
  { tab: 'pipeline-stages', label: 'Pipeline stages', section: '21e', tag: 'Redesign', rule: { all: ['settings:manage'] }, hidden: true },
  { tab: 'scoring-weights', label: 'Scoring weights', section: '21f', tag: 'Redesign', rule: { all: ['scoring:manage'] }, hidden: true },
  { tab: 'audit-log', label: 'Audit log', section: '21g', tag: 'R1', rule: { all: ['audit:read'] } },
];

export function allows(me: Me, rule: Rule): boolean {
  if (rule === 'platform-admin') return isPlatformAdmin(me);
  if ('all' in rule) return rule.all.every((s) => hasScope(me, s));
  return rule.any.some((s) => hasScope(me, s));
}

/** The groups and items this person may see; empty groups are dropped. Hidden, never disabled (C4). */
export function visibleNav(me: Me): NavGroup[] {
  return NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => allows(me, i.rule)) })).filter((g) => g.items.length > 0);
}

export const visibleSettingsTabs = (me: Me) => SETTINGS_TABS.filter((t) => !t.hidden && allows(me, t.rule));

const LANDING: TenantPath[] = ['/t/$tenant/queue', '/t/$tenant/my', '/t/$tenant/accounts'];

/** The first of Review queue, My accounts, All accounts this person may see, or null. */
export function landingPath(me: Me): TenantPath | null {
  const items = NAV.flatMap((g) => g.items);
  return LANDING.find((to) => items.some((i) => i.to === to && allows(me, i.rule))) ?? null;
}
