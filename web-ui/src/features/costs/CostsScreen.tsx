import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Coins } from 'lucide-react';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import page from '../../routes/Page.module.css';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { monthName, percentOf, summaryQuery, type CostsSummary } from './api';
import { BudgetBanners } from './BudgetBanners';
import { Budgets } from './Budgets';
import { CostBySource } from './CostBySource';
import { CostPerWonTile } from './CostPerWonTile';
import { CostLines } from './CostLines';
import styles from './Costs.module.css';

const SWATCH = ['var(--accent-700)', 'var(--accent-500)', 'var(--accent-400)', 'var(--accent-300)', 'var(--accent-200)'];

/** §18 Costs (R3a): what finding accounts costs this month and over 90 days, the budgets, and the cost lines. */
export function CostsScreen() {
  const tenant = useParams({ strict: false }).tenant!;
  const me = useQuery(meQuery(tenant));
  const canRead = !!me.data && hasScope(me.data, 'costs:read');
  const summary = useQuery(summaryQuery(tenant, canRead));
  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Costs</h1>
        <p className={page.sub}>What finding accounts costs and where the money goes. Last 90 days.</p>
      </div>
      {me.isPending ? (
        <LoadingRows>Loading costs</LoadingRows>
      ) : me.isError ? (
        <LoadFailed title="Costs didn't load" error={me.error} onRetry={() => void me.refetch()} />
      ) : !canRead ? (
        <EmptyState title="You can't see costs" icon={<Coins />}>
          Ask an owner or leader for the See costs permission.
        </EmptyState>
      ) : summary.isPending ? (
        <LoadingRows>Loading costs</LoadingRows>
      ) : summary.isError ? (
        <LoadFailed title="Costs didn't load" error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <Body tenant={tenant} summary={summary.data} canWriteBudgets={hasScope(me.data!, 'budgets:write')} canWriteCosts={hasScope(me.data!, 'costs:write')} />
      )}
    </div>
  );
}

function Body({ tenant, summary: s, canWriteBudgets, canWriteCosts }: { tenant: string; summary: CostsSummary; canWriteBudgets: boolean; canWriteCosts: boolean }) {
  const f = useFormat();
  const used = s.budget_month_cents > 0 ? percentOf(s.spend_month_cents, s.budget_month_cents) : null;
  const share = (cents: number) => (s.spend_90d_cents > 0 ? percentOf(cents, s.spend_90d_cents) : 0);
  const top = Math.max(...s.months.map((m) => Math.max(m.spend_cents, m.budget_cents)), 1) * 1.1;
  const budgetNow = s.months.at(-1)?.budget_cents ?? s.budget_month_cents;
  return (
    <>
      <BudgetBanners tenant={tenant} />
      <ul className={styles.tiles} aria-label="Cost totals">
        <Tile label="Spend this month" value={f.money(s.spend_month_cents)} note={monthName(s.month)} />
        <Tile label="Budget used" value={used === null ? 'No budget' : `${used}%`} note={used === null ? 'Set a budget below' : `of ${f.money(s.budget_month_cents)} monthly total`} />
        <Tile label="Last 90 days" value={f.money(s.spend_90d_cents)} note="All categories" />
        <Tile label="Cost per account sent" value={s.cost_per_sent_cents === null ? 'None yet' : f.money(s.cost_per_sent_cents)} note="Over 90 days" />
        <CostPerWonTile tenant={tenant} summary={s} canEdit={canWriteBudgets} />
        <Tile label="Return on spend" value={s.return_ratio === null ? 'No spend yet' : `${s.return_ratio}x`} note="Over 90 days" />
      </ul>
      <div className={styles.pair}>
        <Card title="Where the money goes" actions={<span className={styles.total}>{`${f.money(s.spend_90d_cents)} total`}</span>}>
          <div className={styles.split} aria-hidden="true">
            {s.categories.map((c, i) => (
              <div key={c.key} style={{ width: `${share(c.spend_90d_cents)}%`, background: SWATCH[i % SWATCH.length] }} />
            ))}
          </div>
          <ul className={styles.list}>
            {s.categories.map((c, i) => (
              <li key={c.key} className={styles.cat}>
                <span className={styles.swatch} style={{ background: SWATCH[i % SWATCH.length] }} aria-hidden="true" />
                <span>{c.label}</span>
                <span className={styles.amount}>{f.money(c.spend_90d_cents)}</span>
                <span className={styles.pct}>{`${share(c.spend_90d_cents)}%`}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card
          title="Monthly spend"
          actions={
            <span className={styles.legend}>
              <span className={styles.legendLine} aria-hidden="true" />
              {`Budget ${f.money(budgetNow)}`}
            </span>
          }
        >
          <div className={styles.chartWrap}>
            <div className={styles.plot} aria-hidden="true">
              {budgetNow > 0 && <div className={styles.budgetLine} style={{ bottom: `${(budgetNow / top) * 100}%` }} />}
            </div>
            <ul className={styles.chart}>
              {s.months.map((m, i) => {
                const ratio = m.budget_cents > 0 ? m.spend_cents / m.budget_cents : 0;
                const tone = ratio > 1 ? styles.barOver : ratio >= 0.9 ? styles.barWarn : i === s.months.length - 1 ? styles.barNow : '';
                return (
                  <li key={m.month} className={styles.col}>
                    <span className={styles.colAmount}>{f.money(m.spend_cents)}</span>
                    <div className={`${styles.bar} ${tone}`.trim()} style={{ height: `${(m.spend_cents / top) * 100}%` }} />
                    <span className={styles.colLabel}>{monthName(m.month, true)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      </div>
      <CostBySource tenant={tenant} />
      <Budgets tenant={tenant} summary={s} canEdit={canWriteBudgets} />
      <CostLines tenant={tenant} canWrite={canWriteCosts} />
    </>
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
