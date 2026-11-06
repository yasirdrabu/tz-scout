import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ApiError } from '../../api/errors';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import page from '../../routes/Page.module.css';
import { buttonClass } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import table from '../../ui/Table.module.css';
import { kindLabel } from '../sources/api';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { drillQuery, PERIODS, STATUS_WORD, type Drill, type DrillStage, type FunnelFilters } from './api';
import styles from './Funnel.module.css';

const route = getRouteApi('/t/$tenant/funnel/$sourceId');

/** §17 Funnel drill by source: one source stage by stage against all sources. */
export function DrillScreen() {
  const { tenant, sourceId } = route.useParams();
  const search = route.useSearch();
  const me = useQuery(meQuery(tenant));
  const filters: FunnelFilters = { period: search.period, practice: search.practice, offer: search.offer, batch: search.batch };
  const data = useQuery(drillQuery(tenant, sourceId, filters));
  const carry = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  if (me.isPending || data.isPending) {
    return (
      <div className={page.page}>
        <LoadingRows>Loading the source</LoadingRows>
      </div>
    );
  }
  if (data.isError) {
    return (
      <div className={page.page}>
        {data.error instanceof ApiError && data.error.status === 404 ? (
          <EmptyState
            title="That source was not found."
            actions={
              <Link to="/t/$tenant/funnel" params={{ tenant }} search={carry} className={buttonClass('secondary', 'sm')}>
                Back to the funnel
              </Link>
            }
          >
            It may have been removed.
          </EmptyState>
        ) : (
          <LoadFailed title="The source didn't load" error={data.error} onRetry={() => void data.refetch()} />
        )}
      </div>
    );
  }
  return <Body tenant={tenant} drill={data.data} carry={carry} showSpend={!!me.data && hasScope(me.data, 'costs:read')} />;
}

