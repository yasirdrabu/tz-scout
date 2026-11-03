import { isIP, isIPv4 } from 'node:net';

// Which hosts and addresses the website reader may reach (review I-1). Account data supplies the domain, so the
// server must never be pointed at its own network: names are checked here before a request, and every address a name
// resolves to is checked when the connection is made (`live-transport.ts`), so the address checked is the one dialled.

const v4 = (ip: string): number[] | null => {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", unspecified
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 protocol assignments, 192.0.2/24 documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a! >= 224 // multicast and reserved, broadcast
  );
}

/** True for any address the reader must not connect to. Anything that does not parse is blocked. */
export function isBlockedAddress(address: string): boolean {
  const raw = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIPv4(raw)) return blockedV4(v4(raw)!);
  if (isIP(raw) !== 6) return true;
  // The URL parser writes IPv6 in its shortest form (and IPv4-mapped tails as hex), so one set of checks covers all spellings.
  const ip = new URL(`http://[${raw}]`).hostname.slice(1, -1);
  if (ip === '::' || ip === '::1') return true;
  const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (/^::ffff:/.test(ip) || /^::[0-9a-f]/.test(ip)) return true; // other IPv4-compatible forms
  const [first, second] = ip.split(':').map((h) => parseInt(h || '0', 16)) as [number, number];
  return (
    (first === 0x64 && second === 0xff9b) || // NAT64 64:ff9b::/96 and the local-use 64:ff9b:1::/48 (both in 64:ff9b::/32)
    first === 0x2002 || // 6to4 2002::/16, which carries an IPv4 address
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated, still routed on some networks)
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** The host a domain names, as the URL parser reads it ("0x7f.1" is "127.0.0.1"), or null when it is not a host. */
export function normaliseHost(domain: string): string | null {
  try {
    const u = new URL(`https://${domain.trim()}`);
    return u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash ? null : u.hostname;
  } catch {
    return null;
  }
}

/** A public host name: dotted, not an IP address, not localhost or an internal name. Takes a URL-parsed hostname. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || isIP(h) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h);
}
