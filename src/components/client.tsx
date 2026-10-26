"use client";

// Interactive primitives: forms bound to server actions with inline errors and pending states.

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { buttonClass, cx, type ButtonVariant } from "./ui";
import type { ActionResult, FormAction } from "@/server/action";

export function SubmitButton({ children, variant = "primary", size = "md", className, pendingText, disabled, name, value }: { children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; className?: string; pendingText?: string; disabled?: boolean; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} className={cx(buttonClass(variant, size), className)}>
      {pending && <Spinner />}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent", className)} aria-hidden />;
}

/** A form wired to a server action. Shows the action's error or success message inline. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  redirectTo,
  onDone,
  showMessage = true,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Navigate after success. "{id}" is replaced with the id the action returned. */
  redirectTo?: string;
  onDone?: (r: ActionResult) => void;
  showMessage?: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      if (redirectTo) router.push(redirectTo.replace("{id}", state.id ?? ""));
    }
    onDone?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {showMessage && state && !state.ok && <p className="mt-2 text-xs text-bad" role="alert">{state.error}</p>}
      {showMessage && state?.ok && state.message && <p className="mt-2 text-xs text-good" role="status">{state.message}</p>}
    </form>
  );
}

/** One-click action button (approve, launch, archive). Optional confirm prompt. */
export function ActionButton({ action, children, variant = "secondary", size = "md", confirm, pendingText, fields, className, title }: { action: FormAction; children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; confirm?: string; pendingText?: string; fields?: Record<string, string>; className?: string; title?: string }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  return (
    <form
      action={formAction}
      className={cx("inline-flex flex-col items-start", className)}
      title={title}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {fields && Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton variant={variant} size={size} pendingText={pendingText}>
        {children}
      </SubmitButton>
      {state && !state.ok && <span className="mt-1 max-w-xs text-2xs text-bad" role="alert">{state.error}</span>}
    </form>
  );
}

/** Refreshes the page on an interval while something runs in the background. */
export function AutoRefresh({ seconds = 4, active = true }: { seconds?: number; active?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, active]);
  return null;
}

export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink">
        <span className={cx("inline-block transition-transform", open && "rotate-90")}>›</span>
        {summary}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** Small modal dialog. */
export function Dialog({ trigger, title, children, variant = "secondary", size = "md", wide }: { trigger: ReactNode; title: ReactNode; children: (close: () => void) => ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass(variant, size)} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className={cx("w-full rounded-lg border border-line bg-surface shadow-pop", wide ? "max-w-2xl" : "max-w-md")} role="dialog" aria-modal>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">{title}</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-ink-muted hover:text-ink" aria-label="Close">
                ✕
              </button>
            </div>
            <div className="p-4">{children(() => setOpen(false))}</div>
          </div>
        </div>
      )}
    </>
  );
}
