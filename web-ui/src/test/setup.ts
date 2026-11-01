import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from './server';

// The first screen of a file loads its route chunk, which can take over a second with every file
// running in parallel; findBy and waitFor wait up to 3 s instead of 1 s.
configure({ asyncUtilTimeout: 3000 });

// jsdom's AbortSignal is not the one Node's fetch (undici) accepts, so a query's signal would make
// every request fail in tests. Tests drop the signal; the app keeps it in the browser.
let mswFetch: typeof fetch;

// jsdom has no scrolling; the router's scroll restoration calls it.
window.scrollTo = () => undefined;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  mswFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => mswFetch(input, init && { ...init, signal: null });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  globalThis.fetch = mswFetch;
  server.close();
});
