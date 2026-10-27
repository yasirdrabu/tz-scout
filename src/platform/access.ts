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

/** Access from a principal's own fields. Child sources are added later, by the accounts module. */
export function accessFor(p: { userId?: string; sourceId?: string; dataLimit: DataLimit }): Access {
  return {
    ...(p.userId ? { userId: p.userId } : {}),
    ...(p.sourceId ? { sourceId: p.sourceId } : {}),
    dataLimit: p.dataLimit,
  };
}
