"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { buttonClass, cx } from "@/components/ui";

export function SignInButtons({ microsoft, devUsers, callbackUrl }: { microsoft: boolean; devUsers: { email: string; name: string; detail: string }[]; callbackUrl: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mt-4 space-y-4">
      {microsoft && (
        <button className={cx(buttonClass("primary"), "w-full")} disabled={!!busy} onClick={() => { setBusy("ms"); signIn("azure-ad", { callbackUrl }); }}>
          Sign in with Microsoft 365
        </button>
      )}
      {devUsers.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-ink-muted">Dev sign-in: pick a seeded user</div>
          <ul className="divide-y divide-line rounded border border-line">
            {devUsers.map((u) => (
              <li key={u.email}>
                <button
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-sunken disabled:opacity-50"
                  disabled={!!busy}
                  onClick={() => {
                    setBusy(u.email);
                    signIn("dev", { email: u.email, callbackUrl });
                  }}
                >
                  <span>
                    <span className="block text-sm font-medium text-ink">{u.name}</span>
                    <span className="block text-2xs text-ink-muted">{u.email}</span>
                  </span>
                  <span className="text-2xs text-ink-faint">{busy === u.email ? "Signing in..." : u.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
