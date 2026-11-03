import { RateLimitedError, type LiveCredentials } from '@/modules/integrations';
import type { EnrichmentAdapter, SitePage } from '../../contracts/adapter';
import { ProviderError, cantDo, retryAfterMs } from '../errors';
import { linksOf, textOf, titleOf } from './html';
import { parseRobots, type Robots } from './robots';

// Reads a company's website (Ruling 3): the home page and up to 4 same-host linked pages whose path or link text
// matches about, services, industries or contact. Respects robots.txt, spends at most 30 seconds in all and 2 MB per
// page, and says who it is. Needs no key. When the 30 seconds run out before the home page is read, the read fails as
// a timeout (the job retries); after that, it stops and keeps the pages it has.

export const USER_AGENT = 'TaazaaScout/1.0 (+https://scout.taazaa.ai/bot)';
export const BUDGET_MS = 30_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LINKED_PAGES = 4;
const PROVIDER = 'Company website';
const LINK_WORDS = /about|services|industries|contact/i;

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/**
 * A public host name: dotted, not an IP address, not localhost or an internal name. Account data supplies the domain,
 * so the server never fetches an address on its own network by name. (A public name that resolves to a private
 * address is not caught here.)
 */
export const isPublicHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^\d+(\.\d+)+$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h);
};

/** The body as text, at most `MAX_PAGE_BYTES` of it. */
async function capped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_PAGE_BYTES - size;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    size += Math.min(value.length, room);
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

const isHtml = (res: Response) => {
  const type = res.headers.get('content-type');
  return !type || /text\/html|application\/xhtml/i.test(type);
};

export function websiteLive(_creds: LiveCredentials, fetchImpl: typeof fetch = fetch): EnrichmentAdapter {
  return {
    async test() {
      return { ok: true, message: 'Ready to read company websites. No key is needed.' };
    },

    async readSite({ domain }) {
      const budget = new AbortController();
      const timer = setTimeout(
        () => budget.abort(new DOMException(`${domain} took too long to answer.`, 'TimeoutError')),
        BUDGET_MS,
      );
      const get = (url: string, accept: string) =>
        fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'follow', signal: budget.signal });
      /** The abort reason once the budget is spent, else the error itself. */
      const why = (e: unknown) => (budget.signal.aborted ? budget.signal.reason : e);

      try {
        if (!isPublicHost(domain)) throw new ProviderError(400, `${domain} isn't a public website.`);
        const home = `https://${domain}/`;
        let robots: Robots = parseRobots('');
        try {
          const res = await get(new URL('/robots.txt', home).href, 'text/plain');
          if (res.ok) robots = parseRobots(await capped(res));
        } catch (e) {
          // No robots.txt to read means no rules, unless the time ran out.
          if (budget.signal.aborted) throw why(e);
        }
        if (!robots.allows('/')) return { pages: [] };

        let first: SitePage;
        let base: URL;
        try {
          const res = await get(home, 'text/html');
          if (res.status === 429) throw new RateLimitedError(`${domain} asked us to slow down.`, retryAfterMs(res.headers.get('retry-after')));
          // A site that refuses the page will refuse it again: a bad request. A server error may pass: it retries.
          if (!res.ok) throw new ProviderError(res.status >= 500 ? res.status : 400, `${domain} answered ${res.status}.`);
          if (!isHtml(res)) throw new ProviderError(400, `${domain} did not send a web page.`);
          base = new URL(res.url || home);
          if (!isPublicHost(base.hostname)) throw new ProviderError(400, `${domain} sent us to a site that isn't public.`);
          const html = await capped(res);
          first = { url: base.href, title: titleOf(html), text: textOf(html), html };
        } catch (e) {
          throw why(e);
        }

        const host = bareHost(base.hostname);
        const seen = new Set([base.pathname]);
        const linked: string[] = [];
        for (const a of linksOf(first.html)) {
          if (linked.length >= MAX_LINKED_PAGES) break;
          let u: URL;
          try {
            u = new URL(a.href, base);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(u.protocol) || bareHost(u.hostname) !== host) continue;
          if (!LINK_WORDS.test(u.pathname) && !LINK_WORDS.test(a.text)) continue;
          if (seen.has(u.pathname) || !robots.allows(u.pathname)) continue;
          seen.add(u.pathname);
          u.hash = '';
          linked.push(u.href);
        }

        const pages = [first];
        for (const url of linked) {
          if (budget.signal.aborted) break;
          try {
            const res = await get(url, 'text/html');
            if (!res.ok || !isHtml(res)) continue;
            const html = await capped(res);
            pages.push({ url, title: titleOf(html), text: textOf(html), html });
          } catch {
            // A linked page that fails is skipped; the budget running out ends the read.
            if (budget.signal.aborted) break;
          }
        }
        return { pages };
      } finally {
        clearTimeout(timer);
      }
    },

    async companyEnrich() {
      throw cantDo(PROVIDER);
    },
    async peopleSearch() {
      throw cantDo(PROVIDER);
    },
    async revealEmail() {
      throw cantDo(PROVIDER);
    },
    async jobPostings() {
      throw cantDo(PROVIDER);
    },
    async news() {
      throw cantDo(PROVIDER);
    },
  };
}
