"use client";

import { useActionState, useState } from "react";
import { ActionForm } from "@/components/client";
import { buttonClass } from "@/components/ui";
import type { ActionResult, FormAction } from "@/server/action";

/** Push to HubSpot with a confirm, showing what happened afterwards (created or updated, contacts sent). */
export function PushButton({ action, label, confirmText }: { action: FormAction; label: string; confirmText: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  return (
    <form action={formAction} onSubmit={(e) => { if (!window.confirm(confirmText)) e.preventDefault(); }} className="inline-flex flex-col items-start">
      <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
        {pending ? "Pushing..." : label}
      </button>
      {state && (state.ok ? state.message && <span className="mt-1 max-w-xs text-2xs text-ink-soft">{state.message}</span> : <span className="mt-1 max-w-xs text-2xs text-bad" role="alert">{state.error}</span>)}
    </form>
  );
}

/** Owner picker (the team roster: HubSpot owners) that saves as soon as a person is chosen. */
export function OwnerSelect({ action, current, members }: { action: FormAction; current: string | null; members: { id: string; name: string }[] }) {
  return (
    <ActionForm action={action}>
      <label htmlFor="owner" className="label">
        Follow-up by
      </label>
      <select id="owner" name="sellerId" defaultValue={current ?? ""} className="input h-8 py-0" onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        <option value="">Unassigned</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={buttonClass("ghost", "sm")}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : label}
    </button>
  );
}
