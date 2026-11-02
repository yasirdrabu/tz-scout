import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { AccountReview } from '../review/api';
import { LEADER, REASONS, SELLERS, STATUSES } from '../review/testing';
import type { StagesView } from '../settings/stages/api';
import type { AccountDetail, AccountScore, Brief, BriefSection, CrmCheck, Fact, Handoffs } from './api';

// Fixtures in the API's shapes (snake_case), for the account page's tests.

export const PAGE_LEADER = [...LEADER, 'playbooks:read', 'playbooks:write', 'people:read', 'people:write'];
export const SELLER = ['accounts:read', 'assignments:respond', 'playbooks:read', 'playbooks:write', 'people:read', 'people:write'];

export const ACCOUNT: AccountDetail = {
  id: 'acc_mdc',
  name: 'Miami-Dade County DTPW',
  domain: 'miamidade.gov',
  industry: 'Public agency',
  hq_city: 'Miami',
  hq_state: 'FL',
  people: [
    {
      id: 'per_jr',
      first_name: 'Jarice',
      last_name: 'Rodriguez',
      title: 'Deputy Director, Transit Operations',
      is_primary: true,
      decision_note: 'Warm intro through Ash Patel',
      roles: [{ key: 'business_owner', origin: 'stated', label: 'Business owner' }],
    },
  ],
  signals: [
    { id: 'sig_1', type: 'company_event', kind: 'trigger', title: 'RFP re-issue expected in December', detail: null, url: 'https://www.miamidade.gov/procurement/notice', occurred_at: '2026-10-14T12:00:00Z', source_name: 'RFP Watch' },
    { id: 'sig_0', type: 'research', kind: 'research', title: 'Undated research', detail: null, url: null, occurred_at: null, source_name: null },
    { id: 'sig_2', type: 'funding', kind: 'trigger', title: 'FY2027 budget adds $3.2M for DTPW tech modernization', detail: null, url: 'https://www.govspend.com/budget', occurred_at: '2026-09-18T12:00:00Z', source_name: null },
  ],
};

export const REVIEW: AccountReview = {
  account_id: 'acc_mdc',
  status: { key: 'unvetted', label: 'Ready for review', color: 'plum', set_by: 'scout', changed_at: '2026-10-24T14:00:00Z', changed_by_name: null },
  stage: 'arrived',
  stage_label: 'Arrived',
  stages: [
    { key: 'arrived', label: 'Arrived', at: '2026-10-24T14:00:00Z', current: true },
    { key: 'reviewed', label: 'Reviewed', at: null, current: false },
    { key: 'assigned', label: 'Assigned', at: null, current: false },
    { key: 'engaged', label: 'Engaged', at: null, current: false },
    { key: 'opportunity', label: 'Opportunity', at: null, current: false },
    { key: 'won', label: 'Won', at: null, current: false },
  ],
  flags: {},
  current_assignment: null,
  approved: null,
  sources: [{ source_id: 'src_rfp', name: 'RFP Watch', kind: 'agent', via: 'Marcus Lee · GovSpend', owner_user_id: 'usr_marcus', owner_name: 'Marcus Lee', batch_id: 'B-1042', arrived_at: '2026-10-24T14:00:00Z' }],
  lead_offer: { offer_id: 'off_mb', name: 'Modernization Blueprint', practice_id: 'prc_data', practice_name: 'Data and Engineering for AI Readiness', chosen: false },
  version: 3,
};

/** The review after Dana assigned the account to Ash. */
export const ASSIGNED: AccountReview = {
  ...REVIEW,
  status: { key: 'reviewed', label: 'Approved', color: 'green', set_by: 'reviewer', changed_at: '2026-10-26T10:00:00Z', changed_by_name: 'Dana Whitfield' },
  stage: 'assigned',
  stage_label: 'Assigned',
  stages: REVIEW.stages!.map((s) =>
    s.key === 'arrived' ? { ...s, current: false } : s.key === 'reviewed' ? { ...s, at: '2026-10-26T10:00:00Z' } : s.key === 'assigned' ? { ...s, at: '2026-10-26T10:00:00Z', current: true } : s,
  ),
  flags: { handoff: { handoff_id: 'hnd_1', state: 'sending', at: '2026-10-26T10:00:00Z' } },
  current_assignment: {
    id: 'asg_1',
    seller_user_id: 'usr_ash',
    seller_name: 'Ash Patel',
    assigned_by_name: 'Dana Whitfield',
    assigned_at: '2026-10-26T10:00:00Z',
    notes: 'Jarice knows you from APTA.',
    status: 'pending',
    accepted_how: null,
    responded_at: null,
  },
  approved: { by_name: 'Dana Whitfield', at: '2026-10-26T10:00:00Z' },
  version: 4,
};

