import { RateLimitedError, type LiveCredentials } from '@/modules/integrations';
import type { EnrichmentAdapter, SitePage } from '../../contracts/adapter';
import { ProviderError, cantDo, retryAfterMs } from '../errors';
import { isPublicHost, normaliseHost } from './guard';
import { linksOf, textOf, titleOf } from './html';
import { guardedFetch } from './live-transport';
import { parseRobots, type Robots } from './robots';

// Reads a company's website (Ruling 3): the home page and up to 4 same-host linked pages whose path or link text
// matches about, services, industries or contact. Respects robots.txt, spends at most 30 seconds in all and 2 MB per
// page, and says who it is. Needs no key.
// - Only public sites (review I-1): the domain is read as the URL parser reads it, redirects are followed by hand (at
//   most 3 hops, each hop checked), and the default transport checks every address when it connects.
// - A home page that can't be reached, or that answers with an error, is a bad request: "Scout couldn't reach
//   {domain}." Only a dropped connection, a DNS hiccup, a rate limit or the time running out retries.
// - When the 30 seconds run out before the home page is read, the read fails as a timeout; after that, it stops and
//   keeps the pages it has. A linked page that fails is skipped.

export const USER_AGENT = 'TaazaaScout/1.0 (+https://scout.taazaa.ai/bot)';
export const BUDGET_MS = 30_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LINKED_PAGES = 4;
export const MAX_REDIRECTS = 3;
const PROVIDER = 'Company website';
const LINK_WORDS = /about|services|industries|contact/i;
/** Network errors that may pass on a later try. */
const TRANSIENT = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
const codeOf = (e: unknown): string | undefined => {
  const o = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = o?.code ?? o?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
const cancel = (res: Response) => res.body?.cancel().catch(() => undefined);

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

export function websiteLive(_creds: LiveCredentials, fetchImpl: typeof fetch = guardedFetch()): EnrichmentAdapter {
  return {
    async test() {
      return { ok: true, message: 'Ready to read company websites. No key is needed.' };
    },

    async readSite({ domain }) {
      const host = normaliseHost(domain);
      if (!host || !isPublicHost(host)) throw new ProviderError(400, `${domain} isn't a public website.`);
      const site = bareHost(host);
      const unreachable = () => new ProviderError(400, `Scout couldn't reach ${domain}.`);

      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(new DOMException(`${domain} took too long to answer.`, 'TimeoutError')), BUDGET_MS);
      let robots: Robots = parseRobots('');

      /**
       * GET `start`, following redirects by hand. Every hop must be a public host, and with `stayOn` stay on that host
       * (and be allowed by robots.txt when it is the company's own). Returns the answer and the URL it came from.
       */
      const open = async (start: URL, accept: string, stayOn: string | null): Promise<{ res: Response; url: URL }> => {
        let url = start;
        for (let hop = 0; ; hop++) {
          if (!isPublicHost(url.hostname) || !/^https?:$/.test(url.protocol)) {
            throw new ProviderError(400, `${domain} sent us to a site that isn't public.`);
          }
          if (stayOn && (bareHost(url.hostname) !== stayOn || (stayOn === site && !robots.allows(url.pathname + url.search)))) {
            throw new ProviderError(400, `${domain} sent us to a page Scout may not read.`);
          }
          const res = await fetchImpl(url.href, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'manual', signal: budget.signal });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (!location) return { res, url };
          await cancel(res);
          if (hop >= MAX_REDIRECTS) throw new ProviderError(400, `${domain} redirected too many times.`);
          url = new URL(location, url);
        }
      };

      try {
        const home = new URL(`https://${host}/`);
        try {
          const { res } = await open(new URL('/robots.txt', home), 'text/plain', null);
          // RFC 9309: a server error means read nothing; no file (4xx) means no rules.
          if (res.status >= 500) {
            await cancel(res);
            return { pages: [] };
          }
          if (res.ok) robots = parseRobots(await capped(res));
          else await cancel(res);
        } catch {
          // robots.txt that can't be fetched leaves no rules: the home page fetch says whether the site is reachable.
          if (budget.signal.aborted) throw budget.signal.reason;
        }
        if (!robots.allows('/')) return { pages: [] };

        let first: SitePage;
        let base: URL;
        try {
          const { res, url } = await open(home, 'text/html', null);
          if (res.status === 429) {
            await cancel(res);
            throw new RateLimitedError(`${domain} asked us to slow down.`, retryAfterMs(res.headers.get('retry-after')));
          }
          if (!res.ok) {
            await cancel(res);
            throw unreachable();
          }
          if (!isHtml(res)) {
            await cancel(res);
            throw new ProviderError(400, `${domain} did not send a web page.`);
          }
          const html = await capped(res);
          base = url;
          first = { url: url.href, title: titleOf(html), text: textOf(html), html };
        } catch (e) {
          if (budget.signal.aborted) throw budget.signal.reason;
          if (e instanceof RateLimitedError || e instanceof ProviderError) throw e;
          const code = codeOf(e);
          if (code && TRANSIENT.has(code)) throw e;
          // Not found, refused, a bad certificate, or anything else the network says: trying again won't help.
          throw unreachable();
        }

        const seen = new Set([base.pathname]);
        const linked: URL[] = [];
        for (const a of linksOf(first.html)) {
          if (linked.length >= MAX_LINKED_PAGES) break;
          let u: URL;
          try {
            u = new URL(a.href, base);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(u.protocol) || bareHost(u.hostname) !== bareHost(base.hostname)) continue;
          if (!LINK_WORDS.test(u.pathname) && !LINK_WORDS.test(a.text)) continue;
          if (seen.has(u.pathname) || !robots.allows(u.pathname + u.search)) continue;
          seen.add(u.pathname);
          u.hash = '';
          linked.push(u);
        }

        const pages = [first];
        for (const link of linked) {
          if (budget.signal.aborted) break;
          try {
            // Linked pages stay on the host the home page was served from.
            const { res, url } = await open(link, 'text/html', bareHost(base.hostname));
            if (!res.ok || !isHtml(res)) {
              await cancel(res);
              continue;
            }
            const html = await capped(res);
            pages.push({ url: url.href, title: titleOf(html), text: textOf(html), html });
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
