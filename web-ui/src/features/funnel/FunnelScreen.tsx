import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useId } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import page from '../../routes/Page.module.css';
import { EmptyState } from '../../ui/EmptyState';
import table from '../../ui/Table.module.css';
import { offersQuery, practicesQuery } from '../offers/api';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { batchOptionsQuery, DEFAULT_PERIOD, funnelQuery, PERIODS, STATUS_WORD, type Funnel, type FunnelFilters, type FunnelRow } from './api';
import styles from './Funnel.module.css';

const route = getRouteApi('/t/$tenant/funnel');

/** §16 Funnel by source: how many accounts each source moved through each stage, and what each cost. */
export function FunnelScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const me = useQuery(meQuery(tenant));
  const filters: FunnelFilters = { period: search.period, practice: search.practice, offer: search.offer, batch: search.batch };
  const data = useQuery(funnelQuery(tenant, filters));
  const practices = useQuery(practicesQuery(tenant));
  const offers = useQuery(offersQuery(tenant));
  const batches = useQuery(batchOptionsQuery(tenant));
  const showSpend = !!me.data && hasScope(me.data, 'costs:read');
  const update = (patch: FunnelFilters) => void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const offerList = (offers.data ?? []).filter((o) => !search.practice || o.practice_id === search.practice);
  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Funnel by source</h1>
        <p className={page.sub}>How many accounts each source moved through each stage, and what each one cost. Click a source for its stage-by-stage detail.</p>
      </div>
      <div className={styles.filters}>
        <Filter label="Practice" value={search.practice} all="All practices" options={(practices.data ?? []).map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => update({ practice: v, offer: undefined })} />
        <Filter label="Offer" value={search.offer} all="All offers" options={offerList.map((o) => ({ value: o.id, label: o.name }))} onChange={(v) => update({ offer: v })} />
        <Filter label="Batch" value={search.batch} all="All batches" options={(batches.data ?? []).map((b) => ({ value: b.id, label: b.name }))} onChange={(v) => update({ batch: v })} />
        <Filter label="Period" value={search.period ?? DEFAULT_PERIOD} options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} onChange={(v) => update({ period: v })} />
      </div>
      {me.isPending || data.isPending ? (
        <LoadingRows>Loading the funnel</LoadingRows>
      ) : data.isError ? (
        <LoadFailed title="The funnel didn't load" error={data.error} onRetry={() => void data.refetch()} />
      ) : data.data.rows.length === 0 ? (
        <EmptyState title="No accounts arrived in this period.">Try a longer period, or clear the filters.</EmptyState>
      ) : (
        <Body tenant={tenant} funnel={data.data} showSpend={showSpend} filters={filters} />
      )}
    </div>
  );
}

function Filter({ label, value, all, options, onChange }: { label: string; value: string | undefined; all?: string; options: { value: string; label: string }[]; onChange: (v: string | undefined) => void }) {
  const id = useId();
  return (
    <div className={styles.filter}>
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        {all && <option value="">{all}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Body({ tenant, funnel: fn, showSpend, filters }: { tenant: string; funnel: Funnel; showSpend: boolean; filters: FunnelFilters }) {
  const f = useFormat();
  const t = fn.totals;
  const cost = (cents: number | null) => (cents === null ? '' : f.money(cents));
  const carry = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  return (
    <>
      <ul className={showSpend ? styles.tiles : `${styles.tiles} ${styles.tilesTwo}`} aria-label="Funnel totals">
        <Tile label="Accounts sent" value={f.number(t.sent)} note={t.sources === 1 ? '1 source' : `${f.number(t.sources)} sources`} />
        <Tile label="Won" value={f.number(t.won)} note={`${t.won_pct ?? 0}% of sent`} />
        {showSpend && t.spend_cents !== null && <Tile label="Spend" value={f.money(t.spend_cents)} note="All sources and shared costs" />}
        {showSpend && (
          <Tile
            label="Cost per won account"
            value={t.cost_per_won_cents === null ? 'No wins yet' : f.money(t.cost_per_won_cents)}
            note={fn.target_cost_per_won_cents === null ? 'No target set' : `Target ${f.money(fn.target_cost_per_won_cents)}`}
          />
        )}
      </ul>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Source</th>
              {fn.stages.map((s) => (
                <th key={s.key} scope="col" className={table.num}>
                  {s.name}
                </th>
              ))}
              {showSpend && (
                <th scope="col" className={table.num}>
                  Spend
                </th>
              )}
              {showSpend && (
                <th scope="col" className={table.num}>
                  Cost per won account
                </th>
              )}
              <th scope="col">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {fn.rows.map((r) => (
              <tr key={r.source_id}>
                <td>
                  <Link to="/t/$tenant/funnel/$sourceId" params={{ tenant, sourceId: r.source_id }} search={carry} className={table.open}>
                    {r.name}
                  </Link>
                  <div className={styles.sub}>{r.kind}</div>
                </td>
                {fn.stages.map((s, k) => {
                  const per = showSpend ? r.cost_per_account_cents?.[k] : null;
                  const note = [r.step_pct[k] != null ? `${r.step_pct[k]}% from previous stage` : null, per != null ? `${cost(per)} per account` : null].filter(Boolean).join(' · ');
                  return (
                    <td key={s.key} className={table.num}>
                      <div className={styles.count}>{f.number(r.counts[k] ?? 0)}</div>
                      {note && <div className={styles.sub}>{note}</div>}
                    </td>
                  );
                })}
                {showSpend && <td className={table.num}>{r.spend_cents === null ? '' : f.money(r.spend_cents)}</td>}
                {showSpend && (
                  <td className={table.num}>
                    <CostPerWon row={r} />
                  </td>
                )}
                <td>
                  <WinRate pct={r.win_rate_pct} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showSpend && <p className={styles.legend}>Cost per won account: green at or under the target, amber within 50% over it, red above that. Gray means there is not enough to judge yet.</p>}
    </>
  );
}

function CostPerWon({ row }: { row: FunnelRow }) {
  const f = useFormat();
  const status = row.status;
  const word = status ? STATUS_WORD[status] : undefined;
  const tone = status === 'good' ? styles.good : status === 'amber' ? styles.amber : status === 'red' ? styles.red : styles.gray;
  return (
    <span data-testid="cost-per-won" className={`${styles.cost} ${tone}`}>
      {word ?? (row.cost_per_won_cents === null ? '' : f.money(row.cost_per_won_cents))}
    </span>
  );
}

function WinRate({ pct }: { pct: number | null }) {
  const value = pct ?? 0;
  return (
    <div className={styles.rate}>
      <div className={styles.track} role="meter" aria-label="Win rate" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <div className={styles.fill} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span>{`${value}%`}</span>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <li className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileNote}>{note}</span>
    </li>
  );
}