export const SCORE: AccountScore = {
  tiles: [
    { key: 'priority', label: 'Priority', value: 79, max: 100, note: 'Act now needs a priority of 75, fit 60 and buying intent 50.' },
    { key: 'fit', label: 'Fit', value: 85, max: 100, note: 'County transit agency with 3,000+ staff' },
    { key: 'intent', label: 'Buying intent', value: 70, max: 100, note: 'RFP re-issue expected in December' },
    { key: 'revenue_potential', label: 'Revenue potential', value: null, max: null, note: 'Arrives with enrichment' },
    { key: 'source_trust', label: 'Source trust', value: null, max: null, note: 'Not enough data yet' },
  ],
  warm_intro: { introducer_name: 'Ash Patel', points: 8 },
};

export const FACTS: Fact[] = [
  { id: 'fct_1', person_id: null, key: 'employees', label: 'Staff', value: 3800, observed_at: '2026-09-01T12:00:00Z', source_names: { person: 'Marcus Lee', agent: 'RFP Watch', vendor: 'GovSpend' } },
  { id: 'fct_2', person_id: null, key: 'buying_process', label: 'Buying process', value: 'Formal RFP with Board approval', observed_at: '2026-10-01T12:00:00Z', source_names: { person: null, agent: 'RFP Watch', vendor: null } },
  { id: 'fct_3', person_id: 'per_jr', key: 'email', label: 'Email', value: 'jr@miamidade.gov', observed_at: '2026-10-01T12:00:00Z', source_names: { person: null, agent: null, vendor: null } },
];

const section = (s: Partial<BriefSection> & Pick<BriefSection, 'key' | 'title'>): BriefSection => ({
  body: `${s.title} text.`,
  citations: [],
  written_by: 'claude',
  label: 'Written by Claude',
  edited_by_name: null,
  edited_at: null,
  written_for_offer_name: null,
  version: 1,
  ...s,
});

export const BRIEF: Brief = {
  account_id: 'acc_mdc',
  offer_id: 'off_mb',
  offer_name: 'Modernization Blueprint',
  state: 'ready',
  last_drafted_at: '2026-10-24T18:02:00Z',
  recommendation: {
    headline: 'Approve and assign to someone who covers Data and Engineering for AI Readiness.',
    detail: 'The cancelled transit software RFP is being re-issued in December.',
    written_by: 'claude',
    label: 'Written by Claude',
  },
  sections: [
    section({ key: 'overview', title: 'Overview', body: 'Miami-Dade County runs the transit system. It has 3,800 staff.', version: 2 }),
    section({ key: 'approach', title: 'Approach', written_by: 'person', label: 'Edited by Dana Ruiz', edited_by_name: 'Dana Ruiz', edited_at: '2026-10-25T10:00:00Z', written_for_offer_name: 'AI Opportunity Map' }),
    section({ key: 'value_angle', title: 'Value angle', written_by: 'rules', label: 'Assembled from rules' }),
    section({ key: 'risks', title: 'Risks' }),
  ],
};

export const EMPTY_BRIEF: Brief = {
  ...BRIEF,
  state: 'not_drafted',
  last_drafted_at: null,
  recommendation: null,
  sections: BRIEF.sections.map((s) => ({ ...s, body: null, written_by: null, label: null, version: null, written_for_offer_name: null })),
};

export const CRM_NEW: CrmCheck = { exists: false, owner_name: null, lifecycle: 'none', open_deals: 0, open_deal: null, checked_at: '2026-10-24T14:00:00Z', hubspot_url: null };

export const HANDOFFS: Handoffs = {
  handoffs: [{ id: 'hnd_1', status: 'completed', crm_url: 'https://app.hubspot.com/contacts/1/record/0-2/99', queued_at: '2026-10-26T10:00:00Z', completed_at: '2026-10-27T09:00:00Z' }],
  follow_through: { counts: { emails: 9, replies: 3 }, checked_at: '2026-10-31T09:58:00Z' },
  deals: [],
  conflict: false,
};

/** The queue's second row (Coastline) as a page the tests can step to. */
export function serveCoastline() {
  server.use(
    http.get('/api/v1/accounts/acc_ccu', () => HttpResponse.json({ ...ACCOUNT, id: 'acc_ccu', name: 'Coastline Credit Union', people: [], signals: [] })),
    http.get('/api/v1/accounts/acc_ccu/review', () => HttpResponse.json({ ...REVIEW, account_id: 'acc_ccu' })),
    http.get(/\/api\/v1\/accounts\/acc_ccu\/(score|brief|facts|crm-check|notes)$/, () => problem(404, 'That account was not found.')),
  );
}

