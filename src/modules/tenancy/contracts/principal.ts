import { ScoutError } from '@/platform/errors';
import { describeLimit, type DataLimit } from '../domain/data-limit';
import type { Permission } from '../domain/permissions';

/** Who is acting. The single permission model for the web app, API and MCP. */
export type Principal = {
  tenantId: string;
  kind: 'user' | 'api_key' | 'oauth';
  id: string;
  userId?: string;
  sourceId?: string;
  permissions: Permission[];
  dataLimit: DataLimit;
  platformAdmin: boolean;
  supportAccess: boolean;
};

export function can(p: Principal, perm: Permission): boolean {
  return p.platformAdmin || p.permissions.includes(perm);
}

export function requirePermission(p: Principal, perm: Permission): void {
  if (can(p, perm)) return;
  throw new ScoutError({
    slug: 'forbidden',
    status: 403,
    title: 'Forbidden',
    detail:
      p.kind === 'user' ? "You don't have access to that." : `This key can't do that. It needs the \`${perm}\` scope.`,
  });
}

/** Plain-words lines for the profile page: which rows the principal can see, and a hint when it can do nothing. */
export function describeAccess(p: Principal): string[] {
  const lines = describeLimit(p.dataLimit);
  if (p.permissions.length === 0 && !p.platformAdmin) lines.push("You can't do anything yet. Ask an owner for access.");
  return lines;
}
