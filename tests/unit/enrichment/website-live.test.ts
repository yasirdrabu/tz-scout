// The live website reader against a stubbed fetch (Ruling 3, Review Focus 5): robots.txt, same-host linked pages,
// the user agent, the 2 MB page limit and the 30-second budget (fake timers).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { websiteLive, USER_AGENT } from '@/modules/enrichment/adapters/website/live';
import { classifyError } from '@/modules/enrichment/domain/errors';

type Route = string | { status?: number; body?: string; type?: string; hang?: boolean };

const HOME = `<html><head><title>Acme Freight</title><meta name="description" content="Freight for the Midwest."></head>
<body><nav><a href="/about">About us</a> <a href="/services/">What we do</a> <a href="https://acme.com/industries">Markets</a>
<a href="/team">Our people</a> <a href="/contact#form">Contact</a> <a href="https://other.com/about">Partner</a>
<a href="/blog">Blog</a> <a href="/careers">Careers</a> <a href="/news">Get in touch: services</a></nav>
<script>var hidden = 1;</script><p>We move   freight &amp; more.</p></body></html>`;

function site(routes: Record<string, Route>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string, init: RequestInit) => {
    seen.push({ url: input, headers: init.headers as Record<string, string> });
    const r = routes[new URL(input).pathname] ?? { status: 404, body: 'not found' };
    const o = typeof r === 'string' ? { body: r } : r;
    if (o.hang) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    const res = new Response(o.body ?? '', { status: o.status ?? 200, headers: { 'content-type': o.type ?? 'text/html; charset=utf-8' } });
    Object.defineProperty(res, 'url', { value: input });
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return { seen, adapter: websiteLive({ kind: 'none', value: '', settings: {} }, fetchImpl) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('website live adapter', () => {
  it('reads the home page and up to 4 same-host about, services, industries and contact pages, as Scout', async () => {
    const { seen, adapter } = site({ '/': HOME, '/about': '<title>About</title><p>Since 1990.</p>', '/services/': '<title>Services</title>', '/industries': '<title>Industries</title>', '/contact': '<title>Contact</title>', '/news': '<title>News</title>' });
    const { pages } = await adapter.readSite({ domain: 'acme.com' });
    expect(pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/about', 'https://acme.com/services/', 'https://acme.com/industries', 'https://acme.com/contact']);
    expect(pages[0]).toMatchObject({ title: 'Acme Freight', text: expect.stringContaining('We move freight & more.') });
    expect(pages[0]!.text).not.toContain('hidden');
    expect(pages[0]!.html).toContain('<meta name="description"');
    expect(pages[1]).toMatchObject({ title: 'About', text: expect.stringContaining('Since 1990.') });
    expect(seen.every((s) => s.headers['user-agent'] === USER_AGENT)).toBe(true);
    expect(USER_AGENT).toBe('TaazaaScout/1.0 (+https://scout.taazaa.ai/bot)');
    expect(seen.map((s) => s.url)).not.toContain('https://other.com/about');
  });

  it('skips a page robots.txt disallows, and still reads the home page (Review Focus 5)', async () => {
    const { seen, adapter } = site({ '/robots.txt': { body: 'User-agent: *\nDisallow: /about\n', type: 'text/plain' }, '/': HOME, '/about': 'secret', '/services/': '<title>Services</title>' });
    const { pages } = await adapter.readSite({ domain: 'acme.com' });
    expect(pages.map((p) => p.url)).toContain('https://acme.com/');
    expect(pages.map((p) => p.url)).not.toContain('https://acme.com/about');
    expect(seen.map((s) => s.url)).not.toContain('https://acme.com/about');
    expect(seen[0]!.url).toBe('https://acme.com/robots.txt');
  });

  it('reads nothing when robots.txt disallows the whole site', async () => {
    const { seen, adapter } = site({ '/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' }, '/': HOME });
    expect(await adapter.readSite({ domain: 'acme.com' })).toEqual({ pages: [] });
    expect(seen).toHaveLength(1);
  });

  it('a site that does not answer in 30 seconds fails as a timeout, which retries (Review Focus 5)', async () => {
    vi.useFakeTimers();
    const { adapter } = site({ '/': { hang: true } });
    const read = adapter.readSite({ domain: 'acme.com' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void read.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await read;
    expect(e).toMatchObject({ name: 'TimeoutError' });
    expect(classifyError(e, 'Company website')).toMatchObject({ kind: 'timeout', retry: true });
  });

  it('stops at 30 seconds in total and keeps the pages it read', async () => {
    vi.useFakeTimers();
    const { adapter } = site({ '/': HOME, '/about': '<title>About</title>', '/services/': { hang: true }, '/industries': '<title>Industries</title>' });
    const read = adapter.readSite({ domain: 'acme.com' });
    await vi.advanceTimersByTimeAsync(30_000);
    const { pages } = await read;
    expect(pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/about']);
  });

  it('keeps at most 2 MB of a page', async () => {
    const big = `<title>Big</title><p>${'a'.repeat(3 * 1024 * 1024)}</p>`;
    const { adapter } = site({ '/': big });
    const { pages } = await adapter.readSite({ domain: 'acme.com' });
    expect(pages[0]!.html.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(pages[0]!.title).toBe('Big');
  });

  it('a home page the site refuses is a bad request; a 5xx retries', async () => {
    const refused = await site({ '/': { status: 404 } }).adapter.readSite({ domain: 'acme.com' }).catch((e: unknown) => e);
    expect(classifyError(refused, 'Company website')).toMatchObject({ kind: 'bad_request', message: 'acme.com answered 404.' });
    const down = await site({ '/': { status: 503 } }).adapter.readSite({ domain: 'acme.com' }).catch((e: unknown) => e);
    expect(classifyError(down, 'Company website')).toMatchObject({ kind: 'unknown', retry: true });
  });

  it('skips linked pages that fail or are not web pages', async () => {
    const { adapter } = site({ '/': HOME, '/about': { status: 500 }, '/services/': { body: '%PDF', type: 'application/pdf' }, '/contact': '<title>Contact</title>' });
    const { pages } = await adapter.readSite({ domain: 'acme.com' });
    expect(pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/contact']);
  });

  it('reads only public sites, and does not follow a redirect onto an internal one', async () => {
    for (const domain of ['localhost', '127.0.0.1', '10.0.0.5', 'intranet', 'files.corp', 'printer.local']) {
      const { seen, adapter } = site({ '/': HOME });
      await expect(adapter.readSite({ domain })).rejects.toMatchObject({ status: 400, message: `${domain} isn't a public website.` });
      expect(seen).toHaveLength(0);
    }
    const fetchImpl = (async (input: string) => {
      const res = new Response(HOME, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: input.endsWith('robots.txt') ? input : 'http://169.254.169.254/' });
      return res;
    }) as unknown as typeof fetch;
    await expect(websiteLive({ kind: 'none', value: '', settings: {} }, fetchImpl).readSite({ domain: 'acme.com' })).rejects.toMatchObject({ status: 400 });
  });

  it("needs no key to test, and can't do the paid operations", async () => {
    const { adapter } = site({});
    expect(await adapter.test()).toMatchObject({ ok: true });
    await expect(adapter.companyEnrich({ domain: 'acme.com' })).rejects.toMatchObject({ status: 400, message: "Company website can't do that." });
  });
});
