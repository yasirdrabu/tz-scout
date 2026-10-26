import { z } from 'zod';
import type { Role } from '../contracts/members';

export type DataLimit =
  | { kind: 'all' }
  | { kind: 'practices'; ids: string[] }
  | { kind: 'own_accounts' }
  | { kind: 'sources'; ids: string[] }
  | { kind: 'own_source' }
  | { kind: 'any_of'; limits: DataLimit[] };

export const DataLimitSchema: z.ZodType<DataLimit> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }).strict(),
    z.object({ kind: z.literal('practices'), ids: z.array(z.string().min(1)) }).strict(),
    z.object({ kind: z.literal('own_accounts') }).strict(),
    z.object({ kind: z.literal('sources'), ids: z.array(z.string().min(1)) }).strict(),
    z.object({ kind: z.literal('own_source') }).strict(),
    z
      .object({
        kind: z.literal('any_of'),
        limits: z.array(DataLimitSchema).min(1),
      })
      .strict(),
  ]),
);

export const DEFAULT_DATA_LIMIT: Record<Role, DataLimit> = {
  owner: { kind: 'all' },
  leader: { kind: 'all' },
  seller: { kind: 'own_accounts' },
  operator: { kind: 'all' },
};

/** Default limit: by role for people, `own_source` for keys and OAuth grants. */
export function defaultDataLimit(kind: 'api_key' | 'oauth'): DataLimit;
export function defaultDataLimit(kind: 'user', role: Role): DataLimit;
export function defaultDataLimit(kind: 'user' | 'api_key' | 'oauth', role?: Role): DataLimit {
  return kind === 'user' && role ? DEFAULT_DATA_LIMIT[role] : { kind: 'own_source' };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Plain-words lines for one limit. */
export function describeLimit(limit: DataLimit): string[] {
  switch (limit.kind) {
    case 'all':
      return ['You can see every account in this workspace.'];
    case 'practices':
      return [`You can see accounts in ${count(limit.ids.length, 'practice')}.`];
    case 'own_accounts':
      return ['You can see accounts assigned to you, now or before, and accounts you submitted.'];
    case 'sources':
      return [`You can see accounts and arrivals from ${count(limit.ids.length, 'source')} and their child sources.`];
    case 'own_source':
      return ['You can see only the arrivals and accounts that your own source sent.'];
    case 'any_of':
      return [
        'You can see anything that matches one of these:',
        ...limit.limits.flatMap((l) => describeLimit(l).map((s) => `- ${s}`)),
      ];
  }
}

/**
 * True when everything `child` allows is also allowed by `parent`. Conservative: when the two
 * limits cannot be compared with certainty (for example own accounts against a source), it is false.
 */
export function isWithin(child: DataLimit, parent: DataLimit): boolean {
  if (parent.kind === 'all') return true;
  if (child.kind === 'any_of') return child.limits.every((c) => isWithin(c, parent));
  if (parent.kind === 'any_of') return parent.limits.some((p) => isWithin(child, p));
  if (child.kind === 'all') return false;
  if (child.kind === 'own_accounts' || child.kind === 'own_source') return child.kind === parent.kind;
  if (child.kind === 'practices' || child.kind === 'sources') {
    return parent.kind === child.kind && child.ids.every((id) => parent.ids.includes(id));
  }
  return false;
}
