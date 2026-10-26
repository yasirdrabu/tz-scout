"use client";

// Most companies per pull, with the credit estimate updating as the number changes.

import { useState } from "react";
import { Field } from "@/components/ui";
import { estimateText, type Estimate } from "./labels";

export function MaxCompaniesField({ defaultValue, table, disabled }: { defaultValue: number; table: Estimate[]; disabled?: boolean }) {
  const [v, setV] = useState(String(defaultValue));
  const n = Number(v);
  const est = Number.isInteger(n) && n >= 1 && n <= table.length ? table[n - 1] : null;
  return (
    <Field label="Most companies per pull" hint={est ? estimateText(est) : "Enter a whole number from 1 to 200."}>
      <input name="maxCompanies" className="input tnum" inputMode="numeric" value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} />
    </Field>
  );
}
