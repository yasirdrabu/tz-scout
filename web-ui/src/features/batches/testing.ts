import { http, HttpResponse } from 'msw';
import { exactly } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Batch, BatchDetail, BatchesMeta, BatchItem, ImportView } from './api';

// Fixtures in the API's shapes (snake_case) for the Batches tests. Counts, statuses and words are the API's (C6 to C8):
// the tests feed numbers the browser could not derive.

export const OPERATOR = ['arrivals:read', 'imports:run', 'sources:manage', 'review:act', 'people:read'];

export const batch = (b: Partial<Batch> & Pick<Batch, 'id'>): Batch => ({
  name: `${b.id}.csv`,
  notes: null,
  run_at: '2026-10-26T12:00:00Z',
  completed_at: null,
  status: 'completed',
  status_key: 'complete',
  status_label: 'Complete',
  issue: null,
  item_count: 0,
  stages: { received: 0, resolving: 0, waiting: 0, resolved: 0, rejected: 0 },
  progress_label: '0 resolved, 0 rejected, 0 waiting',
  source: { id: 'src_csv', name: 'CSV imports', kind: 'list' },
  sent_by: { kind: 'user', id: 'usr_marcus', name: 'Marcus Lee' },
  files: [],
  import: null,
  retryable: 0,
  ...b,
});

