import { http, HttpResponse } from 'msw';
import { server } from './server';

describe('test setup', () => {
  it('serves MSW handlers to fetch', async () => {
    server.use(http.get('http://localhost/ping', () => HttpResponse.json({ ok: true })));
    const res = await fetch('http://localhost/ping');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('has jest-dom matchers', () => {
    document.body.innerHTML = '<p>Scout</p>';
    expect(document.querySelector('p')).toHaveTextContent('Scout');
  });
});
