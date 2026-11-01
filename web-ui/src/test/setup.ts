import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { settleRenderedApps, stopRenderedApps } from './apps';
import { server } from './server';

// The first screen of a file loads its route chunk, which can take over a second with every file
// running in parallel; findBy and waitFor wait up to 3 s instead of 1 s.
configure({ asyncUtilTimeout: 3000 });

// jsdom's AbortSignal is not the one Node's fetch (undici) accepts, so a query's signal would make
// every request fail in tests. Tests drop the signal; the app keeps it in the browser.
let mswFetch: typeof fetch;

// jsdom has no scrolling; the router's scroll restoration calls it.
window.scrollTo = () => undefined;

// Node's fetch can't send jsdom's FormData, and MSW can't parse multipart here, so a FormData body goes as a
// multipart text body (tests read it with `multipartFields`). In the browser the page sends its own FormData.
const BOUNDARY = 'scout-test-boundary';

/** jsdom's File has no text(); FileReader reads it. */
const readText = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

async function multipart(init: RequestInit): Promise<RequestInit> {
  if (!(init.body instanceof FormData)) return init;
  const parts: string[] = [];
  for (const [name, value] of init.body.entries()) {
    parts.push(
      typeof value === 'string'
        ? `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        : `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n${await readText(value)}\r\n`,
    );
  }
  const headers = new Headers(init.headers);
  headers.set('content-type', `multipart/form-data; boundary=${BOUNDARY}`);
  return { ...init, headers, body: `${parts.join('')}--${BOUNDARY}--\r\n` };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  mswFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => mswFetch(input, init && { ...(await multipart(init)), signal: null });
});
afterEach(async () => {
  await settleRenderedApps();
  cleanup();
  await stopRenderedApps();
  server.resetHandlers();
});
afterAll(() => {
  globalThis.fetch = mswFetch;
  server.close();
});
