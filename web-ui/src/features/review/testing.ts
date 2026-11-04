import { http, HttpResponse } from 'msw';
import { exactly } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Columns, LastRescore, QueueFacets, QueueRow, Reason, RescoreRun, ReviewStatus, Sellers } from './api';

// Fixtures in the API's shapes (snake_case), for the review screens' tests.

export const row = (r: Partial<QueueRow> & Pick<QueueRow, 'account_id' | 'name'>): QueueRow => ({
  domain: 'miamidade.gov',
  industry: 'Public agency',
  hq_city: 'Miami',
  hq_state: 'FL',
  tier: 'act_now',
  priority: 79,
  fit: 85,
  intent: 70,
  best_offer_id: 'off_mb',
  practice_id: 'prc_data',
  practice_name: 'Data and Engineering for AI Readiness',
  review_status_key: 'unvetted',
  review_status_label: 'Ready for review',
  review_status_color: 'plum',
  status_changed_at: null,
  status_changed_by_name: null,
  stage: 'arrived',
  created_at: '2026-10-24T14:00:00Z',
  flags: {},
  conflict_count: 0,
  enrichment_requested: false,
  enrichment_requested_by: null,
  source: { source_id: 'src_rfp', name: 'RFP Watch', kind: 'agent', via: 'Marcus Lee · GovSpend' },
  lead_offer: { offer_id: 'off_mb', name: 'Modernization Blueprint', practice_id: 'prc_data', practice_name: 'Data and Engineering for AI Readiness', chosen: false },
  previous_tier: null,
  scored_tier: 'act_now',
  tier_set_by_name: null,
  tier_set_at: null,
  tier_note: null,
  warm_intro: null,
  note_count: 0,
  ...r,
});

export const MIAMI = row({ account_id: 'acc_mdc', name: 'Miami-Dade County DTPW', warm_intro: { introducer_name: 'Kestrel', points: 8 }, note_count: 1 });
export const COASTLINE = row({
  account_id: 'acc_ccu',
  name: 'Coastline Credit Union',
  industry: 'Credit union',
  hq_city: 'Norfolk',
  hq_state: 'VA',
  domain: 'coastlinecu.org',
  priority: 77,
  status_changed_by_name: 'Dana Whitfield',
  review_status_key: 'needs_review',
  review_status_label: 'In review',
  review_status_color: 'amber',
  flags: { declined_by_seller: { assignment_id: 'asg_1', seller_user_id: 'usr_ash', seller_name: 'Ash Patel', reason_key: 'territory', reason_label: 'Outside my territory', at: '2026-10-25T10:00:00Z' } },
});
export const PINEGATE = row({
  account_id: 'acc_pgu',
  name: 'Pinegate University',
  tier: 'watch',
  scored_tier: 'good_fit',
  tier_set_by_name: 'Dana Whitfield',
  tier_set_at: '2026-10-25T10:00:00Z',
  priority: 55,
  industry: 'Higher education',
  hq_city: 'Raleigh',
  hq_state: 'NC',
  domain: 'pinegate.edu',
});

export const FACETS: QueueFacets = {
  total: 3,
  total_all_tiers: 3,
  source_count: 1,
  oldest_arrived_at: '2026-10-20T10:00:00Z',
  last_reviewed_at: '2026-10-31T09:14:00Z',
  tiers: [
    { value: 'act_now', label: 'Act now', count: 2 },
    { value: 'good_fit', label: 'Good fit', count: 0 },
    { value: 'watch', label: 'Watch', count: 1 },
    { value: 'not_fit', label: 'Not a fit', count: 0 },
  ],
  practices: [{ value: 'prc_data', label: 'Data and Engineering for AI Readiness', count: 3 }],
  offers: [{ value: 'off_mb', label: 'Modernization Blueprint', count: 3 }],
  sources: [{ value: 'src_rfp', label: 'RFP Watch', count: 3 }],
  statuses: [
    { value: 'unvetted', label: 'Ready for review', color: 'plum', count: 2 },
    { value: 'needs_review', label: 'In review', color: 'amber', count: 1 },
    { value: 'sent_back', label: 'Sent back to source', color: 'gray', count: 4 },
  ],
};

const col = (key: string, label: string, visible: boolean) => ({ key, label, visible });
export const COLUMNS: Columns = {
  columns: [
    col('best_offer', 'Best offer', true),
    col('priority', 'Priority', true),
    col('tier', 'Tier', true),
    col('source', 'Source', true),
    col('review_status', 'Review status', true),
    col('flags', 'Flags', true),
    col('notes', 'Notes', true),
    col('practice', 'Practice', false),
    col('fit', 'Fit', false),
    col('intent', 'Buying intent', false),
    col('arrived', 'Arrived', false),
  ],
  shown: 8,
  total: 12,
  is_default: true,
};

const status = (s: Partial<ReviewStatus> & Pick<ReviewStatus, 'key' | 'label' | 'color'>): ReviewStatus => ({
  description: null,
  set_by: 'reviewer',
  is_declined: false,
  is_initial: false,
  returns_to_source: false,
  counts_as_reviewed: false,
  archived: false,
  ...s,
});

