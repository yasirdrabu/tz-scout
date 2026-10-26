"use client";

// Editable list of buying signal rules for one offering. Saved as a whole; the server checks each rule.

import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/client";
import { Button, cx } from "@/components/ui";
import type { FormAction } from "@/server/action";
import { SIGNAL_LABEL, SIGNAL_TYPES, type SignalRule, type SignalType } from "@/lib/matching";

type Row = { id: string; type: SignalType; label: string; keywords: string; weight: string; minPct: string; why: string };

/** Signal types with a numeric threshold, and how the threshold is typed. */
const MIN_INPUT: Partial<Record<SignalType, { before: string; after: string; scale: number }>> = {
  growth: { before: "At least", after: "% in six months", scale: 100 },
  intent: { before: "Score of at least", after: "out of 100", scale: 100 },
  workforce: { before: "At least", after: "% of staff", scale: 100 },
};

const toRow = (r: SignalRule): Row => ({
  id: r.id,
  type: r.type,
  label: r.label,
  keywords: r.match.join(", "),
  weight: String(r.weight),
  minPct: r.min != null ? String(Math.round(r.min * 1000) / 10) : "",
  why: r.why ?? "",
});

const toRule = (r: Row) => ({
  id: r.id,
  type: r.type,
  label: r.label.trim(),
  match: r.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  weight: r.weight.trim() === "" ? null : Number(r.weight),
  ...(MIN_INPUT[r.type] && r.minPct.trim() !== "" ? { min: Number(r.minPct) / MIN_INPUT[r.type]!.scale } : {}),
  ...(r.why.trim() ? { why: r.why.trim() } : {}),
});

const newId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const HINT: Record<SignalType, string> = {
  intent: "Topics they are actively researching. Keywords match topic names.",
  leadership: "New or departing senior leaders.",
  funding: "New funding rounds or investment.",
  news: "Acquisitions, expansion, cost cutting and other company events.",
  risk: "Security breaches, outages and lawsuits.",
  hiring: "Matches job titles or departments they are hiring for.",
  growth: "Headcount growth over six months. Doesn't fade.",
  workforce: "How staff split across departments, and which teams grow. Doesn't fade.",
  tech: "Matches technologies in their current stack. Doesn't fade.",
};

export function RulesEditor({ action, initial, starting, canEdit }: { action: FormAction; initial: SignalRule[]; starting: SignalRule[]; canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>(() => initial.map(toRow));
  const [dirty, setDirty] = useState(false);
  const json = useMemo(() => JSON.stringify(rows.map(toRule)), [rows]);
  const total = rows.reduce((s, r) => s + (Number.isFinite(Number(r.weight)) ? Number(r.weight) : 0), 0);

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  return (
    <ActionForm action={action} onDone={(r) => r.ok && setDirty(false)} className="[&>p]:px-4 [&>p]:pb-3">
      <input type="hidden" name="rules" value={json} />
      <fieldset disabled={!canEdit}>
        <ol className="divide-y divide-line border-b border-line">
          {rows.map((r, i) => (
            <li key={r.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[180px_1fr_88px_auto]">
              <label className="block">
                <span className="label">Signal type</span>
                <select aria-label={`Signal type for rule ${i + 1}`} className="input" value={r.type} onChange={(e) => update(i, { type: e.target.value as SignalType })}>
                  {SIGNAL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SIGNAL_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Label</span>
                <input aria-label={`Label for rule ${i + 1}`} className="input" value={r.label} onChange={(e) => update(i, { label: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Points</span>
                <input aria-label={`Points for rule ${i + 1}`} className="input tnum text-right" inputMode="numeric" value={r.weight} onChange={(e) => update(i, { weight: e.target.value })} />
              </label>
              <div className="flex items-end">
                {canEdit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mb-0.5"
                    onClick={() => {
                      setRows((rs) => rs.filter((_, j) => j !== i));
                      setDirty(true);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <div className="text-2xs text-ink-muted sm:pt-1">{HINT[r.type]}</div>
              <div className={cx("grid gap-3", MIN_INPUT[r.type] ? "sm:col-span-3 sm:grid-cols-[1fr_auto]" : "sm:col-span-3")}>
                <label className="block">
                  <span className="sr-only">Keywords</span>
                  <input aria-label={`Keywords for rule ${i + 1}`} className="input" value={r.keywords} placeholder="Keywords. Empty counts any signal of this type." onChange={(e) => update(i, { keywords: e.target.value })} />
                </label>
                {MIN_INPUT[r.type] && (
                  <label className="flex items-center gap-2 whitespace-nowrap text-xs text-ink-soft">
                    {MIN_INPUT[r.type]!.before}
                    <input aria-label={`Minimum for rule ${i + 1}`} className="input tnum w-20 text-right" inputMode="decimal" value={r.minPct} placeholder="0" onChange={(e) => update(i, { minPct: e.target.value })} />
                    {MIN_INPUT[r.type]!.after}
                  </label>
                )}
              </div>
              <label className="block sm:col-span-4">
                <span className="label">Why it matters for this offer</span>
                <textarea aria-label={`Why rule ${i + 1} matters`} className="input" rows={2} value={r.why} placeholder="Shown next to the signal wherever it surfaces." onChange={(e) => update(i, { why: e.target.value })} />
              </label>
            </li>
          ))}
          {rows.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">No rules. Add one, or reset to the starting rules.</li>}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-xs text-ink-muted">
            Rules can add up to <span className="tnum font-medium text-ink">{total}</span> points.{total > 100 ? " The signal score stops at 100." : ""}
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setRows((rs) => [...rs, { id: newId(), type: "hiring", label: "", keywords: "", weight: "10", minPct: "", why: "" }]);
                  setDirty(true);
                }}
              >
                Add rule
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!window.confirm("Replace these rules with the starting rules? Nothing is saved until you press Save.")) return;
                  setRows(starting.map(toRow));
                  setDirty(true);
                }}
              >
                Reset to starting rules
              </Button>
              <SubmitButton size="sm" pendingText="Saving...">
                Save rules
              </SubmitButton>
            </div>
          )}
        </div>
        {dirty && canEdit && <p className="px-4 pb-3 text-2xs text-ink-muted">Unsaved changes.</p>}
      </fieldset>
    </ActionForm>
  );
}
