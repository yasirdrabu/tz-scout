import { http, HttpResponse } from 'msw';
import { exactly } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { batch, META as BATCH_META } from '../batches/testing';
import type { Feedback, Member, Source, SourceAccount, SourceDetail, SourceKey, SourceStat, SourcesMeta } from './api';

// Fixtures in the API's shapes (snake_case) for the Sources tests. The numbers are ones the browser
// could not derive (C8): the percentages are the API's, not sent / reviewed.

export const OPERATOR = ['arrivals:read', 'sources:manage', 'imports:run', 'accounts:read', 'review:act'];

export const source = (s: Partial<Source> & Pick<Source, 'id' | 'name' | 'kind' | 'kind_label'>): Source => ({
  status: 'active',
  status_label: 'Active',
  parent_id: null,
  parent: null,
  owner: null,
  method: 'none',
  method_label: 'Not sending yet',
  active_key: null,
  created_at: '2026-08-01T12:00:00Z',
  last_sent_at: null,
  has_sent: false,
  arrivals_last_30_days: 0,
  trust: null,
  trust_label: 'Not enough data yet',
  children_count: 0,
  is_new: true,
  can_remove: true,
  can_archive: false,
  ...s,
});

export const MARCUS = source({
  id: 'src_marcus',
  name: 'Marcus Lee',
  kind: 'person',
  kind_label: 'Person',
  owner: { user_id: 'usr_marcus', name: 'Marcus Lee' },
  method: 'api_key',
  method_label: 'API key',
  active_key: { id: 'key_m', prefix: 'scout_live_AbCd1234', last_used_at: null, created_at: '2026-08-02T12:00:00Z' },
  last_sent_at: '2026-10-30T12:00:00Z',
  has_sent: true,
  children_count: 2,
  is_new: false,
  can_remove: false,
  can_archive: false,
});
export const RFP = source({
  id: 'src_rfp',
  name: 'RFP Watch',
  kind: 'agent',
  kind_label: 'Agent',
  parent_id: 'src_marcus',
  parent: { id: 'src_marcus', name: 'Marcus Lee', kind: 'person' },
  owner: { user_id: 'usr_marcus', name: 'Marcus Lee' },
  method: 'through_parent',
  method_label: 'Through Marcus Lee',
  last_sent_at: '2026-10-31T09:00:00Z',
  has_sent: true,
  is_new: false,
  can_remove: false,
  can_archive: true,
});
export const CSV = source({
  id: 'src_csv',
  name: 'CSV imports',
  kind: 'list',
  kind_label: 'List',
  parent_id: 'src_marcus',
  parent: { id: 'src_marcus', name: 'Marcus Lee', kind: 'person' },
  owner: { user_id: 'usr_marcus', name: 'Marcus Lee' },
  method: 'file_upload',
  method_label: 'File upload',
});
export const KESTREL = source({ id: 'src_kestrel', name: 'Kestrel Advisory', kind: 'partner', kind_label: 'Partner', status: 'paused', status_label: 'Paused', is_new: false });
export const HUBSPOT = source({ id: 'src_hub', name: 'HubSpot inbound', kind: 'crm', kind_label: 'CRM', method: 'hubspot_sync', method_label: 'HubSpot sync', has_sent: true, can_remove: false, can_archive: true });

export const SOURCES = [MARCUS, RFP, CSV, KESTREL, HUBSPOT];

export const META: SourcesMeta = {
  counts_by_kind: { person: 1, agent: 1, vendor: 0, list: 1, partner: 1, crm: 1, web_form: 0, scheduled_pull: 0 },
  kind_labels: { person: 'Person', agent: 'Agent', vendor: 'Data vendor', list: 'List', partner: 'Partner', crm: 'CRM', web_form: 'Web form', scheduled_pull: 'Scheduled pull' },
  can_add_crm: false,
};

const stage = (arrived: number, reviewed: number, assigned: number, won: number) => [
  { key: 'arrived', label: 'Arrived', count: arrived },
  { key: 'reviewed', label: 'Reviewed', count: reviewed },
  { key: 'assigned', label: 'Assigned', count: assigned },
  { key: 'engaged', label: 'Engaged', count: 0 },
  { key: 'opportunity', label: 'Opportunity', count: 0 },
  { key: 'won', label: 'Won', count: won },
  { key: 'lost', label: 'Lost', count: 0 },
  { key: 'declined', label: 'Not pursued', count: 0 },
];

export const STATS: SourceStat[] = [
  { source_id: 'src_marcus', sent: 2, reviewed: 1, assigned: 1, won: 0, reviewed_pct: 33, assigned_pct: 71, won_pct: 9, by_stage: stage(1, 0, 1, 0), is_new: false },
  { source_id: 'src_rfp', sent: 41, reviewed: 38, assigned: 19, won: 6, reviewed_pct: 93, assigned_pct: 50, won_pct: 32, by_stage: stage(3, 19, 13, 6), is_new: false },
  { source_id: 'src_csv', sent: 0, reviewed: 0, assigned: 0, won: 0, reviewed_pct: null, assigned_pct: null, won_pct: null, by_stage: stage(0, 0, 0, 0), is_new: true },
];

export const detail = (s: Source, extra: Partial<SourceDetail> = {}): SourceDetail => ({
  breadcrumb: [...(s.parent ? [{ id: s.parent.id, name: s.parent.name }] : []), { id: s.id, name: s.name }],
  daily_arrival_cap: 500,
  initial_review_status_key: 'unvetted',
  sync: null,
  ...s,
  ...extra,
});

