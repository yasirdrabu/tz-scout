import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { ASSESS, AI, BLUEPRINT, BUYING_ROLES, DATA, SPRINT } from '../offers/testing';
import type { Playbook, PlaybookDetail, PlaybookStep, Tier, WhatWorked } from './api';

// Fixtures in the API's shapes (snake_case) for the Playbooks tests.

export const MANAGER = ['playbooks:read', 'playbooks:write', 'playbooks:manage', 'offers:read', 'analytics:read'];
export const SELLER = ['playbooks:read', 'playbooks:write', 'offers:read'];

export const step = (s: Partial<PlaybookStep> & Pick<PlaybookStep, 'id' | 'order' | 'day' | 'title'>): PlaybookStep => ({
  channel: 'email',
  owner_role: 'seller',
  detail: null,
  target_buying_roles: [],
  crm_task: true,
  subject: null,
  body: null,
  ...s,
});

export const RFP_STEPS: PlaybookStep[] = [
  step({ id: 'stp_1', order: 1, day: 0, title: 'Send the opening email', detail: 'Reference the notice.', subject: 'Hello', body: 'Hi' }),
  step({ id: 'stp_2', order: 2, day: 3, channel: 'linkedin', title: 'Connect on LinkedIn', crm_task: false }),
  step({ id: 'stp_3', order: 3, day: 14, channel: 'call', owner_role: 'leader', title: 'Call the sponsor' }),
];

export const NO_RESULTS = { finished: 0, replied: 0, meetings: 0, won: 0 };

const zero = { reply: 0, meeting: 0, opportunity: 0, won: 0 };
/** What worked for the RFP playbook: Email (12 steps), Call (4 steps, under the minimum of 10) and results with no recent step. */
export const WORKED: WhatWorked = {
  rows: [
    { step_type: 'email', steps_done: 12, counts: { reply: 3, meeting: 1, opportunity: 1, won: 0 }, per_10: { reply: 1.5, meeting: 0.8, opportunity: 0.8, won: 0 } },
    { step_type: 'call', steps_done: 4, counts: { reply: 1, meeting: 0, opportunity: 0, won: 0 }, per_10: { reply: 2.5, meeting: 0, opportunity: 0, won: 0 } },
  ],
  no_recent_step: { reply: 2, meeting: 0, opportunity: 0, won: 1 },
  min_steps: 10,
  updated_at: '2026-10-20T12:00:00Z',
};
export const WORKED_NONE: WhatWorked = { rows: [], no_recent_step: zero, min_steps: 10, updated_at: '2026-10-20T12:00:00Z' };

export const rfp = (p: Partial<Playbook> = {}): Playbook => ({
  id: 'plb_rfp',
  name: 'Public sector RFP',
  description: 'For agencies with an open notice.',
  when_to_use: null,
  status: 'active',
  stop_when: 'reply_or_meeting',
  version: 1,
  updated_at: '2026-10-20T12:00:00Z',
  steps: 3,
  days: 14,
  channels: { email: 1, linkedin: 1, call: 1 },
  runs_on: [{ offer_id: BLUEPRINT.id, tier: 'act_now' }],
  running: 4,
  results: { finished: 5, replied: 2, meetings: 1, won: 1 },
  ...p,
});

export const draftPlaybook = (p: Partial<Playbook> = {}): Playbook =>
  rfp({ id: 'plb_draft', name: 'Warm intro', description: null, status: 'draft', steps: 1, days: 0, channels: { task: 1 }, runs_on: [], running: 0, results: NO_RESULTS, ...p });

type Seen = { method: string; url: URL; body: unknown };
type Opts = {
  scopes?: string[];
  playbooks?: Playbook[];
  /** The steps of the detail, by playbook id. */
  steps?: Record<string, PlaybookStep[]>;
  /** Answers for one action, such as `DELETE plb_draft` or `plb_rfp:archive`. */
  answer?: Record<string, () => Response>;
  /** What GET /analytics/what-worked returns. */
  whatWorked?: WhatWorked;
};

const detailOf = (p: Playbook, steps: PlaybookStep[]): PlaybookDetail => ({ ...p, steps, step_count: steps.length, steps_version: p.version });

