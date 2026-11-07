import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { pickStrings } from '../lib/search';
import { tenantRoute } from './tenant';

/**
 * The queue's tier, filters (`status` keys comma separated) and the account open in the peek drawer, so
 * a link or a reload keeps the place (C10).
 */
export type QueueSearch = { tier?: string; practice?: string; offer?: string; source?: string; status?: string; peek?: string };

export const queueRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'queue',
  validateSearch: (search: Record<string, unknown>): QueueSearch => pickStrings(search, ['tier', 'practice', 'offer', 'source', 'status', 'peek']),
  component: lazyRouteComponent(() => import('../features/review/QueueScreen'), 'QueueScreen'),
});

export const myRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'my',
  component: lazyRouteComponent(() => import('../features/accounts/MyAccountsScreen'), 'MyAccountsScreen'),
});

export const enrichmentRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'enrichment',
  component: lazyRouteComponent(() => import('../features/enrichment/RequestsScreen'), 'RequestsScreen'),
});

/** All accounts' stage tab, search and filters (`owner` is a user id or `unassigned`), so the URL keeps them (C10). */
export type AccountsSearch = { stage?: string; q?: string; owner?: string; practice?: string; source?: string; offer?: string };

export const accountsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'accounts',
  validateSearch: (search: Record<string, unknown>): AccountsSearch => pickStrings(search, ['stage', 'q', 'owner', 'practice', 'source', 'offer']),
  component: lazyRouteComponent(() => import('../features/accounts/AllAccountsScreen'), 'AllAccountsScreen'),
});

/** Where the account page was opened from, for its breadcrumb; from the queue also the queue's filters, for `{i} of {n}` (C10). */
export type AccountSearch = { from?: 'queue' | 'my' | 'all'; tier?: string; practice?: string; offer?: string; source?: string; status?: string };

const FROM = ['queue', 'my', 'all'] as const;

export const accountRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'accounts/$id',
  validateSearch: (search: Record<string, unknown>): AccountSearch => {
    const from = FROM.find((f) => f === search.from);
    return { ...(from ? { from } : {}), ...(from === 'queue' ? pickStrings(search, ['tier', 'practice', 'offer', 'source', 'status']) : {}) };
  },
  component: lazyRouteComponent(() => import('../features/account/AccountPage'), 'AccountPage'),
});

/** The scorecard tab (`sellers`, `offers` or `practices`), so a link or a reload keeps it. */
export type OverviewSearch = { tab?: string };

export const overviewRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'overview',
  validateSearch: (search: Record<string, unknown>): OverviewSearch => pickStrings(search, ['tab']),
  component: lazyRouteComponent(() => import('../features/overview/OverviewScreen'), 'OverviewScreen'),
});

/** Sources' Type filter (`kind` comma separated), Trust filter (`trust`) and search, so the URL keeps them (C10). */
export type SourcesSearch = { kind?: string; q?: string; trust?: string };

export const sourcesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'sources',
  validateSearch: (search: Record<string, unknown>): SourcesSearch => pickStrings(search, ['kind', 'q', 'trust']),
  component: lazyRouteComponent(() => import('../features/sources/SourcesScreen'), 'SourcesScreen'),
});

/** The Source page's Accounts tab search and filters (C10). */
export type SourcePageSearch = { q?: string; stage?: string; tier?: string };
const sourcePageSearch = (search: Record<string, unknown>): SourcePageSearch => pickStrings(search, ['q', 'stage', 'tier']);

/** The Source page, on its Overview tab. */
export const sourceRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'sources/$id',
  validateSearch: sourcePageSearch,
  component: lazyRouteComponent(() => import('../features/sources/SourcePage'), 'SourcePage'),
});

/** The Source page on one tab: overview, accounts, batches, runs or pulls-from, settings. */
export const sourceTabRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'sources/$id/$tab',
  validateSearch: sourcePageSearch,
  component: lazyRouteComponent(() => import('../features/sources/SourcePage'), 'SourcePage'),
});

