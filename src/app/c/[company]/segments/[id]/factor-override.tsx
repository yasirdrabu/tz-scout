"use client";

import { ActionButton, ActionForm, Dialog, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import type { FormAction } from "@/server/action";

/** Set or clear an override for one factor. */
export function FactorOverride({
  label,
  proposed,
  current,
  note,
  inverted,
  saveAction,
  clearAction,
}: {
  label: string;
  proposed: number;
  current: number | null;
  note: string | null;
  inverted: boolean;
  saveAction: FormAction;
  clearAction: FormAction;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Dialog trigger={current != null ? "Change" : "Override"} title={`Override ${label.toLowerCase()}`} variant="ghost" size="sm">
        {(close) => (
          <ActionForm action={saveAction} onDone={(r) => r.ok && close()} className="space-y-3">
            <p className="text-xs text-ink-muted">
              Proposed value {proposed.toFixed(1)} of 10.{inverted && " This factor is inverted: a higher value counts against the score."} Your value is kept when segments are regenerated.
            </p>
            <Field label="Your value (0 to 10)">
              <input name="value" type="number" min={0} max={10} step={0.5} defaultValue={current ?? proposed} className="input tnum w-28" required />
            </Field>
            <Field label="Note" hint="Why you changed it. Shown next to the factor.">
              <input name="note" className="input" defaultValue={note ?? ""} placeholder="We closed two of these last quarter." />
            </Field>
            <SubmitButton pendingText="Saving...">Save override</SubmitButton>
          </ActionForm>
        )}
      </Dialog>
      {current != null && (
        <ActionButton action={clearAction} variant="ghost" size="sm" pendingText="Clearing...">
          Clear
        </ActionButton>
      )}
    </div>
  );
}
