"use client";

// Bulk actions on the Buyers list: check companies, then assign them, push them to HubSpot, or both.
// Row checkboxes live in the server-rendered table and join this form through form="bulk-buyers".

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, FormAction } from "@/server/action";
import { buttonClass, cx } from "@/components/ui";

export const BULK_FORM = "bulk-buyers";
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(`input[form="${BULK_FORM}"][name="ids"]`));

export function BulkBar({ action, sellers }: { action: FormAction; sellers: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const recount = () => setCount(boxes().filter((b) => b.checked).length);
    document.addEventListener("change", recount);
    recount();
    return () => document.removeEventListener("change", recount);
  }, []);

  // After a run, clear the checks so the next selection starts fresh.
  useEffect(() => {
    if (state?.ok) {
      for (const b of boxes()) b.checked = false;
      setCount(0);
    }
  }, [state]);

  return (
    <form
      id={BULK_FORM}
      action={formAction}
      onSubmit={(e) => {
        const op = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
        if ((op === "push" || op === "assign_push") && !window.confirm(`Push ${count} ${count === 1 ? "company" : "companies"} to HubSpot? Each gets the company record, a note with every signal and why it matters, its contacts, and a task for the owner. Companies owned by someone else in HubSpot are reassigned to your pick; ones with an open deal or that are customers are skipped.`)) e.preventDefault();
      }}
      className={cx("mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs", count ? "border-accent-line bg-accent-soft" : "border-line bg-surface")}
    >
      <span className="tnum min-w-20 font-medium text-ink">{count ? `${count} selected` : "Select companies"}</span>
      <label htmlFor="bulk-seller" className="text-ink-muted">
        Follow-up by
      </label>
      <select id="bulk-seller" name="sellerId" className="input h-7 w-44 py-0 text-xs" defaultValue="">
        <option value="">Unassigned</option>
        {sellers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button type="submit" name="op" value="assign" disabled={!count || pending} className={buttonClass("secondary", "sm")}>
        Assign
      </button>
      <button type="submit" name="op" value="assign_push" disabled={!count || pending} className={buttonClass("primary", "sm")}>
        Assign and push to HubSpot
      </button>
      <button type="submit" name="op" value="push" disabled={!count || pending} className={buttonClass("ghost", "sm")} title="Push with the owner already assigned">
        Push only
      </button>
      <button type="submit" name="op" value="check" disabled={!count || pending} className={buttonClass("ghost", "sm")} title="Look these up in HubSpot without changing anything">
        Check HubSpot
      </button>
      {pending && <span className="text-ink-muted">Working...</span>}
      {!pending && state && (state.ok ? state.message && <span className="basis-full text-ink-soft">{state.message}</span> : <span className="basis-full text-bad" role="alert">{state.error}</span>)}
    </form>
  );
}

export function SelectAll() {
  return (
    <input
      type="checkbox"
      aria-label="Select all"
      className="h-3.5 w-3.5"
      onChange={(e) => {
        for (const b of boxes()) b.checked = e.currentTarget.checked;
        document.dispatchEvent(new Event("change"));
      }}
    />
  );
}
