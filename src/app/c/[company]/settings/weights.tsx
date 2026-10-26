"use client";

// Factor weights with a running total. Scoring scales the weights to 100, so the total does not have to be
// exactly 100; the share column shows what each weight will count for.

import { useState } from "react";
import { FACTORS, type FactorKey } from "@/lib/scoring";
import { cx } from "@/components/ui";

export function WeightsFields({ initial, disabled }: { initial: Record<FactorKey, number>; disabled: boolean }) {
  const [w, setW] = useState<Record<string, string>>(() => Object.fromEntries(FACTORS.map((f) => [f.key, String(initial[f.key])])));
  const val = (k: string) => {
    const n = Number(w[k]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const total = FACTORS.reduce((s, f) => s + val(f.key), 0);
  const halves = [
    { key: "market", label: "Market: is the demand there?" },
    { key: "fit", label: "Fit: can we win and deliver?" },
  ] as const;

  return (
    <div className="space-y-4">
      {halves.map((h) => {
        const rows = FACTORS.filter((f) => f.half === h.key);
        const sub = rows.reduce((s, f) => s + val(f.key), 0);
        return (
          <div key={h.key}>
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-ink">{h.label}</h3>
              <span className="tnum text-xs text-ink-muted">Subtotal {sub}</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {rows.map((f) => (
                  <tr key={f.key} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-3">
                      <div className="font-medium text-ink">{f.label}</div>
                      <div className="text-2xs text-ink-muted">
                        {f.help}
                        {f.inverted ? " Lower is better." : ""}
                      </div>
                    </td>
                    <td className="w-24 py-1.5">
                      <input name={`w_${f.key}`} aria-label={`Weight for ${f.label}`} inputMode="decimal" className="input tnum text-right" value={w[f.key]} disabled={disabled} onChange={(e) => setW((x) => ({ ...x, [f.key]: e.target.value }))} />
                    </td>
                    <td className="tnum w-20 py-1.5 text-right text-xs text-ink-muted">{total > 0 ? `${((val(f.key) / total) * 100).toFixed(1)}%` : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <div className="flex items-baseline justify-between border-t border-line pt-2 text-sm">
        <span className="font-medium">Total</span>
        <span className={cx("tnum font-semibold", total === 0 && "text-bad")}>{total}</span>
      </div>
      <p className="text-2xs text-ink-muted">Scores are always out of 100. If the weights add up to more or less than 100, they are scaled to fit, keeping the same proportions.</p>
    </div>
  );
}
