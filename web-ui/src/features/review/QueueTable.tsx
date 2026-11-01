import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import type { Column, FacetOption, QueueRow } from './api';
import { kindAndPlace, NoteCount, RowFlags, Score, StatusDot, TierChip } from './parts';
import styles from './Review.module.css';

type Cell = { num?: boolean; render: (r: QueueRow) => ReactNode };

export type QueueTableProps = {
  rows: QueueRow[];
  columns: Column[];
  tiers: FacetOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  peek: string | undefined;
  onOpen: (id: string) => void;
};

/** The queue table (screens.md §2 Columns): Account always, then the person's columns in their order. */
export function QueueTable({ rows, columns, tiers, selected, onToggle, onToggleAll, peek, onOpen }: QueueTableProps) {
  const f = useFormat();
  const shown = new Set(columns.filter((c) => c.visible).map((c) => c.key));
  const tierName = (key: string | null) => (key ? (tiers.find((t) => t.value === key)?.label ?? key) : null);

  const CELLS: Record<string, Cell> = {
    best_offer: {
      render: (r) => (
        <>
          <div className={styles.main}>{r.lead_offer?.name ?? 'None yet'}</div>
          {!shown.has('practice') && r.lead_offer?.practice_name && <div className={styles.sub}>{r.lead_offer.practice_name}</div>}
        </>
      ),
    },
    practice: { render: (r) => <div className={styles.main}>{r.lead_offer?.practice_name ?? r.practice_name ?? 'None'}</div> },
    priority: { num: true, render: (r) => <Score value={r.priority} /> },
    fit: { num: true, render: (r) => <Score value={r.fit} /> },
    intent: { num: true, render: (r) => <Score value={r.intent} /> },
    tier: {
      render: (r) => {
        const name = tierName(r.tier);
        if (!name) return <span className={styles.muted}>Not scored</span>;
        const sub = r.tier_set_by_name ? `Changed by ${r.tier_set_by_name}` : r.previous_tier ? `Was ${tierName(r.previous_tier)}` : null;
        return (
          <>
            <TierChip tier={r.tier} label={name} />
            {sub && <div className={styles.tierSub}>{sub}</div>}
          </>
        );
      },
    },
    source: {
      render: (r) =>
        r.source ? (
          <>
            <div className={styles.main}>{r.source.name}</div>
            {r.source.via && <div className={styles.sub}>{r.source.via}</div>}
          </>
        ) : (
          <span className={styles.muted}>None</span>
        ),
    },
    review_status: {
      render: (r) =>
        r.review_status_label ? (
          <StatusDot color={r.review_status_color}>
            {r.status_changed_by_name ? `${r.review_status_label} by ${r.status_changed_by_name}` : r.review_status_label}
          </StatusDot>
        ) : null,
    },
    flags: { render: (r) => <RowFlags row={r} date={f.date} /> },
    notes: { render: (r) => <NoteCount count={r.note_count} /> },
    arrived: { render: (r) => f.date(r.created_at) },
  };

  const visible = columns.filter((c) => c.visible && CELLS[c.key]);
  const all = rows.length > 0 && rows.slice(0, 50).every((r) => selected.has(r.account_id));

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.check}>
              <input type="checkbox" aria-label="Select all shown" checked={all} onChange={onToggleAll} />
            </th>
            <th scope="col">Account</th>
            {visible.map((c) => (
              <th key={c.key} scope="col" className={cx(CELLS[c.key]!.num && styles.num)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sub = [kindAndPlace(r), !shown.has('arrived') ? `Arrived ${f.date(r.created_at)}` : null].filter(Boolean).join(' · ');
            return (
              <tr
                key={r.account_id}
                className={cx(peek === r.account_id && styles.peeked, r.flags.handoff?.state === 'in_crm' && styles.dim)}
                onClick={() => onOpen(r.account_id)}
              >
                <td className={styles.check} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.account_id)} onChange={() => onToggle(r.account_id)} />
                </td>
                <td>
                  <button type="button" className={styles.name} onClick={(e) => (e.stopPropagation(), onOpen(r.account_id))}>
                    {r.name}
                  </button>
                  {sub && <div className={styles.sub}>{sub}</div>}
                </td>
                {visible.map((c) => (
                  <td key={c.key} className={cx(CELLS[c.key]!.num && styles.num)}>
                    {CELLS[c.key]!.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
