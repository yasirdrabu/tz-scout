import { monotonicFactory } from 'ulid';

export type IdPrefix =
  | 't'
  | 'usr'
  | 'mbr'
  | 'key'
  | 'con'
  | 'run'
  | 'evt'
  | 'cor'
  | 'job'
  | 'inv'
  | 'cred'
  | 'call'
  | 'aud'
  | 'dead'
  | 'sch';

const ulid = monotonicFactory();

/** Prefixed ULID, e.g. `t_01H...`. Monotonic, so ids sort in creation order. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
