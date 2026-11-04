import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { ProviderError } from '../errors';
import { isBlockedAddress } from './guard';

// A fetch for the website reader that checks addresses when it connects (review I-1). Node's built-in fetch cannot be
// given a resolver without the `undici` package, so this uses `node:http`/`node:https` with a `lookup` hook: every
// address a name resolves to is checked, and the connection is made to that checked address, so DNS rebinding has no
// window. TLS still verifies the certificate for the name. It never follows redirects (the reader does, checking each
// hop), decompresses gzip, deflate and br bodies, and uses a fresh socket per request (`agent: false`, no pool).
// An abort, an error mid-body or a cancel on either side destroys the socket and the decoder, and fails the body.

/** Resolves a name to all its addresses; injectable so tests stay offline. */
export type Resolve = (host: string) => Promise<LookupAddress[]>;

export type TransportOptions = {
  resolve?: Resolve;
  /** Tests only: addresses to let through although they are blocked (a local test server on 127.0.0.1). Never set in production. */
  allowAddress?: (address: string) => boolean;
};

const systemResolve: Resolve = (host) => dns.lookup(host, { all: true, verbatim: true });

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for `net.connect` that refuses a name when any of its addresses is private. */
export function guardedLookup(resolve: Resolve = systemResolve, allowAddress?: (address: string) => boolean) {
  const blocked = (a: string) => isBlockedAddress(a) && !allowAddress?.(a);
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname)
      .then((all) => {
        const addrs = all.filter((a) => !options.family || a.family === options.family);
        if (!addrs.length) throw Object.assign(new Error(`${hostname} has no address.`), { code: 'ENOTFOUND' });
        if (all.some((a) => blocked(a.address))) throw new ProviderError(400, `${hostname} isn't a public website.`);
        if (options.all) callback(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => callback(e, ''));
  };
}

const decoders: Record<string, () => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/** Statuses whose response can have no body: `new Response` throws if given one. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A GET-only, fetch-shaped client whose connections go only to public addresses. */
export function guardedFetch(opts: TransportOptions = {}): typeof fetch {
  const { resolve = systemResolve, allowAddress } = opts;
  const lookup = guardedLookup(resolve, allowAddress);
  return ((input: string | URL, init?: RequestInit) =>
    new Promise<Response>((ok, fail) => {
      const url = new URL(String(input));
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      // An address in the URL is never looked up, so it is checked here.
      if (isIP(literal) && isBlockedAddress(literal) && !allowAddress?.(literal)) {
        return fail(new ProviderError(400, `${url.hostname} isn't a public website.`));
      }
      const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
      if (!client) return fail(new ProviderError(400, `Scout reads only http and https pages.`));
      const signal = init?.signal ?? undefined;
      const headers = { ...(init?.headers as Record<string, string> | undefined), 'accept-encoding': 'gzip, deflate, br' };
      const req = client.request(url, { method: 'GET', headers, lookup, signal, agent: false }, (res) => {
        try {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) throw new ProviderError(502, `${url.hostname} sent an answer Scout could not read.`);
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
          if (NULL_BODY.has(status)) {
            res.resume();
            return ok(new Response(null, { status, headers: out }));
          }
          const decode = decoders[(res.headers['content-encoding'] ?? '').toLowerCase()]?.();
          let body: Readable = res;
          if (decode) {
            out.delete('content-encoding');
            // pipeline, not pipe: an error or destroy on either stream destroys both, so nothing hangs or leaks.
            body = pipeline(res, decode, () => undefined);
          }
          // The request's abort reaches the body too, so a read in progress fails instead of waiting.
          const onAbort = () => {
            const why = signal?.reason ?? new Error('aborted');
            body.destroy(why);
            res.destroy(why);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          body.once('close', () => signal?.removeEventListener('abort', onAbort));
          ok(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: out }));
        } catch (e) {
          res.destroy();
          fail(e);
        }
      });
      req.on('error', fail);
      req.end();
    })) as typeof fetch;
}
