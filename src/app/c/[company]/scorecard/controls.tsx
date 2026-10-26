"use client";

// Interactive pieces of the scorecard: the fix checklist, adding a fix, editing the diagnosis, and sending
// conversions.

import { useActionState, useRef } from "react";
import { ActionForm, Dialog, Spinner, SubmitButton } from "@/components/client";
import { Badge, Field, cx } from "@/components/ui";
import type { ActionResult, FormAction } from "@/server/action";
import { OWNER_ROLES, ROLE_TONE } from "./format";

export function FixItem({ text, ownerRole, done, from, doneBy, action, canComplete }: { text: string; ownerRole: string; done: boolean; from?: string; doneBy?: string | null; action: FormAction; canComplete: boolean }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={formAction} className="flex items-start gap-2.5 py-1.5">
      <input
        type="checkbox"
        aria-label={done ? `Mark not done: ${text}` : `Mark done: ${text}`}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        checked={done}
        disabled={!canComplete || pending}
        onChange={() => ref.current?.requestSubmit()}
      />
      <div className="min-w-0 flex-1">
        <div className={cx("text-sm", done ? "text-ink-muted line-through" : "text-ink")}>{text}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
          <Badge tone={ROLE_TONE[ownerRole] ?? "neutral"}>{ownerRole}</Badge>
          {from && <span>Carried over from the week of {from}</span>}
          {done && doneBy && <span>Done by {doneBy}</span>}
          {pending && <Spinner />}
          {state && !state.ok && <span className="text-bad">{state.error}</span>}
        </div>
      </div>
    </form>
  );
}

export function AddFixForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} resetOnSuccess className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <Field label="Add a fix" className="min-w-[240px] flex-1">
        <input name="text" className="input" placeholder="What will we change this week?" required />
      </Field>
      <Field label="Owner">
        <select name="ownerRole" className="input w-auto" defaultValue="Operator">
          {OWNER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <SubmitButton variant="secondary" pendingText="Adding...">
        Add
      </SubmitButton>
    </ActionForm>
  );
}

export function EditDiagnosisDialog({ action, initial }: { action: FormAction; initial: { bottleneck: string; cause: string; summary: string } }) {
  return (
    <Dialog trigger="Edit" title="Edit the diagnosis" variant="ghost" size="sm" wide>
      {(close) => (
        <ActionForm action={action} onDone={(r) => r.ok && close()} className="space-y-3">
          <Field label="Biggest bottleneck">
            <input name="bottleneck" className="input" defaultValue={initial.bottleneck} required />
          </Field>
          <Field label="Likely cause">
            <textarea name="cause" className="input" rows={3} defaultValue={initial.cause} required />
          </Field>
          <Field label="Weekly summary">
            <textarea name="summary" className="input" rows={6} defaultValue={initial.summary} required />
          </Field>
          <SubmitButton pendingText="Saving...">Save</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}

export function SendConversions({ action, pending: waiting }: { action: FormAction; pending: number }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const sent = state?.ok ? ((state.data as { sent?: number } | undefined)?.sent ?? 0) : null;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <SubmitButton variant="secondary" size="sm" pendingText="Sending..." disabled={waiting === 0}>
        Send now
      </SubmitButton>
      {sent != null && <span className="text-xs text-ink-muted">{sent === 0 ? "Nothing new was sent." : `Sent ${sent} ${sent === 1 ? "deal" : "deals"}.`}</span>}
      {state && !state.ok && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
