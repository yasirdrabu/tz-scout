import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useFormat } from '../../lib/useFormat';
import table from '../../ui/Table.module.css';
import type { Source, SourceStat } from './api';
import styles from './Sources.module.css';

/** The Trust cell: the number with a bar, or, under 10 judged arrivals, the words. */
export function TrustCell({ source: r }: { source: Pick<Source, 'trust' | 'trust_label'> }) {
  if (r.trust_label !== null) return <span className={table.muted}>{r.trust_label}</span>;
  return (
    <span className={styles.trust}>
      <span className={styles.trustNumber}>{r.trust}</span>
      <span className={styles.trustTrack} aria-hidden="true">
        <span className={styles.trustFill} style={{ width: `${Math.max(0, Math.min(100, r.trust))}%` }} />
      </span>
    </span>
  );
}

/** Each row's depth in the tree: how many of its ancestors are in the list. */
function depths(rows: Source[]): Map<string, number> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, number>();
  const depth = (r: Source, seen = 0): number => {
    const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
    return parent && seen < 10 ? 1 + depth(parent, seen + 1) : 0;
  };
  for (const r of rows) out.set(r.id, depth(r));
  return out;
}

/** True when an ancestor of the row in the list is collapsed. */
function hidden(r: Source, byId: Map<string, Source>, collapsed: Set<string>): boolean {
  let at = r.parent_id ? byId.get(r.parent_id) : undefined;
  for (let i = 0; at && i < 10; i++) {
    if (collapsed.has(at.id)) return true;
    at = at.parent_id ? byId.get(at.parent_id) : undefined;
  }
  return false;
}

/** The ids of the rows that have children in the list, for Collapse all. */
export const parentsIn = (rows: Source[]) => new Set(rows.filter((r) => rows.some((c) => c.parent_id === r.id)).map((r) => r.id));

type Props = {
  tenant: string;
  rows: Source[];
  stats: Map<string, SourceStat> | undefined;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  /** The Source page's children tab shows fewer columns. */
  columns?: 'all' | 'children';
};

/** §10's tree table: the rows in the API's order, indented under their parent, with the stats beside them. */
export function SourceTree({ tenant, rows, stats, collapsed, onToggle, columns = 'all' }: Props) {
  const f = useFormat();
  const navigate = useNavigate();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = depths(rows);
  const parents = parentsIn(rows);
  const all = columns === 'all';
  const num = (n: number | undefined) => (n === undefined ? <span className={table.muted}>None</span> : f.number(n));
  return (
    <table className={table.table}>
      <thead>
        <tr>
          <th scope="col">Source</th>
          <th scope="col">How it sends</th>
          <th scope="col">Trust</th>
          <th scope="col" className={table.num}>
            Sent
          </th>
          {all && (
            <th scope="col" className={table.num}>
              Reviewed
            </th>
          )}
          <th scope="col" className={table.num}>
            Assigned
          </th>
          <th scope="col" className={table.num}>
            Won
          </th>
          {all && <th scope="col">Last sent</th>}
        </tr>
      </thead>
      <tbody>
        {rows
          .filter((r) => !hidden(r, byId, collapsed))
          .map((r) => {
            const s = stats?.get(r.id);
            const open = !collapsed.has(r.id);
            return (
              <tr key={r.id} className={styles.clickable} onClick={() => void navigate({ to: '/t/$tenant/sources/$id', params: { tenant, id: r.id } })}>
                <td>
                  <span className={styles.name} style={{ paddingLeft: `${(depth.get(r.id) ?? 0) * 20}px` }}>
                    {all && parents.has(r.id) ? (
                      <button
                        type="button"
                        className={styles.caret}
                        aria-label={`${open ? 'Collapse' : 'Expand'} ${r.name}`}
                        aria-expanded={open}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggle(r.id);
                        }}
                      >
                        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                      </button>
                    ) : (
                      all && <span className={styles.spacer} />
                    )}
                    <span>
                      <Link to="/t/$tenant/sources/$id" params={{ tenant, id: r.id }} className={styles.link} onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Link>{' '}
                      {r.status === 'paused' ? <span className={styles.tag}>{r.status_label}</span> : (s?.is_new ?? r.is_new) && <span className={styles.tag}>New</span>}
                      <div className={styles.sub}>{r.kind_label}</div>
                    </span>
                  </span>
                </td>
                <td>{r.method_label}</td>
                <td>
                  <TrustCell source={r} />
                </td>
                <td className={table.num}>{num(s?.sent)}</td>
                {all && <td className={table.num}>{num(s?.reviewed)}</td>}
                <td className={table.num}>{num(s?.assigned)}</td>
                <td className={table.num}>{num(s?.won)}</td>
                {all && <td>{r.last_sent_at ? f.relative(r.last_sent_at) : <span className={table.muted}>Never</span>}</td>}
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}
