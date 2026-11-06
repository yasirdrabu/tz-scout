import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { centsToInput, parseMoney } from '../../lib/money-input';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { useRun } from '../settings/shared';
import { costsKey, saveTarget, type CostsSummary } from './api';
import styles from './Costs.module.css';

const NEEDS_TARGET = 'Enter a target above zero, or clear it.';

/** "Cost per won account" with the workspace target; `Set target` (for `budgets:write`) edits it in place. */
export function CostPerWonTile({ tenant, summary: s, canEdit }: { tenant: string; summary: CostsSummary; canEdit: boolean }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const target = s.target_cost_per_won_cents;

  async function save() {
    const text = (draft ?? '').trim();
    let cents: number | null = null;
    if (text !== '') {
      const parsed = parseMoney(text, f.currency);
      if ('error' in parsed) return setProblem(parsed.error);
      if (parsed.cents <= 0) return setProblem(NEEDS_TARGET);
      cents = parsed.cents;
    }
    setProblem(null);
    const ok = await run(async () => {
      await saveTarget(tenant, cents);
      await queryClient.invalidateQueries({ queryKey: costsKey(tenant) });
    }, cents === null ? 'Target cleared.' : 'Target saved.');
    if (ok) setDraft(null);
  }

  return (
    <li className={styles.tile}>
      <span className={styles.tileLabel}>Cost per won account</span>
      <span className={styles.tileValue}>{s.cost_per_won_cents === null ? 'No wins yet' : f.money(s.cost_per_won_cents)}</span>
      <span className={styles.tileNote}>{target === null ? 'No target set' : `Target ${f.money(target)}`}</span>
      {canEdit &&
        (draft === null ? (
          <div className={styles.tileAction}>
            <Button size="sm" variant="secondary" onClick={() => setDraft(target === null ? '' : centsToInput(target, f.currency))}>
              Set target
            </Button>
          </div>
        ) : (
          <div className={styles.tileAction}>
            <input
              className="input"
              inputMode="decimal"
              aria-label="Target cost per won account"
              aria-invalid={problem ? true : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {problem && (
              <p className={styles.over} role="alert">
                {problem}
              </p>
            )}
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                Save target
              </Button>
            </div>
          </div>
        ))}
    </li>
  );
}