const T = (trigger: string) => ({ trigger, trigger_label: trigger });
const STAGE = { description: null, hubspot_stage: null, quarter_target: null, locked: null, kind: 'flow' as const };

/** The workspace's default stages, as `GET /stages` answers them. */
export const STAGES: StagesView = {
  stages: [
    { ...STAGE, ...T('source_creates'), key: 'arrived', name: 'Arrived', position: 0, locked: 'first' },
    { ...STAGE, ...T('reviewer_sets_tier'), key: 'reviewed', name: 'Reviewed', position: 1 },
    { ...STAGE, ...T('ae_accepts'), key: 'assigned', name: 'Assigned', position: 2 },
    { ...STAGE, ...T('reply_or_meeting'), key: 'engaged', name: 'Engaged', position: 3 },
    { ...STAGE, ...T('deal_created'), key: 'opportunity', name: 'Opportunity', position: 4 },
    { ...STAGE, ...T('deal_closed_won'), key: 'won', name: 'Won', position: 5, locked: 'won' },
    { ...STAGE, ...T('reviewer_rejects'), key: 'declined', name: 'Disqualified', position: 0, kind: 'exit' },
  ],
  defaults: [],
  triggers: [],
};

export type Served = {
  scopes?: string[];
  account?: AccountDetail;
  review?: AccountReview;
  score?: AccountScore | null;
  facts?: Fact[];
  brief?: Brief;
  crm?: CrmCheck;
  handoffs?: Handoffs;
  stages?: StagesView;
};

/** Everything the account page reads, answered; returns the request bodies seen per path. */
export function serveAccount(opts: Served = {}) {
  const sent: Record<string, unknown[]> = {};
  const note = async (req: Request) => {
    const u = new URL(req.url);
    const text = await req.text();
    (sent[u.pathname] ??= []).push(text ? JSON.parse(text) : null);
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? PAGE_LEADER, user: { id: 'usr_zach', name: 'Zach Wiant', email: 'zach@taazaa.com' } } });
  server.use(
    http.get('/api/v1/stages', () => HttpResponse.json(opts.stages ?? STAGES)),
    http.get('/api/v1/accounts/acc_mdc', () => HttpResponse.json(opts.account ?? ACCOUNT)),
    http.get('/api/v1/accounts/acc_mdc/review', () => HttpResponse.json(opts.review ?? REVIEW)),
    http.get('/api/v1/accounts/acc_mdc/score', () =>
      opts.score === null
        ? HttpResponse.json({ type: 'x/not-found', title: 'That account was not found.', status: 404 }, { status: 404, headers: { 'content-type': 'application/problem+json' } })
        : HttpResponse.json(opts.score ?? SCORE),
    ),
    http.get('/api/v1/accounts/acc_mdc/facts', () => HttpResponse.json({ data: opts.facts ?? FACTS, next_cursor: null })),
    http.get('/api/v1/accounts/acc_mdc/brief', () => HttpResponse.json(opts.brief ?? BRIEF)),
    http.get('/api/v1/accounts/acc_mdc/notes', () => HttpResponse.json({ data: [], total: 0 })),
    http.get('/api/v1/accounts/acc_mdc/crm-check', () => HttpResponse.json(opts.crm ?? CRM_NEW)),
    http.get('/api/v1/accounts/acc_mdc/handoffs', () => HttpResponse.json(opts.handoffs ?? HANDOFFS)),
    http.get('/api/v1/accounts/acc_mdc/activity', () => HttpResponse.json({ data: [], next_cursor: null, synced_at: null })),
    http.get('/api/v1/buying-roles', () => HttpResponse.json({ data: [{ key: 'business_owner', label: 'Business owner' }, { key: 'technical_buyer', label: 'Technical buyer' }] })),
    http.get('/api/v1/settings/review/statuses', () => HttpResponse.json({ data: STATUSES })),
    http.get('/api/v1/settings/review/reasons', () => HttpResponse.json({ data: REASONS })),
    http.get('/api/v1/assignable-sellers', () => HttpResponse.json(SELLERS)),
    http.post(exactly('/api/v1/accounts/acc_mdc:assign-preview'), () => HttpResponse.json({ preflight: { result: 'new', message: 'New in the CRM' }, approves_to: null, replaces: null })),
    http.put('/api/v1/accounts/acc_mdc/brief/sections/:key', async ({ request }) => {
      await note(request);
      return HttpResponse.json({});
    }),
  );
  return { sent, note };
}
