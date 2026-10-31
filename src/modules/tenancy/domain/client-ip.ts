/**
 * The client's address from `X-Forwarded-For`, given how many proxies in front of Scout append to
 * it (`hops`). Each trusted proxy appends the address it saw, so the client is the `hops`-th entry
 * from the right; anything further left was sent by the client and can be spoofed. With 0 hops the
 * header is ignored, and with fewer entries than hops the address is unknown (null).
 */
export function forwardedClientIp(header: string | null, hops: number): string | null {
  if (hops <= 0 || !header) return null;
  const entries = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length < hops) return null;
  return entries[entries.length - hops] ?? null;
}