export const KEYS: SourceKey[] = [{ id: 'key_m', name: 'Marcus key', prefix: 'scout_live_AbCd1234', mask: 'scout_live_AbCd1234…', created_at: '2026-08-02T12:00:00Z', last_used_at: null, revoked_at: null }];

export const MEMBERS: Member[] = [
  { user_id: 'usr_marcus', name: 'Marcus Lee' },
  { user_id: 'usr_priya', name: 'Priya Raman' },
];

export const FEEDBACK: Feedback[] = [
  { id: 'fb_1', kind: 'sent_back', account_id: 'acc_1', account_name: 'Hollis Freight Lines', summary: 'Sent back by Dana Whitfield: Wrong practice', note: null, created_at: '2026-10-30T12:00:00Z' },
];

export const ACCOUNT_ROW: SourceAccount = {
  account_id: 'acc_hollis',
  name: 'Hollis Freight Lines',
  domain: null,
  industry: 'Logistics',
  hq_city: null,
  hq_state: null,
  priority: 79,
  stage: 'assigned',
  stage_label: 'Assigned',
  owner_user_id: 'usr_ash',
  owner_name: 'Ash Patel',
  practice_name: null,
  lead_offer: { offer_id: 'off_mb', name: 'Modernization Blueprint', practice_id: 'p', practice_name: null, chosen: false },
  source: { source_id: 'src_rfp', name: 'RFP Watch', kind: 'agent', via: 'Marcus Lee' },
  last_activity: null,
  value: null,
  tier: 'act_now',
  tier_label: 'Act now',
  created_at: '2026-10-20T12:00:00Z',
  first_arrival: { at: '2026-10-20T12:00:00Z', batch_id: 'bat_1042', batch_name: 'B-1042', source_id: 'src_rfp', source_name: 'RFP Watch' },
};

/** The Sources screen and Source page answered from fixtures. Returns the request log by method and path. */
export function serveSources(opts: { scopes?: string[]; sources?: Source[]; meta?: Partial<SourcesMeta>; one?: SourceDetail } = {}) {
  const seen: { method: string; url: URL; body: unknown }[] = [];
  const log = async (request: Request) => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined);
    seen.push({ method: request.method, url: new URL(request.url), body });
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? OPERATOR, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const sources = opts.sources ?? SOURCES;
  server.use(
    http.get('/api/v1/sources', async ({ request }) => {
      await log(request);
      const u = new URL(request.url);
      const kinds = u.searchParams.get('kind')?.split(',') ?? [];
      const q = u.searchParams.get('q')?.toLowerCase();
      const data = sources.filter((s) => (!kinds.length || kinds.includes(s.kind)) && (!q || s.name.toLowerCase().includes(q)));
      return HttpResponse.json({ data, next_cursor: null, meta: { ...META, ...opts.meta } });
    }),
    http.get('/api/v1/sources/stats', () => HttpResponse.json({ data: STATS })),
    http.get('/api/v1/sources/:id', ({ params }) => {
      const s = sources.find((x) => x.id === params.id);
      return s ? HttpResponse.json(opts.one && opts.one.id === s.id ? opts.one : detail(s)) : HttpResponse.json({ title: 'Not found.', status: 404 }, { status: 404 });
    }),
    http.get('/api/v1/sources/:id/keys', () => HttpResponse.json({ data: KEYS })),
    http.get('/api/v1/members/directory', () => HttpResponse.json({ data: MEMBERS })),
    http.get('/api/v1/feedback', () => HttpResponse.json({ data: FEEDBACK, next_cursor: null })),
    http.get('/api/v1/accounts', async ({ request }) => {
      await log(request);
      return HttpResponse.json({ data: [ACCOUNT_ROW], next_cursor: null, total: 1 });
    }),
    http.get('/api/v1/accounts/facets', () =>
      HttpResponse.json({
        total: 1,
        won_this_year: 0,
        stages: [{ key: 'assigned', label: 'Assigned', count: 1 }],
        owners: [],
        practices: [],
        sources: [],
        tiers: [{ value: 'act_now', label: 'Act now', count: 1 }],
      }),
    ),
    http.get('/api/v1/batches', () => HttpResponse.json({ data: [batch({ id: 'bat_1042', name: 'Week 44 run', item_count: 18 })], next_cursor: 'c1', total: 7, meta: BATCH_META })),
    http.patch('/api/v1/sources/:id', async ({ request, params }) => {
      await log(request);
      const body = (await request.clone().json()) as Record<string, unknown>;
      const s = sources.find((x) => x.id === params.id)!;
      const owner = 'owner_user_id' in body ? (body.owner_user_id ? { user_id: String(body.owner_user_id), name: MEMBERS.find((m) => m.user_id === body.owner_user_id)?.name ?? '' } : null) : s.owner;
      const status = (body.status as Source['status'] | undefined) ?? s.status;
      return HttpResponse.json(detail({ ...s, owner, status, status_label: status === 'paused' ? 'Paused' : status === 'archived' ? 'Archived' : 'Active' }));
    }),
    http.post(exactly('/api/v1/sources/src_hub:sync'), async ({ request }) => {
      await log(request);
      return HttpResponse.json({ queued: true }, { status: 202 });
    }),
  );
  return seen;
}
