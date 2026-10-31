import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * Calls the shell makes on every screen, answered with "nothing to show". Tests replace them with
 * `server.use(...)`; `resetHandlers` brings these back.
 */
const shellDefaults = [
  http.get('/api/v1/me/counts', () => HttpResponse.json({ review_queue: null, new_assignments: null })),
  http.put('/api/v1/me/workspace', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/v1/auth/config', () => HttpResponse.json({ methods: ['microsoft'], dev_sign_in: false })),
  http.get('/api/v1/dev/users', () => new HttpResponse('Not found', { status: 404 })),
];

const empty = () => HttpResponse.json({ data: [], next_cursor: null, total: 0 });

/**
 * The landing screens (Review queue, My accounts, All accounts) answered with nothing, so tests about
 * the shell and sign-in can land on them. Their own tests answer with data.
 */
const landingDefaults = [
  http.get('/api/v1/review-queue', empty),
  http.get('/api/v1/review-queue/facets', () =>
    HttpResponse.json({ total: 0, oldest_arrived_at: null, last_reviewed_at: null, tiers: [], practices: [], offers: [], sources: [], statuses: [] }),
  ),
  http.get('/api/v1/me/preferences/review-queue-columns', () => HttpResponse.json({ columns: [], shown: 1, total: 12, is_default: true })),
  http.get('/api/v1/settings/review/statuses', () => HttpResponse.json({ data: [] })),
  http.get('/api/v1/assignments', empty),
  http.get('/api/v1/accounts', empty),
  http.get('/api/v1/accounts/facets', () => HttpResponse.json({ total: 0, won_this_year: 0, stages: [], owners: [], practices: [], sources: [] })),
];

/** The MSW server every test shares. Tests add handlers with `server.use(...)`. */
export const server = setupServer(...shellDefaults, ...landingDefaults);
