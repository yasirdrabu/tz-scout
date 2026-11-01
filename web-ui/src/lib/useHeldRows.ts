import { useState } from 'react';

/** How many rows were added, removed or changed between the rows shown and the latest ones. */
export function countUpdates<T>(shown: T[], latest: T[], idOf: (row: T) => string): number {
  const before = new Map(shown.map((r) => [idOf(r), JSON.stringify(r)]));
  let n = 0;
  for (const r of latest) {
    const id = idOf(r);
    if (before.get(id) !== JSON.stringify(r)) n++;
    before.delete(id);
  }
  return n + before.size;
}

/**
 * Rows that stay as shown while a background refetch brings changes, so nothing moves under the
 * pointer (C14). `updates` says how many rows the latest data changed and `apply` shows them.
 * Call `follow` before the person's own change (or Show more): the next data then shows at once.
 * `drop` takes rows the person's own action removed out at once, and keeps them out while the
 * API's read model catches up. A new `view` (other filters) shows its rows at once.
 */
export function useHeldRows<T>(latest: T[] | undefined, view: string, idOf: (row: T) => string) {
  const [held, setHeld] = useState<{ view: string; rows: T[] } | null>(null);
  const [seen, setSeen] = useState<T[] | undefined>(undefined);
  const [following, setFollowing] = useState(false);
  const [dropped, setDropped] = useState<{ view: string; ids: Set<string> }>({ view, ids: new Set() });

  if (latest !== seen) {
    setSeen(latest);
    if (latest && (following || !held || held.view !== view)) {
      setHeld({ view, rows: latest });
      setFollowing(false);
    }
  }

  const gone = dropped.view === view ? dropped.ids : new Set<string>();
  const keep = (rows: T[] | undefined) => rows?.filter((r) => !gone.has(idOf(r)));
  const current = keep(held && held.view === view ? held.rows : latest);
  const fresh = keep(latest);
  const rows = current ?? [];
  const updates = current && fresh && held?.rows !== latest ? countUpdates(current, fresh, idOf) : 0;
  return {
    rows,
    updates,
    apply: () => latest && setHeld({ view, rows: latest }),
    follow: () => setFollowing(true),
    drop: (ids: string[]) => setDropped((d) => ({ view, ids: new Set([...(d.view === view ? d.ids : []), ...ids]) })),
  };
}
