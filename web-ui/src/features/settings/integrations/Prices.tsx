import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { ratesQuery, saveRates, type Rate } from '../../costs/api';
import { useRun } from '../shared';
import styles from '../Settings.module.css';

type Props = { serviceKey: string; tenant: string };

const NEGATIVE = "A rate can't be negative.";
const NOT_A_NUMBER = 'Enter a number.';

/** Claude is priced per token; a box shows dollars per million tokens (cents per token x 10,000). */
const perMillion = (centsPerToken: number) => String(Number((centsPerToken * 10_000).toPrecision(8)));
const perToken = (dollarsPerMillion: number) => Number((dollarsPerMillion / 10_000).toFixed(6));

type Box = { item: string; label: string; group: string | null; shown: string };

function boxesOf(rates: Rate[]): Box[] {
  return rates.map((r) => {
    const [model, kind] = r.item.split(':');
    if (kind === 'input' || kind === 'output') {
      return { item: r.item, group: model!, label: `${kind === 'input' ? 'Input' : 'Output'}, $ per million tokens`, shown: perMillion(r.cents_per_unit) };
    }
    return { item: r.item, group: null, label: 'Cents per credit', shown: String(r.cents_per_unit) };
  });
}

/** §21b "Prices": what the provider's usage costs, which turns credits and tokens into money on Costs. Hidden for a service with no money. */
export function Prices({ serviceKey, tenant }: Props) {
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const rates = useQuery(ratesQuery(tenant, serviceKey));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (rates.isError) {
    return (
      <section className={styles.section} aria-label="Prices">
        <h3 className={styles.sectionTitle}>Prices</h3>
        <p className={styles.note}>{"Couldn't load prices. Try again."}</p>
      </section>
    );
  }
  if (!rates.data || rates.data.length === 0) return null;

  const boxes = boxesOf(rates.data);
  const value = (b: Box) => typed[b.item] ?? b.shown;

  async function save(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const out: { item: string; cents_per_unit: number }[] = [];
    for (const b of boxes) {
      const text = value(b).trim();
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) found[b.item] = NOT_A_NUMBER;
      else if (n < 0) found[b.item] = NEGATIVE;
      else out.push({ item: b.item, cents_per_unit: b.group ? perToken(n) : n });
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const ok = await run(async () => {
      const saved = await saveRates(tenant, serviceKey, out);
      queryClient.setQueryData(ratesQuery(tenant, serviceKey).queryKey, saved.data);
    }, 'Prices saved.');
    if (ok) setTyped({});
  }

  const field = (b: Box) => (
    <Field key={b.item} label={b.label} error={errors[b.item] ?? null}>
      {(c) => <input {...c} inputMode="decimal" className="input" value={value(b)} onChange={(ev) => setTyped({ ...typed, [b.item]: ev.target.value })} />}
    </Field>
  );
  const models = [...new Set(boxes.flatMap((b) => (b.group ? [b.group] : [])))];

  return (
    <section className={styles.section} aria-label="Prices">
      <h3 className={styles.sectionTitle}>Prices</h3>
      <form className={styles.section} onSubmit={(e) => void save(e)} noValidate>
        {models.map((m) => (
          <fieldset key={m} aria-label={m} className={styles.fieldset}>
            {boxes.filter((b) => b.group === m).map(field)}
          </fieldset>
        ))}
        {boxes.filter((b) => !b.group).map(field)}
        <div className={styles.row}>
          <Button type="submit" size="sm" disabled={busy}>
            Save prices
          </Button>
        </div>
      </form>
    </section>
  );
}
