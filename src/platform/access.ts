import type { ModuleContext } from './context';

/** Which rows a caller may see. Set per principal; modules turn it into row filters. */
export type DataLimit =
  | { kind: 'all' }
  | { kind: 'practices'; ids: string[] }
  | { kind: 'own_accounts' }
  | { kind: 'sources'; ids: string[] }
  | { kind: 'own_source' }
  | { kind: 'any_of'; limits: DataLimit[] };

/** Who is asking and what they may see, as modules need it. */
export type Access = {
  userId?: string;
  sourceId?: string;
  childSourceIds?: string[];
  dataLimit: DataLimit;
};

/** Access from a principal's own fields. `accessWithSources` adds the person source and child sources. */
export function accessFor(p: { userId?: string; sourceId?: string; dataLimit: DataLimit }): Access {
  return {
    ...(p.userId ? { userId: p.userId } : {}),
    ...(p.sourceId ? { sourceId: p.sourceId } : {}),
    dataLimit: p.dataLimit,
  };
}

/** How access finds sources. The accounts module's `SourceAccessProvider` port fits it. */
export type SourceLookup = {
  childSources(ctx: ModuleContext, sourceIds: string[]): Promise<string[]>;
  personSourceFor(ctx: ModuleContext, userId: string): Promise<string | undefined>;
};

/**
 * Access for a principal with its sources filled in: a signed-in person acts as their person source,
 * and `childSourceIds` lists every source below the principal's own.
 */
export async function accessWithSources(
  ctx: ModuleContext,
  p: { kind: string; userId?: string; sourceId?: string; dataLimit: DataLimit },
  sources: SourceLookup,
): Promise<Access> {
  const access = accessFor(p);
  if (p.kind === 'user' && p.userId) {
    const own = await sources.personSourceFor(ctx, p.userId);
    if (own) access.sourceId = own;
  }
  if (access.sourceId) access.childSourceIds = await sources.childSources(ctx, [access.sourceId]);
  return access;
}
