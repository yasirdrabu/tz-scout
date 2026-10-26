'use client';

// Interactive primitives: forms bound to server actions with inline messages and pending states.

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { buttonClass, cx, type ButtonVariant } from './ui';
import type { ActionResult, FormAction } from '@/server/action';

export function SubmitButton({
  children,
  variant = 'primary',
  size = 'md',
  pendingText,
  className,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  pendingText?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cx(buttonClass(variant, size), className)}>
      {pending && pendingText ? pendingText : children}
    </button>
  );
}

/** A form wired to a server action. Shows the action's message or error inline. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state && !state.ok && (
        <p className="mt-2 text-xs text-bad" role="alert">
          {state.error}
        </p>
      )}
      {state?.ok && state.message && (
        <p className="mt-2 text-xs text-good" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Ends the session and returns to the sign-in page. */
export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className={buttonClass('ghost', 'sm')}
      onClick={async () => {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        router.push('/signin');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

/** One button per seeded person. Only rendered when developer sign-in is on. */
export function DevSignIn({ users }: { users: { id: string; email: string; detail: string }[] }) {
  const router = useRouter();
  const error = useRef<HTMLParagraphElement>(null);
  async function go(userId: string) {
    const res = await fetch('/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) {
      router.push('/');
      router.refresh();
    } else if (error.current) {
      const body = (await res.json().catch(() => null)) as { title?: string } | null;
      error.current.textContent = body?.title ?? 'Sign-in failed.';
    }
  }
  return (
    <div>
      <ul className="divide-y divide-line rounded border border-line">
        {users.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              aria-label={`Sign in as ${u.email}`}
              onClick={() => go(u.id)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-sunken"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{u.email}</span>
                <span className="block truncate text-2xs text-ink-muted">{u.detail}</span>
              </span>
              <span className="text-xs text-accent">Sign in</span>
            </button>
          </li>
        ))}
      </ul>
      <p ref={error} className="mt-2 text-xs text-bad" role="alert" />
    </div>
  );
}

/** Starts Microsoft sign-in. */
export function MicrosoftSignIn() {
  return (
    <button
      type="button"
      className={buttonClass('primary')}
      onClick={async () => {
        const res = await fetch('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
        });
        const body = (await res.json().catch(() => null)) as { url?: string } | null;
        if (body?.url) window.location.href = body.url;
      }}
    >
      Sign in with Microsoft
    </button>
  );
}
