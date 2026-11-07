import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useFormat } from '../../lib/useFormat';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { sameSelection, scorecardQuery, type Cell, type OfferRow, type PracticeRow, type Scope, type Scorecard as ScorecardData, type ScorecardTab, type SellerRow, type Selection } from './api';
import styles from './Scorecard.module.css';

const route = getRouteApi('/t/$tenant/overview');

const TABS: { id: ScorecardTab; label: string; foot: string }[] = [
  { id: 'sellers', label: 'By seller', foot: 'Green is at or better than the team, amber needs attention.' },
  { id: 'offers', label: 'By offer', foot: "Won value and pipeline use deal amounts, or the offer's price when a deal has none." },
  { id: 'practices', label: 'By practice', foot: "Totals across each practice's offers. Won value and pipeline use deal amounts, or offer prices." },
];

type Fmt = ReturnType<typeof useFormat>;
type Row = SellerRow | OfferRow | PracticeRow;
type Unit = 'count' | 'pct' | 'hours' | 'money';

/** A column: its header, what it sorts by, and what the cell shows (a clickable number with a metric key, or plain text). */
type Column = { id: string; label: string; sort: (r: Row) => number | string | null; show: (r: Row, f: Fmt) => ReactNode; metric?: { key: string; cell: (r: Row) => Cell; unit: Unit; scope: (r: Row) => Scope } };

const cellOf = (r: Row, field: string) => (r as unknown as Record<string, Cell>)[field]!;

function number(field: string, label: string, unit: Unit, metricKey: string, scope: (r: Row) => Scope): Column {
  return { id: field, label, sort: (r) => cellOf(r, field).value, show: () => null, metric: { key: metricKey, cell: (r) => cellOf(r, field), unit, scope } };
}

const sellerScope = (r: Row): Scope => ({ seller: (r as SellerRow).seller_user_id });
const offerScope = (r: Row): Scope => ({ offer: (r as OfferRow).offer_id });
const practiceScope = (r: Row): Scope => ({ practice: (r as PracticeRow).practice_id });

const name = (label: string, sub: (r: Row) => string | null): Column => ({
  id: 'name',
  label,
  sort: (r) => r.name,
  show: (r) => (
    <>
      <span className={styles.name}>{r.name}</span>
      {sub(r) && <span className={styles.sub}>{sub(r)}</span>}
    </>
  ),
});

const product = (prefix: 'offer' | 'practice', scope: (r: Row) => Scope): Column[] => [
  number('matched', 'Matched', 'count', `${prefix}.matched`, scope),
  number('opportunities', 'Opportunities', 'count', `${prefix}.opportunities`, scope),
  number('won', 'Won', 'count', `${prefix}.won`, scope),
  number('win_rate', 'Win rate', 'pct', `${prefix}.win_rate`, scope),
  number('won_value_cents', 'Won value', 'money', `${prefix}.won_value`, scope),
  number('pipeline_cents', 'Pipeline', 'money', `${prefix}.pipeline`, scope),
];

const COLUMNS: Record<ScorecardTab, Column[]> = {
  sellers: [
    name('Seller', (r) => `${(r as SellerRow).assigned} accounts assigned`),
    number('accepted', 'Accepted', 'pct', 'seller.accepted', sellerScope),
    number('time_to_accept', 'Time to accept', 'hours', 'seller.time_to_accept', sellerScope),
    number('steps_on_time', 'Steps on time', 'pct', 'seller.steps_on_time', sellerScope),
    number('meetings', 'Meetings', 'count', 'seller.meetings', sellerScope),
    number('opportunities', 'Opportunities', 'count', 'seller.opportunities', sellerScope),
    number('won', 'Won', 'count', 'seller.won', sellerScope),
    number('pipeline_cents', 'Pipeline', 'money', 'seller.pipeline', sellerScope),
    number('win_rate', 'Win rate', 'pct', 'seller.win_rate', sellerScope),
  ],
  offers: [
    name('Offer', (r) => (r as OfferRow).practice_name),
    { id: 'price', label: 'Price', sort: (r) => (r as OfferRow).price_label, show: (r) => (r as OfferRow).price_label ?? '–' },
    ...product('offer', offerScope),
  ],
  practices: [
    name('Practice', (r) => ((r as PracticeRow).lead_name ? `Led by ${(r as PracticeRow).lead_name}` : null)),
    { id: 'offers', label: 'Offers', sort: (r) => (r as PracticeRow).offers, show: (r, f) => f.number((r as PracticeRow).offers) },
    ...product('practice', practiceScope),
  ],
};