/** Batches' filters (`status` keys comma separated, `runDate` 7, 14 or 30 days) and search, so the URL keeps them (C10). */
export type BatchesSearch = { status?: string; source?: string; sentBy?: string; runDate?: string; q?: string };

export const batchesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'batches',
  validateSearch: (search: Record<string, unknown>): BatchesSearch => pickStrings(search, ['status', 'source', 'sentBy', 'runDate', 'q']),
  component: lazyRouteComponent(() => import('../features/batches/BatchesScreen'), 'BatchesScreen'),
});

/** Import a list (§15): the step, the import and the source it credits (`source`), so a reload keeps the place (C10). */
export type ImportSearch = { step?: string; import?: string; source?: string };

export const batchesImportRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'batches/import',
  validateSearch: (search: Record<string, unknown>): ImportSearch => pickStrings(search, ['step', 'import', 'source']),
  component: lazyRouteComponent(() => import('../features/batches/import/ImportScreen'), 'ImportScreen'),
});

/** Batch detail (§14) on one tab: all, waiting, resolved or rejected (C10). */
export const batchRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'batches/$id',
  validateSearch: (search: Record<string, unknown>): { tab?: string } => pickStrings(search, ['tab']),
  component: lazyRouteComponent(() => import('../features/batches/BatchDetail'), 'BatchDetail'),
});

/**
 * Offers and practices (§19): the practice and offer in the path, and the open form in `edit`
 * (`offer`, `practice`, `new-offer` or `new-practice`), with the section to start at (`field`) and the
 * offer a new one copies (`copy`, Duplicate), so a link or a reload keeps the place (C10).
 */
export type OffersSearch = { edit?: string; field?: string; copy?: string };
const offersSearch = (search: Record<string, unknown>): OffersSearch => pickStrings(search, ['edit', 'field', 'copy']);
const OffersScreen = lazyRouteComponent(() => import('../features/offers/OffersScreen'), 'OffersScreen');

export const offersRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'offers',
  validateSearch: offersSearch,
  component: OffersScreen,
});

export const practiceRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'offers/$practiceId',
  validateSearch: offersSearch,
  component: OffersScreen,
});

export const offerRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'offers/$practiceId/$offerId',
  validateSearch: offersSearch,
  component: OffersScreen,
});

/** Playbooks (§20): the open form in `edit` (`new` or `playbook`), so a link or a reload keeps the place (C10). */
export type PlaybooksSearch = { edit?: string; assign?: string };
const playbooksSearch = (search: Record<string, unknown>): PlaybooksSearch => pickStrings(search, ['edit', 'assign']);

export const playbooksRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'playbooks',
  validateSearch: playbooksSearch,
  component: lazyRouteComponent(() => import('../features/playbooks/PlaybooksScreen'), 'PlaybooksScreen'),
});

export const playbookRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'playbooks/$id',
  validateSearch: playbooksSearch,
  component: lazyRouteComponent(() => import('../features/playbooks/PlaybooksScreen'), 'PlaybookScreen'),
});

/** Funnel by source's filters, so the URL keeps them (C10). */
export type FunnelSearch = { practice?: string; offer?: string; batch?: string; period?: string };
const funnelSearch = (search: Record<string, unknown>): FunnelSearch => pickStrings(search, ['practice', 'offer', 'batch', 'period']);

export const funnelRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'funnel',
  validateSearch: funnelSearch,
  component: lazyRouteComponent(() => import('../features/funnel/FunnelScreen'), 'FunnelScreen'),
});

export const funnelDrillRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'funnel/$sourceId',
  validateSearch: funnelSearch,
  component: lazyRouteComponent(() => import('../features/funnel/DrillScreen'), 'DrillScreen'),
});

export const costsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'costs',
  component: lazyRouteComponent(() => import('../features/costs/CostsScreen'), 'CostsScreen'),
});
