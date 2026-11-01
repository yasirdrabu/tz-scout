import { MessageSquare } from 'lucide-react';
import { cx } from '../../lib/cx';
import type { Color, HandoffState, QueueRow } from './api';
import styles from './Review.module.css';

/** The handoff state as people see it (screens.md, Handoff state). */
export const HANDOFF: Record<HandoffState, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' }> = {
  sending: { label: 'Sending to HubSpot', tone: 'gray' },
  in_crm: { label: 'In HubSpot', tone: 'green' },
  needs_decision: { label: 'HubSpot needs a decision', tone: 'amber' },
  failed: { label: 'HubSpot send failed', tone: 'red' },
  cancelled: { label: 'HubSpot send cancelled', tone: 'gray' },
};

export function HandoffChip({ state }: { state: string }) {
  const h = HANDOFF[state as HandoffState];
  if (!h) return null;
  return <Flag tone={h.tone}>{h.label}</Flag>;
}

/** A small flag chip; its color carries meaning only together with its words. */
export function Flag({ tone, title, children }: { tone: 'gray' | 'green' | 'amber' | 'red'; title?: string; children: string }) {
  return (
    <span className={cx(styles.flag, styles[`flag_${tone}`])} {...(title ? { title } : {})}>
      {children}
    </span>
  );
}

/** A review status: a dot in the status's color from Settings and its name. */
export function StatusDot({ color, children }: { color: Color | null | undefined; children: string }) {
  return (
    <span className={styles.status}>
      <span className={cx(styles.dot, styles[`dot_${color ?? 'gray'}`])} aria-hidden="true" />
      {children}
    </span>
  );
}

const TIER_LOOK: Record<string, string | undefined> = { act_now: styles.tier_act, good_fit: styles.tier_good, watch: styles.tier_watch, nurture: styles.tier_nurture };

/** A tier chip: Act now plum, Good fit light plum, Watch gray, Nurture a quiet dashed outline, Not a fit white. The name is the API's. */
export function TierChip({ tier, label }: { tier: string | null; label: string }) {
  return <span className={cx(styles.tier, (tier && TIER_LOOK[tier]) || styles.tier_low)}>{label}</span>;
}

/** A score: the number, bold, and a 4 px bar. */
export function Score({ value }: { value: number | null }) {
  if (value === null) return <span className={styles.muted}>Not scored</span>;
  return (
    <div className={styles.score}>
      <strong>{value}</strong>
      <div className={styles.bar} aria-hidden="true">
        <div className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function NoteCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className={styles.notes}>
      <MessageSquare aria-hidden="true" />
      {count}
      {' '}
      <span className="sr-only">{count === 1 ? 'note' : 'notes'}</span>
    </span>
  );
}

export const locationOf = (r: { hq_city: string | null; hq_state: string | null }) => [r.hq_city, r.hq_state].filter(Boolean).join(', ');

/** "{industry} · {location}", leaving out what is missing. */
export const kindAndPlace = (r: { industry: string | null; hq_city: string | null; hq_state: string | null }) =>
  [r.industry, locationOf(r)].filter(Boolean).join(' · ');

/** The flag chips a queue row shows, in the order of screens.md §2. */
export function RowFlags({ row, date }: { row: QueueRow; date: (when: string) => string }) {
  const f = row.flags;
  const chips = [
    f.declined_by_seller && (
      <Flag key="declined" tone="amber" title={`${f.declined_by_seller.reason_label} · ${date(f.declined_by_seller.at)}`}>
        {`Declined by ${f.declined_by_seller.seller_name}`}
      </Flag>
    ),
    f.new_from && (
      <Flag key="new" tone="gray">
        {`New from ${f.new_from.source_name ?? 'a source'}`}
      </Flag>
    ),
    row.warm_intro && (
      <Flag key="warm" tone="green">
        Warm intro
      </Flag>
    ),
    f.handoff && <HandoffChip key="handoff" state={f.handoff.state} />,
    row.conflict_count > 0 && (
      <Flag key="conflicts" tone="amber">
        {row.conflict_count === 1 ? '1 conflict' : `${row.conflict_count} conflicts`}
      </Flag>
    ),
    row.enrichment_requested && (
      <Flag key="enrich" tone="gray">
        Enrichment requested
      </Flag>
    ),
  ].filter(Boolean);
  if (chips.length === 0) return null;
  return <div className={styles.flags}>{chips}</div>;
}