function show(c: Cell, unit: Unit, f: Fmt): string {
  if (c.value === null) return '–';
  switch (unit) {
    case 'pct':
      return `${c.value}%`;
    case 'hours':
      return `${c.value} h`;
    case 'money':
      return f.money(c.value);
    default:
      return f.number(c.value);
  }
}

/** Orders two values in `dir` (1 ascending, -1 descending); a missing value is always last. */
function compare(a: number | string | null, b: number | string | null, dir: 1 | -1): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b)) : a - b) * dir;
}

/** §9 scorecard: one table per tab, each number opening the detail drawer. */
export function Scorecard({ tenant, tab, selected, open }: { tenant: string; tab: ScorecardTab; selected: Selection | null; open: (s: Selection) => void }) {
  const navigate = route.useNavigate();
  const q = useQuery(scorecardQuery(tenant, tab));
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <section className={styles.card} aria-label="Scorecard">
      <div role="tablist" aria-label="Scorecard" className={styles.tabs}>
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`score-tab-${t.id}`} aria-selected={t.id === tab} aria-controls="score-panel" className={styles.tab} onClick={() => void navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, tab: t.id }) })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="score-panel" aria-labelledby={`score-tab-${tab}`}>
        {q.isPending ? (
          <LoadingRows>Loading the scorecard</LoadingRows>
        ) : q.isError ? (
          <LoadFailed title="The scorecard didn't load" error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Table key={tab} data={q.data} selected={selected} open={open} />
        )}
        <p className={styles.foot}>{current.foot}</p>
      </div>
    </section>
  );
}

function Table({ data, selected, open }: { data: ScorecardData; selected: Selection | null; open: (s: Selection) => void }) {
  const f = useFormat();
  const columns = COLUMNS[data.tab];
  const [sort, setSort] = useState<{ id: string; dir: 'descending' | 'ascending' } | null>(null);
  const col = sort && columns.find((c) => c.id === sort.id);
  const dir = sort?.dir === 'ascending' ? 1 : -1;
  const rows = col ? [...data.rows].sort((a, b) => compare(col.sort(a), col.sort(b), dir)) : data.rows;
  const rowKey = (r: Row) => (r as SellerRow).seller_user_id ?? (r as OfferRow).offer_id ?? (r as PracticeRow).practice_id;
  if (rows.length === 0) return <p className={styles.empty}>Nothing to show for this quarter yet.</p>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col" aria-sort={sort?.id === c.id ? sort.dir : 'none'} className={c.id === 'name' ? styles.left : undefined}>
                <button type="button" className={styles.sortBtn} onClick={() => setSort(sort?.id === c.id && sort.dir === 'descending' ? { id: c.id, dir: 'ascending' } : { id: c.id, dir: 'descending' })}>
                  {c.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => {
                if (!c.metric) {
                  return (
                    <td key={c.id} className={c.id === 'name' ? styles.left : undefined}>
                      {c.show(r, f)}
                    </td>
                  );
                }
                const cell = c.metric.cell(r);
                const sel: Selection = { key: c.metric.key, scope: c.metric.scope(r) };
                const tone = cell.tone === 'good' ? styles.good : cell.tone === 'attention' ? styles.attention : '';
                const toneWord = cell.tone === 'good' ? (data.tab === 'sellers' ? 'At or better than the team' : 'Good') : cell.tone === 'attention' ? 'Needs attention' : null;
                return (
                  <td key={c.id}>
                    <button type="button" className={`${styles.cell} ${tone}`} aria-pressed={sameSelection(selected, sel)} onClick={() => open(sel)}>
                      <span className={styles.num}>{show(cell, c.metric.unit, f)}</span>
                      {cell.sub && <span className={styles.sub}>{cell.sub}</span>}
                      {toneWord && <span className="sr-only">{` ${toneWord}`}</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