export const APTA = batch({
  id: 'bat_1044',
  name: 'apta-2026-attendees.xlsx',
  notes: 'APTA 2026 attendee list',
  status: 'processing',
  status_key: 'needs_attention',
  status_label: 'Needs attention',
  issue: '7 rows need a website, a company or a duplicate check',
  item_count: 64,
  stages: { received: 0, resolving: 0, waiting: 7, resolved: 51, rejected: 6 },
  progress_label: '51 resolved, 6 rejected, 7 waiting',
  files: [{ id: 'fil_apta', file_name: 'apta-2026-attendees.xlsx', size_bytes: 18_000, content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
});
export const CAPPED = batch({
  id: 'bat_1040',
  notes: 'Healthcare payers, Southeast',
  source: { id: 'src_apollo', name: 'Apollo vendor list', kind: 'vendor' },
  status_key: 'needs_attention',
  status_label: 'Needs attention',
  issue: '4 rows hit the daily limit',
  item_count: 45,
  stages: { received: 0, resolving: 0, waiting: 0, resolved: 36, rejected: 9 },
  progress_label: '36 resolved, 9 rejected, 0 waiting',
  retryable: 4,
});
export const RUNNING = batch({
  id: 'bat_1045',
  notes: 'Southeast transit',
  status: 'processing',
  status_key: 'in_progress',
  status_label: 'In progress',
  item_count: 18,
  stages: { received: 5, resolving: 0, waiting: 0, resolved: 13, rejected: 0 },
  progress_label: '13 resolved, 0 rejected, 0 waiting',
});

export const META: BatchesMeta = {
  counts_by_status: { complete: 5, in_progress: 1, needs_attention: 2, failed: 1 },
  status_labels: { complete: 'Complete', in_progress: 'In progress', needs_attention: 'Needs attention', failed: 'Failed' },
  attention: { count: 3, issues: ['Import stopped: This source is paused', '7 rows need a website, a company or a duplicate check'] },
};

export const detail = (b: Batch, extra: Partial<BatchDetail> = {}): BatchDetail => ({ in_queue: 44, ...b, ...extra });

export const item = (i: Partial<BatchItem> & Pick<BatchItem, 'id'>): BatchItem => ({
  status: 'resolved',
  waiting_on: null,
  company_name: null,
  website: null,
  account_id: null,
  account_name: null,
  priority: null,
  tier_label: null,
  outcome: 'new_account',
  outcome_label: 'Resolved: New account',
  duplicate_candidates: [],
  ...i,
});

export const ITEMS: BatchItem[] = [
  item({ id: 'arr_1', company_name: 'Port Authority of Savannah', website: 'savannahport.gov', account_id: 'acc_port', account_name: 'Port Authority of Savannah', priority: 71 }),
  item({ id: 'arr_2', status: 'resolving', waiting_on: 'needs_website', company_name: 'Lakeshore Regional Transit', outcome: 'waiting', outcome_label: 'Waiting: Needs a website' }),
  item({ id: 'arr_3', status: 'resolving', waiting_on: 'needs_company', company_name: null, outcome: 'waiting', outcome_label: 'Waiting: Needs a company' }),
  item({
    id: 'arr_4',
    status: 'resolving',
    waiting_on: 'possible_duplicate',
    company_name: 'Rio Verde Transit',
    outcome: 'waiting',
    outcome_label: 'Waiting: Possible duplicate',
    duplicate_candidates: [{ account_id: 'acc_rio', name: 'Rio Verde Transit District', domain: 'rioverdetransit.gov' }],
  }),
  item({ id: 'arr_5', status: 'rejected', company_name: 'Rio Verde Transit 2', outcome: 'rejected', outcome_label: 'Rejected: Duplicate of another row in this batch' }),
];

export const IMPORT: ImportView = {
  id: 'imp_1',
  batch_id: 'bat_1044',
  status: 'needs_confirm',
  layout: null,
  headers: ['Org Name', 'URL', 'Badge ID'],
  row_count: 64,
  mapping: [
    { header: 'Org Name', target: 'account.name', confidence: 0.9 },
    { header: 'URL', target: 'account.website', confidence: 0.9 },
    { header: 'Badge ID', target: null, confidence: 0 },
  ],
  mapping_origin: 'synonyms',
  file: { name: 'apta-2026-attendees.xlsx', type: 'Excel', size_bytes: 18_000, sheet: 'Sheet 1' },
  sample_rows: [
    ['Port Authority of Savannah', 'savannahport.gov', 'B1'],
    ['Lakeshore Regional Transit', '', 'B2'],
    ['Metro Bayfront Rail', 'bayfrontrail.org', 'B3'],
    ['Never shown', 'x.org', 'B4'],
  ],
  targets: [
    { key: 'account.name', label: 'Company name' },
    { key: 'account.website', label: 'Website' },
    { key: 'account.notes', label: 'Notes' },
    { key: null, label: "Don't import" },
  ],
  uploaded_by: { user_id: 'usr_marcus', name: 'Marcus Lee' },
  source: { id: 'src_csv', name: 'CSV imports', kind: 'list' },
  notes: 'APTA 2026 attendee list',
  suggested_count: 2,
  stats: { error: null },
};

type Seen = { method: string; url: URL; body: unknown };

/** The batch screens answered from fixtures. Returns the request log. */
export function serveBatches(opts: { scopes?: string[]; batches?: Batch[]; meta?: Partial<BatchesMeta>; total?: number; one?: BatchDetail; items?: BatchItem[] } = {}) {
  const seen: Seen[] = [];
  const log = async (request: Request) => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined);
    seen.push({ method: request.method, url: new URL(request.url), body });
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? OPERATOR, source_id: 'src_marcus', tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const batches = opts.batches ?? [APTA, CAPPED];
  const items = opts.items ?? ITEMS;
  server.use(
    http.get('/api/v1/batches', async ({ request }) => {
      await log(request);
      return HttpResponse.json({ data: batches, next_cursor: null, total: opts.total ?? batches.length, meta: { ...META, ...opts.meta } });
    }),
    http.get('/api/v1/batches/:id', ({ params }) => {
      const b = batches.find((x) => x.id === params.id);
      return b ? HttpResponse.json(opts.one ?? detail(b)) : HttpResponse.json({ title: 'Not found.', status: 404 }, { status: 404 });
    }),
    http.get('/api/v1/batches/:id/items', async ({ request }) => {
      await log(request);
      const tab = new URL(request.url).searchParams.get('status');
      const data = items.filter((i) => tab === 'all' || (tab === 'waiting' ? i.outcome === 'waiting' : tab === 'rejected' ? i.outcome === 'rejected' : i.status === 'resolved'));
      return HttpResponse.json({ data, next_cursor: null, total: data.length });
    }),
    http.get('/api/v1/sources', () =>
      HttpResponse.json({
        data: [
          { id: 'src_marcus', name: 'Marcus Lee', kind: 'person', kind_label: 'Person', status: 'active' },
          { id: 'src_csv', name: 'CSV imports', kind: 'list', kind_label: 'List', status: 'active' },
          { id: 'src_kestrel', name: 'Kestrel Advisory', kind: 'partner', kind_label: 'Partner', status: 'active' },
        ],
        next_cursor: null,
        meta: { counts_by_kind: {}, kind_labels: {}, can_add_crm: false },
      }),
    ),
    http.get('/api/v1/members/directory', () => HttpResponse.json({ data: [{ user_id: 'usr_marcus', name: 'Marcus Lee' }, { user_id: 'usr_ash', name: 'Ash Patel' }] })),
    http.post(/\/api\/v1\/batches\/[^/]+:retry$/, async ({ request }) => {
      await log(request);
      return HttpResponse.json({ retried: 4 }, { status: 202 });
    }),
    http.post(exactly('/api/v1/batches/bat_1044:skip-waiting'), async ({ request }) => {
      await log(request);
      return HttpResponse.json({ skipped: 3 });
    }),
    http.post(/\/api\/v1\/arrivals\/[^/]+:(supply-website|supply-company|choose)$/, async ({ request }) => {
      await log(request);
      return HttpResponse.json({ id: 'arr', status: 'resolving' });
    }),
  );
  return seen;
}
