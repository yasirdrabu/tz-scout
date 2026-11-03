import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { ProviderError } from '../errors';
import { isBlockedAddress } from './guard';

// A fetch for the website reader that checks addresses when it connects (review I-1). Node's built-in fetch cannot be
// given a resolver without the `undici` package, so this uses `node:http`/`node:https` with a `lookup` hook: every
// address a name resolves to is checked, and the connection is made to that checked address, so DNS rebinding has no
// window. TLS still verifies the certificate for the name. It never follows redirects (the reader does, checking each
// hop), and it decompresses gzip, deflate and br bodies.

/** Resolves a name to all its addresses; injectable so tests stay offline. */
export type Resolve = (host: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (host) => dns.lookup(host, { all: true, verbatim: true });

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for `net.connect` that refuses a name when any of its addresses is private. */
export function guardedLookup(resolve: Resolve = systemResolve) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname)
      .then((all) => {
        const addrs = all.filter((a) => !options.family || a.family === options.family);
        if (!addrs.length) throw Object.assign(new Error(`${hostname} has no address.`), { code: 'ENOTFOUND' });
        if (all.some((a) => isBlockedAddress(a.address))) throw new ProviderError(400, `${hostname} isn't a public website.`);
        if (options.all) callback(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => callback(e, ''));
  };
}

const decoders: Record<string, () => NodeJS.ReadWriteStream> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/** A GET-only, fetch-shaped client whose connections go only to public addresses. */
export function guardedFetch(resolve: Resolve = systemResolve): typeof fetch {
  const lookup = guardedLookup(resolve);
  return ((input: string | URL, init?: RequestInit) =>
    new Promise<Response>((ok, fail) => {
      const url = new URL(String(input));
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      // An address in the URL is never looked up, so it is checked here.
      if (isIP(literal) && isBlockedAddress(literal)) return fail(new ProviderError(400, `${url.hostname} isn't a public website.`));
      const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
      if (!client) return fail(new ProviderError(400, `Scout reads only http and https pages.`));
      const headers = { ...(init?.headers as Record<string, string> | undefined), 'accept-encoding': 'gzip, deflate, br' };
      const req = client.request(url, { method: 'GET', headers, lookup, signal: init?.signal ?? undefined }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          return fail(new ProviderError(502, `${url.hostname} sent an answer Scout could not read.`));
        }
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
        const encoding = (res.headers['content-encoding'] ?? '').toLowerCase();
        const decode = decoders[encoding];
        const stream = decode ? res.pipe(decode()) : res;
        if (decode) out.delete('content-encoding');
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        ok(new Response(empty ? null : (Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>), { status, headers: out }));
      });
      req.on('error', fail);
      req.end();
    })) as typeof fetch;
}
