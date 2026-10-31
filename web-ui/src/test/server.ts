import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * Calls the shell makes on every screen, answered with "nothing to show". Tests replace them with
 * `server.use(...)`; `resetHandlers` brings these back.
 */
const shellDefaults = [
  http.get('/v1/me/counts', () => HttpResponse.json({ review_queue: null, new_assignments: null })),
  http.put('/v1/me/workspace', () => new HttpResponse(null, { status: 204 })),
  http.get('/v1/auth/config', () => HttpResponse.json({ methods: ['microsoft'], dev_sign_in: false })),
  http.get('/v1/dev/users', () => new HttpResponse('Not found', { status: 404 })),
];

/** The MSW server every test shares. Tests add handlers with `server.use(...)`. */
export const server = setupServer(...shellDefaults);