/** The Playbooks screens answered from fixtures; writes change them. Returns the request log. */
export function servePlaybooks(opts: Opts = {}) {
  const seen: Seen[] = [];
  let playbooks = [...(opts.playbooks ?? [rfp(), draftPlaybook()])];
  const written: Record<string, PlaybookStep[]> = {};
  const steps = (id: string) => written[id] ?? opts.steps?.[id] ?? (id === 'plb_rfp' ? RFP_STEPS : [step({ id: 'stp_x', order: 1, day: 0, channel: 'task', title: 'Do the thing' })]);
  const log = async (request: Request) => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined);
    seen.push({ method: request.method, url: new URL(request.url), body });
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? MANAGER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const answer = (key: string) => opts.answer?.[key]?.();
  const found = (id: unknown) => playbooks.find((p) => p.id === id);
  const idOf = (request: Request) => new URL(request.url).pathname.split('/').pop()!.split(':')[0]!;
  server.use(
    http.get('/api/v1/offers', () => HttpResponse.json({ data: [BLUEPRINT, SPRINT, ASSESS], next_cursor: null })),
    http.get('/api/v1/buying-roles', () => HttpResponse.json({ data: BUYING_ROLES })),
    http.get('/api/v1/practices', () => HttpResponse.json({ data: [AI, DATA], next_cursor: null })),
    http.get('/api/v1/analytics/what-worked', () => HttpResponse.json(opts.whatWorked ?? WORKED)),
    http.get('/api/v1/playbooks', async ({ request }) => {
      await log(request);
      return answer('list') ?? HttpResponse.json({ data: playbooks, next_cursor: null });
    }),
    http.get('/api/v1/playbooks/:id', ({ params }) => {
      const p = found(params.id);
      return p ? HttpResponse.json(detailOf(p, steps(p.id))) : problem(404, 'That playbook was not found.');
    }),
    http.post(exactly('/api/v1/playbooks'), async ({ request }) => {
      await log(request);
      const out = answer('POST');
      if (out) return out;
      const body = (await request.clone().json()) as Record<string, unknown>;
      const made = rfp({ id: 'plb_new', name: String(body.name), status: 'draft', runs_on: [], running: 0, results: NO_RESULTS });
      playbooks = [...playbooks, made];
      return HttpResponse.json(detailOf(made, steps('plb_new')), { status: 201 });
    }),
    http.patch('/api/v1/playbooks/:id', async ({ request, params }) => {
      await log(request);
      const out = answer(`PATCH ${String(params.id)}`);
      if (out) return out;
      const body = (await request.clone().json()) as Partial<Playbook> & { steps?: Partial<PlaybookStep>[] };
      const { steps: sent, ...fields } = body;
      if (sent) written[String(params.id)] = sent.map((x, i) => step({ id: `stp_n${i}`, order: i + 1, day: 0, title: '', ...x }));
      playbooks = playbooks.map((p) => (p.id === params.id ? { ...p, ...fields } : p));
      return HttpResponse.json(detailOf(found(params.id)!, steps(String(params.id))));
    }),
    http.get('/api/v1/offers/:id/playbooks', ({ params }) =>
      HttpResponse.json({
        data: (['act_now', 'good_fit', 'watch'] as const).map((tier) => {
          const p = playbooks.find((x) => x.runs_on.some((r) => r.offer_id === params.id && r.tier === tier));
          return { tier, playbook: p ? { id: p.id, name: p.name, status: p.status, steps: p.steps, days: p.days } : null, first_email: null };
        }),
      }),
    ),
    http.put('/api/v1/offers/:id/playbooks/:tier', async ({ request, params }) => {
      await log(request);
      const out = answer(`PUT ${String(params.tier)}`);
      if (out) return out;
      const body = (await request.clone().json()) as { playbook_id: string | null };
      const same = (r: { offer_id: string; tier: string }) => r.offer_id === params.id && r.tier === params.tier;
      playbooks = playbooks.map((p) => ({
        ...p,
        runs_on: [...p.runs_on.filter((r) => !same(r)), ...(p.id === body.playbook_id ? [{ offer_id: String(params.id), tier: params.tier as Tier }] : [])],
      }));
      return HttpResponse.json({ data: [] });
    }),
    http.post(exactly('/api/v1/playbooks/plb_rfp:duplicate'), async ({ request }) => {
      await log(request);
      const copy = rfp({ id: 'plb_copy', name: 'Public sector RFP (copy)', status: 'draft', runs_on: [], running: 0 });
      playbooks = [...playbooks, copy];
      return HttpResponse.json(detailOf(copy, steps('plb_rfp')), { status: 201 });
    }),
    http.post(/\/api\/v1\/playbooks\/[^/]+:archive$/, async ({ request }) => {
      await log(request);
      const id = idOf(request);
      const out = answer(`${id}:archive`);
      if (out) return out;
      playbooks = playbooks.map((p) => (p.id === id ? { ...p, status: 'archived', runs_on: [] } : p));
      return HttpResponse.json(detailOf(found(id)!, steps(id)));
    }),
    http.delete('/api/v1/playbooks/:id', async ({ request, params }) => {
      await log(request);
      const out = answer(`DELETE ${String(params.id)}`);
      if (out) return out;
      playbooks = playbooks.filter((p) => p.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return seen;
}
