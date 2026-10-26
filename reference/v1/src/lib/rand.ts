// Deterministic pseudo-random numbers for mocks and seed data, so the same input always
// produces the same "realistic" output.

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: string | number): () => number {
  let a = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
export const intBetween = (r: () => number, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
