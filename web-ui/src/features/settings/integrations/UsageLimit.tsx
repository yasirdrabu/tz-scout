import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/errors';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { allowOverage, setCapLimit, type Integration } from './api';

type Props = { service: Integration; tenant: string; onChanged: () => Promise<unknown> };

const INVALID = 'Enter a whole number of 1 or more.';

/** The service's usage limit: how much is used, a bar, the limit to edit, and the owner's way past a block. */
export function UsageLimit({ service, tenant, onChanged }: Props) {
  const f = useFormat();
  const { run, busy } = useRun();
  const cap = service.cap;
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!cap) {
    return (
      <section className={styles.section} aria-label="Usage limit">
        <h3 className={styles.sectionTitle}>Usage limit</h3>
        <p className={styles.note}>No limit.</p>
      </section>
    );
  }

  const money = cap.unit === 'cost_cents';
  const amount = (n: number) => (money ? f.moneyFixed(n) : f.number(n));
  const resets = f.monthDay(cap.resets_at);
  const when = cap.period === 'day' ? 'today' : 'this month';
  const fill = Math.min(100, (cap.used / cap.limit) * 100);
  const fillClass = [styles.meterFill, cap.level === 'warn' && styles.meterFillWarn, cap.level === 'blocked' && styles.meterFillBlocked].filter(Boolean).join(' ');
  const text = value ?? String(cap.limit);

  async function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    const n = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < 1) return setError(INVALID);
    setError(null);
    await run(async () => {
      try {
        await setCapLimit(tenant, service.key, n);
      } catch (err) {
        const field = err instanceof ApiError ? err.errors.find((x) => x.path === 'limit') : undefined;
        if (field) setError(field.message);
        throw err;
      }
      setValue(null);
      await onChanged();
    }, 'Limit saved.');
  }

  return (
    <section className={styles.section} aria-label="Usage limit">
      <h3 className={styles.sectionTitle}>Usage limit</h3>
      <p>{`${amount(cap.used)} of ${amount(cap.limit)}${money ? '' : ` ${cap.unit}`} ${when}. Resets ${resets}.`}</p>
      <div className={styles.meter} role="meter" aria-label="Usage" aria-valuemin={0} aria-valuemax={cap.limit} aria-valuenow={Math.min(cap.used, cap.limit)}>
        <div className={fillClass} style={{ width: `${fill}%` }} />
      </div>
      <form className={styles.section} onSubmit={(e) => void save(e)} noValidate>
        <Field label={`Limit per ${cap.period}`} error={error}>
          {(control) => <input {...control} inputMode="numeric" className="input" value={text} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <div className={styles.row}>
          <Button type="submit" size="sm" disabled={busy}>
            Save limit
          </Button>
          {cap.level === 'blocked' && !cap.overage && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await allowOverage(tenant, service.key);
                  await onChanged();
                }, `${service.name} can go over its limit until ${resets}.`)
              }
            >
              {`Allow until ${resets}`}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