function Body({ tenant, drill: d, carry, showSpend }: { tenant: string; drill: Drill; carry: Record<string, string>; showSpend: boolean }) {
  const f = useFormat();
  const t = d.totals;
  const period = PERIODS.find((p) => p.key === d.period.key)?.label ?? d.period.key;
  const target = d.target_cost_per_won_cents === null ? 'No target set' : `target ${f.money(d.target_cost_per_won_cents)}`;
  const costNote = d.rank === null ? target : `Ranks ${d.rank} of ${d.of} · ${target}`;
  const costWord = t.status ? STATUS_WORD[t.status] : undefined;
  const sibling = (id: string, label: string) => (
    <Link to="/t/$tenant/funnel/$sourceId" params={{ tenant, sourceId: id }} search={carry} className={buttonClass('secondary', 'sm')} aria-label={label}>
      {label === 'Previous source' ? 'Previous' : 'Next'}
    </Link>
  );
  return (
    <div className={page.page}>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>
            <Link to="/t/$tenant/funnel" params={{ tenant }} search={carry}>
              Funnel by source
            </Link>
          </li>
          <li aria-current="page">{d.source.name}</li>
        </ol>
      </nav>
      <div className={styles.drillHead}>
        <div>
          <h1 className={page.title}>{d.source.name}</h1>
          <p className={page.sub}>{`${kindLabel(d.source.kind)} · ${period}`}</p>
        </div>
        <div className={styles.drillActions}>
          {d.position !== null && d.row_count !== null && <span className={styles.sub}>{`${d.position} of ${d.row_count}`}</span>}
          {d.prev_id && sibling(d.prev_id, 'Previous source')}
          {d.next_id && sibling(d.next_id, 'Next source')}
          <Link to="/t/$tenant/sources/$id" params={{ tenant, id: d.source.id }} className={buttonClass('primary', 'sm')}>
            Open source page
          </Link>
        </div>
      </div>
      <ul className={showSpend ? styles.tiles : `${styles.tiles} ${styles.tilesTwo}`} aria-label="Source totals">
        <Tile label="Sent" value={f.number(t.sent)} note="Accounts into review" />
        <Tile label="Won" value={f.number(t.won)} note={`${t.won_pct ?? 0}% of sent · all sources ${t.all_won_pct ?? 0}%`} />
        {showSpend && t.spend_cents !== null && <Tile label="Spend" value={f.money(t.spend_cents)} note={t.cost_per_sent_cents === null ? null : `${f.money(t.cost_per_sent_cents)} per account sent`} />}
        {showSpend && <Tile label="Cost per won account" value={t.cost_per_won_cents === null ? (costWord ?? 'No wins yet') : f.money(t.cost_per_won_cents)} note={costNote} />}
      </ul>
      {d.insight && <p className={styles.insight}>{d.insight}</p>}
      <div className={table.wrap}>
        <table className={table.table} aria-label="Stage by stage">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Accounts</th>
              <th scope="col" className={table.num}>
                Moved on
              </th>
              <th scope="col" className={table.num}>
                Lost
              </th>
              {showSpend && (
                <th scope="col" className={table.num}>
                  Cost each
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {d.stages.map((s) => (
              <StageRow key={s.key} stage={s} base={d.stages[0]?.count ?? 0} allBase={d.stages[0]?.all_count ?? 0} showSpend={showSpend} />
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.lists}>
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Batches</h2>
          {d.batches.length === 0 ? (
            <p className={styles.sub}>No batches from this source in this period.</p>
          ) : (
            <ul className={styles.plain} aria-label="Batches">
              {d.batches.map((b) => (
                <li key={b.batch_id}>
                  <Link to="/t/$tenant/batches/$id" params={{ tenant, id: b.batch_id }} className={table.open}>
                    {b.name}
                  </Link>
                  <span className={styles.sub}>{` ${f.number(b.sent)} sent · ${f.number(b.won)} won`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Won accounts</h2>
          {d.won_accounts.length === 0 ? (
            <p className={styles.sub}>No wins from this source yet.</p>
          ) : (
            <ul className={styles.plain} aria-label="Won accounts">
              {d.won_accounts.map((a) => (
                <li key={a.account_id}>
                  <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: a.account_id }} className={table.open}>
                    {a.name}
                  </Link>
                  <span className={styles.sub}>{` ${[a.offer_name, a.value_cents === null ? 'No value' : f.money(a.value_cents)].filter(Boolean).join(' · ')}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function StageRow({ stage: s, base, allBase, showSpend }: { stage: DrillStage; base: number; allBase: number; showSpend: boolean }) {
  const f = useFormat();
  const width = base > 0 ? Math.min((s.count / base) * 100, 100) : 0;
  const allAt = allBase > 0 ? Math.min((s.all_count / allBase) * 100, 100) : null;
  const diff = s.moved_on_pct !== null && s.all_moved_on_pct !== null ? s.moved_on_pct - s.all_moved_on_pct : null;
  return (
    <tr>
      <td>{s.name}</td>
      <td>
        <div className={styles.rate}>
          <div className={styles.track} role="meter" aria-label={`${s.name} accounts`} aria-valuemin={0} aria-valuemax={base} aria-valuenow={s.count}>
            <div className={styles.fill} style={{ width: `${width}%` }} />
            {allAt !== null && <div className={styles.marker} style={{ left: `${allAt}%` }} title="All sources" />}
          </div>
          <span>{f.number(s.count)}</span>
        </div>
      </td>
      <td className={table.num}>
        {s.moved_on_pct !== null && <div className={styles.count}>{`${s.moved_on_pct}%`}</div>}
        {diff !== null && <div className={styles.sub}>{`${diff >= 0 ? '+' : '-'}${Math.abs(diff)} points vs all sources`}</div>}
      </td>
      <td className={table.num}>{f.number(s.lost)}</td>
      {showSpend && <td className={table.num}>{s.cost_each_cents === null ? '' : f.money(s.cost_each_cents)}</td>}
    </tr>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string | null }) {
  return (
    <li className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note && <span className={styles.tileNote}>{note}</span>}
    </li>
  );
}