export const STATUSES: ReviewStatus[] = [
  status({ key: 'unvetted', label: 'Ready for review', color: 'plum', set_by: 'scout', is_initial: true }),
  status({ key: 'needs_review', label: 'In review', color: 'amber' }),
  status({ key: 'reviewed', label: 'Approved', color: 'green', counts_as_reviewed: true }),
  status({ key: 'declined', label: 'Not pursued', color: 'red', is_declined: true, counts_as_reviewed: true }),
  status({ key: 'sent_back', label: 'Sent back to source', color: 'gray', returns_to_source: true, counts_as_reviewed: true }),
];

export const REASONS: Reason[] = [
  { key: 'not_our_kind_of_customer', label: 'Not our kind of customer', applies_to: 'send_back', note_required: false, archived: false },
  { key: 'bad_contact', label: 'Bad or missing contact', applies_to: 'send_back', note_required: true, archived: false },
  { key: 'old_send_back', label: 'Old reason', applies_to: 'send_back', note_required: false, archived: true },
  { key: 'existing_customer', label: 'Already a customer', applies_to: 'review', note_required: false, archived: false },
  { key: 'territory', label: 'Outside my territory or segment', applies_to: 'assignment', note_required: false, archived: false },
  { key: 'other', label: 'Something else', applies_to: 'both', note_required: true, archived: false },
];

export const SELLERS: Sellers = {
  data: [
    { user_id: 'usr_ash', name: 'Ash Patel', practices: [{ id: 'prc_data', name: 'Data and Engineering for AI Readiness' }], all_practices: false, active_accounts: 4, crm_owner_linked: true },
    { user_id: 'usr_maya', name: 'Maya Chen', practices: [], all_practices: true, active_accounts: 12, crm_owner_linked: true },
    { user_id: 'usr_jo', name: 'Jordan Ellis', practices: [], all_practices: false, active_accounts: 2, crm_owner_linked: false },
  ],
  best_match: { user_id: 'usr_ash', reason: 'Covers Data and Engineering for AI Readiness and has the fewest active accounts (4).' },
};

export const LEADER = ['review:act', 'assign:act', 'accounts:read', 'offers:read', 'imports:run', 'sources:manage', 'members:manage', 'crm:push'];

export const NEW_PREFLIGHT = { result: 'new', message: 'New in the CRM', reason: null, current_owner_name: null, deal: null } as const;

/** Everything the queue screen reads, answered; returns the request URLs seen per path. */
export const RESCORE: LastRescore = {
  version: 7,
  changed_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  changed_by_name: 'Zach Wiant',
  summary: 'Scoring settings changed',
  weights_text: 'Fit 60%, buying intent 40%',
  tier_changed_count: 12,
};

export function serveQueue(
  opts: { rows?: QueueRow[]; facets?: QueueFacets; scopes?: string[]; rescore?: LastRescore | null; run?: RescoreRun | null } = {},
) {
  const seen: Record<string, URL[]> = {};
  const note = (req: Request) => {
    const u = new URL(req.url);
    (seen[u.pathname] ??= []).push(u);
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? LEADER } });
  server.use(
    http.get('/api/v1/review-queue', ({ request }) => {
      note(request);
      return HttpResponse.json({ data: opts.rows ?? [MIAMI, COASTLINE, PINEGATE], next_cursor: null });
    }),
    http.get('/api/v1/review-queue/facets', ({ request }) => {
      note(request);
      return HttpResponse.json(opts.facets ?? FACETS);
    }),
    http.get('/api/v1/scoring/last-rescore', ({ request }) => {
      note(request);
      return HttpResponse.json({ data: opts.rescore ?? null });
    }),
    http.get('/api/v1/scoring/rescores/latest', ({ request }) => {
      note(request);
      return HttpResponse.json({ data: opts.run ?? null });
    }),
    http.get('/api/v1/me/preferences/review-queue-columns', () => HttpResponse.json(COLUMNS)),
    http.get('/api/v1/settings/review/statuses', () => HttpResponse.json({ data: STATUSES })),
    http.get('/api/v1/settings/review/reasons', () => HttpResponse.json({ data: REASONS })),
    http.get('/api/v1/offers', () =>
      HttpResponse.json({
        data: [
          { id: 'off_mb', name: 'Modernization Blueprint', practice_id: 'prc_data', status: 'approved' },
          { id: 'off_aom', name: 'AI Opportunity Map', practice_id: 'prc_ai', status: 'approved' },
        ],
        next_cursor: null,
      }),
    ),
    http.get('/api/v1/accounts/:id', ({ params }) => HttpResponse.json({ id: params.id, signals: [] })),
    http.get('/api/v1/accounts/:id/notes', () => HttpResponse.json({ data: [], total: 0 })),
    http.get('/api/v1/accounts/:id/changes', () => HttpResponse.json({ data: [], next_cursor: null })),
    http.get('/api/v1/accounts/:id/review', ({ params }) =>
      HttpResponse.json({
        account_id: params.id,
        status: null,
        stage: 'arrived',
        stage_label: 'Arrived',
        sources: [{ source_id: 'src_rfp', name: 'RFP Watch', kind: 'agent', via: null, owner_user_id: 'usr_marcus', owner_name: 'Marcus Lee', arrived_at: null }],
        version: 1,
      }),
    ),
    http.get('/api/v1/assignable-sellers', () => HttpResponse.json(SELLERS)),
    http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () => HttpResponse.json({ preflight: NEW_PREFLIGHT, approves_to: null, replaces: null })),
  );
  return seen;
}
