import { http, HttpResponse } from 'msw';
import { server } from '../../test/server';
import type { EnrichmentRequest, Estimate } from './api';

// Fixtures in the API's shapes (snake_case), for the Enrich dialog and the account notice.

export const REQUESTER = ['enrichment:request'];
export const APPROVER = ['enrichment:request', 'enrichment:approve'];

export const REQUEST: EnrichmentRequest = {
  id: 'enr_1',
  account_id: 'acc_mdc',
  account_name: 'Miami-Dade County DTPW',
  kind: 'people_for_roles',
  kind_label: 'People for buying roles',
  provider_key: 'apollo',
  provider_name: 'Apollo',
  status: 'running',
  status_text: 'Running',
  requested_by_label: 'Zach Wiant',
  reason: null,
  estimate: { credits: 3, cost_cents: 30, text: 'Up to 3 credits, about $0.30' },
  created_at: new Date().toISOString(),
  decided_by_label: 'Zach Wiant',
  decided_at: new Date().toISOString(),
  decline_reason: null,
  result: null,
  error: null,
  waiting_reason: null,
  sample: true,
};

const estimateOf = (u: URL): Estimate => {
  const n = u.searchParams.get('kind') === 'people_for_roles' ? (u.searchParams.get('roles') ?? '').split(',').filter(Boolean).length * 3 : 1;
  return { credits: n, cost_cents: n * 10, currency: 'USD', sample: true, text: `Up to ${n} credits, about $${(n / 10).toFixed(2)} · Sample` };
};

/**
 * The enrichment routes for acc_mdc: the estimate (credits from the URL), the account's requests and
 * the create. Returns the estimate URLs, the list reads and the bodies posted.
 */
export function serveEnrichment(opts: { requests?: () => EnrichmentRequest[]; create?: (body: unknown) => Response } = {}) {
  const seen = { estimates: [] as URL[], lists: [] as URL[], posted: [] as unknown[] };
  server.use(
    http.get('/api/v1/accounts/acc_mdc/enrichment-estimate', ({ request }) => {
      const u = new URL(request.url);
      seen.estimates.push(u);
      return HttpResponse.json(estimateOf(u));
    }),
    http.get('/api/v1/enrichment-requests', ({ request }) => {
      seen.lists.push(new URL(request.url));
      return HttpResponse.json({ data: opts.requests?.() ?? [], next_cursor: null });
    }),
    http.post('/api/v1/accounts/acc_mdc/enrichment-requests', async ({ request }) => {
      const body = await request.json();
      seen.posted.push(body);
      return opts.create?.(body) ?? HttpResponse.json({ ...REQUEST, status: 'approved', status_text: 'Starting', joined: false }, { status: 201 });
    }),
  );
  return seen;
}
