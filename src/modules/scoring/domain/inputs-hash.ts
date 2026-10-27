// A fingerprint of everything a score reads, so an unchanged input writes nothing (SCO-E5).

import { createHash } from 'node:crypto';

/** JSON with keys sorted at every depth; Dates become ISO strings through toJSON. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** sha256 of the canonical inputs without `now`, which changes every run. */
export function inputsHash(inputs: Record<string, unknown>): string {
  const { now: _now, ...rest } = inputs;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}
