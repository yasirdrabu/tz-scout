// Deterministic pseudo-random numbers for the sample adapters (from v1 `lib/rand.ts`), so the same domain always
// gets the same made-up company. None of the companies or people are real.

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);
export const intBetween = (r: () => number, lo: number, hi: number): number => Math.floor(between(r, lo, hi + 1));
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** "northgate-freight.com" -> "Northgate Freight". */
export const nameFromDomain = (domain: string): string =>
  (domain.split('.')[0] ?? domain)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || domain;

const DAY = 86400_000;
/** The date `days` ago, as `YYYY-MM-DD`. */
export const daysAgo = (days: number, now = new Date()): string => new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
