// Batch settings inputs, shared by the new batch form and the draft batch editor. Money is typed in
// dollars and rates as percents; the actions convert them.

import { Field } from "@/components/ui";

export type BatchFieldValues = {
  name?: string;
  channel: string;
  budgetCents: number;
  durationHours: number;
  targetCtr: number;
  targetCpcCents: number;
  minImpressions: number;
  statementCount?: number;
};

const dollars = (c: number) => String(Math.round(c) / 100);
const percent = (r: number) => String(Math.round(r * 10000) / 100);

export function BatchFields({ values, disabled, showCount, showName }: { values: BatchFieldValues; disabled?: boolean; showCount?: boolean; showName?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {showName && (
        <Field label="Name" className="sm:col-span-2 lg:col-span-3">
          <input name="name" className="input" defaultValue={values.name ?? ""} disabled={disabled} />
        </Field>
      )}
      <Field label="Channel" hint="Each statement runs as its own ad set.">
        <select name="channel" className="input" defaultValue={values.channel} disabled={disabled}>
          <option value="meta">Meta</option>
          <option value="linkedin">LinkedIn</option>
        </select>
      </Field>
      <Field label="Budget ($)" hint="Split evenly across the statements.">
        <input name="budget" className="input tnum" inputMode="decimal" defaultValue={dollars(values.budgetCents)} disabled={disabled} required />
      </Field>
      <Field label="Duration (hours)">
        <input name="durationHours" type="number" min={1} max={336} className="input tnum" defaultValue={values.durationHours} disabled={disabled} required />
      </Field>
      <Field label="Target clickthrough rate (%)" hint="Clicks divided by impressions.">
        <input name="targetCtr" className="input tnum" inputMode="decimal" defaultValue={percent(values.targetCtr)} disabled={disabled} required />
      </Field>
      <Field label="Target cost per click ($)">
        <input name="targetCpc" className="input tnum" inputMode="decimal" defaultValue={dollars(values.targetCpcCents)} disabled={disabled} required />
      </Field>
      <Field label="Minimum impressions" hint="No verdict until a statement reaches this.">
        <input name="minImpressions" type="number" min={1} step={100} className="input tnum" defaultValue={values.minImpressions} disabled={disabled} required />
      </Field>
      {showCount && (
        <Field label="Number of statements" hint="12 to 15, half problems and half outcomes.">
          <input name="statementCount" type="number" min={12} max={15} className="input tnum" defaultValue={values.statementCount ?? 12} disabled={disabled} required />
        </Field>
      )}
    </div>
  );
}
