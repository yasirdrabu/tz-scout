"use client";

// Fit and signal shares that always add up to 100: changing one sets the other.

import { useState } from "react";
import { Field } from "@/components/ui";

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const round = (n: number) => Math.round(n * 10) / 10;

export function BuyersSplitFields({ fit, disabled }: { fit: number; disabled: boolean }) {
  const [f, setF] = useState(String(round(fit)));
  const [s, setS] = useState(String(round(100 - fit)));
  const set = (which: "fit" | "signal", v: string) => {
    const n = Number(v);
    const other = v.trim() !== "" && Number.isFinite(n) ? String(round(100 - clamp(n))) : "";
    if (which === "fit") {
      setF(v);
      setS(other);
    } else {
      setS(v);
      setF(other);
    }
  };
  const fitN = Number(f);
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How much fit counts (%)" hint="Industry, size, revenue, region and whether a buyer is on file.">
          <input name="fitPct" className="input tnum" inputMode="decimal" value={f} disabled={disabled} onChange={(e) => set("fit", e.target.value)} />
        </Field>
        <Field label="How much signals count (%)" hint="Hiring, growth, funding, leadership changes, news and tech stack.">
          <input name="signalPct" className="input tnum" inputMode="decimal" value={s} disabled={disabled} onChange={(e) => set("signal", e.target.value)} />
        </Field>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
        <div className="h-full bg-accent" style={{ width: `${Number.isFinite(fitN) ? clamp(fitN) : 0}%` }} />
        <div className="h-full bg-ink-faint" style={{ width: `${Number.isFinite(fitN) ? 100 - clamp(fitN) : 0}%` }} />
      </div>
      <p className="text-2xs text-ink-muted">The two always add up to 100. A company that fits poorly can&apos;t be lifted above its fit score by signals alone.</p>
    </div>
  );
}
