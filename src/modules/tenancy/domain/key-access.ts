import type { Permission } from './permissions';

/**
 * What a key can do, as offered on the API keys screen (§21c), and the scopes each choice gives.
 * `GET /api/v1/arrivals/{id}` needs `arrivals:read`; `status:read` adds the owner name and account status.
 */
export const KEY_ACCESS = {
  send_and_status: ['arrivals:write', 'arrivals:read', 'status:read'],
  send_only: ['arrivals:write'],
  read_only: ['accounts:read', 'status:read'],
} as const satisfies Record<string, readonly Permission[]>;

export type KeyAccess = keyof typeof KEY_ACCESS;
export const KEY_ACCESS_CHOICES = Object.keys(KEY_ACCESS) as [KeyAccess, ...KeyAccess[]];

/** How a key is shown: its stored prefix and an ellipsis (the rest of the secret is never kept). */
export const keyMask = (prefix: string): string => `${prefix}…`;
