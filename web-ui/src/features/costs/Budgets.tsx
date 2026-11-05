import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useRun } from '../settings/shared';
import { costsKey, monthName, saveBudgets, type CostCategory, type CostsSummary } from './api';
import styles from './Costs.module.css';

type Props = { tenant: string; summary: CostsSummary; canEdit: boolean };

/** Whole currency units typed into a budget box, as cents. Anything that is not a digit is dropped. */
const toCents = (text: string) => (parseInt(text.replace(/[^0-9]/g, ''), 10) || 0) * 100;

/** "Monthly budgets": each category's spend this month against its budget; editable by those with `budgets:write`. */
export function Budgets({ tenant, summary: s, canEdit }: Props) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [draft, setDraft] = useState<Partial<Record<CostCategory, string>> | null>(null);

  async function save() {
    if (!draft) return;
    const ok = await run(
      async () => {
        const view = await saveBudgets(
          tenant,
          s.month,
          s.categories.map((c) => ({ category: c.key, amount_cents: toCents(draft[c.key] ?? '') })),
        );
        await queryClient.invalidateQueries({ queryKey: costsKey(tenant) });
        return view;
      },
      (view) => `Budgets saved. Monthly total ${f.money(view.total_cents)}.`,
    );
    if (ok) setDraft(null);
  }

  const actions = !canEdit ? null : draft ? (
    <div className={styles.actions}>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
        Cancel
      </Button>
      <Button size="sm" disabled={busy} onClick={() => void save()}>
        Save budgets
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="secondary" onClick={() => setDraft(Object.fromEntries(s.categories.map((c) => [c.key, c.budget_cents ? String(c.budget_cents / 100) : ''])))}>
      Edit budgets
    </Button>
  );

  return (
    <Card title="Monthly budgets" actions={actions}>
      <p className={styles.note}>{`${monthName(s.month)} so far. Scout alerts the owner at 90% and pauses paid pulls at 110%.`}</p>
      <ul className={styles.list}>
        {s.categories.map((c) => {
          const budget = c.budget_cents ?? 0;
          const ratio = budget > 0 ? c.spend_month_cents / budget : 0;
          const over = budget > 0 && ratio > 1;
          const warn = budget > 0 && ratio >= 0.9;
          const tone = over ? styles.over : warn ? styles.warn : '';
          const status = budget === 0 ? 'No budget' : over ? `Over by ${f.moneyFixed(c.spend_month_cents - budget)}` : warn ? `${Math.round(ratio * 100)}% used` : `${f.moneyFixed(budget - c.spend_month_cents)} left`;
          return (
            <li key={c.key} className={styles.budgetRow}>
              <strong>{c.label}</strong>
              <div className={styles.track} aria-hidden="true">
                <div className={`${styles.fill} ${over ? styles.fillOver : warn ? styles.fillWarn : ''}`.trim()} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
              </div>
              <span>
                <strong className={tone}>{f.money(c.spend_month_cents)}</strong> <span className={styles.muted}>{`of ${f.money(budget)}`}</span>
              </span>
              {draft ? (
                <input
                  className={`input ${styles.budgetInput}`}
                  inputMode="numeric"
                  aria-label={`${c.label} budget`}
                  value={draft[c.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                />
              ) : (
                <span className={`${styles.status} ${tone}`.trim()}>{status}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
