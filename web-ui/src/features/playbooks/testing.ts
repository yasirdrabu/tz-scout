import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { ASSESS, AI, BLUEPRINT, DATA, SPRINT } from '../offers/testing';
import type { Playbook, PlaybookDetail, PlaybookStep } from './api';

// Fixtures in the API's shapes (snake_case) for the Playbooks tests.

export const MANAGER = ['playbooks:read', 'playbooks:write', 'playbooks:manage', 'offers:read'];
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
  ...p,
});

export const draftPlaybook = (p: Partial<Playbook> = {}): Playbook =>
  rfp({ id: 'plb_draft', name: 'Warm intro', description: null, status: 'draft', steps: 1, days: 0, channels: { task: 1 }, runs_on: [], running: 0, ...p });

type Seen = { method: string; url: URL; body: unknown };
type Opts = {
  scopes?: string[];
  playbooks?: Playbook[];
  /** The steps of the detail, by playbook id. */
  steps?: Record<string, PlaybookStep[]>;
  /** Answers for one action, such as `DELETE plb_draft` or `plb_rfp:archive`. */
  answer?: Record<string, () => Response>;
};

const detailOf = (p: Playbook, steps: PlaybookStep[]): PlaybookDetail => ({ ...p, steps, step_count: steps.length, steps_version: p.version });

/** The Playbooks screens answered from fixtures; writes change them. Returns the request log. */
export function servePlaybooks(opts: Opts = {}) {
  const seen: Seen[] = [];
  let playbooks = [...(opts.playbooks ?? [rfp(), draftPlaybook()])];
  const steps = (id: string) => opts.steps?.[id] ?? (id === 'plb_rfp' ? RFP_STEPS : [step({ id: 'stp_x', order: 1, day: 0, channel: 'task', title: 'Do the thing' })]);
  const log = async (request: Request) => {
    seen.push({ method: request.method, url: new URL(request.url), body: undefined });
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? MANAGER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const answer = (key: string) => opts.answer?.[key]?.();
  const found = (id: unknown) => playbooks.find((p) => p.id === id);
  const idOf = (request: Request) => new URL(request.url).pathname.split('/').pop()!.split(':')[0]!;
  server.use(
    http.get('/api/v1/offers', () => HttpResponse.json({ data: [BLUEPRINT, SPRINT, ASSESS], next_cursor: null })),
    http.get('/api/v1/practices', () => HttpResponse.json({ data: [AI, DATA], next_cursor: null })),
    http.get('/api/v1/playbooks', async ({ request }) => {
      await log(request);
      return answer('list') ?? HttpResponse.json({ data: playbooks, next_cursor: null });
    }),
    http.get('/api/v1/playbooks/:id', ({ params }) => {
      const p = found(params.id);
      return p ? HttpResponse.json(detailOf(p, steps(p.id))) : problem(404, 'That playbook was not found.');
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
