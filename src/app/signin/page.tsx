import { redirect } from "next/navigation";
import { currentUser, devSignInEnabled, microsoftEnabled } from "@/lib/auth";
import { unscopedDb } from "@/lib/db";
import { SignInButtons } from "./buttons";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  not_invited: "That account hasn't been added yet. Ask an admin to invite you.",
  no_company: "You're signed in but not part of any company yet. Ask an admin to add you.",
  CredentialsSignin: "Sign-in failed.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string }> }) {
  const sp = await searchParams;
  if (await currentUser()) redirect("/");
  const dev = devSignInEnabled();
  const users = dev
    ? await unscopedDb.user.findMany({ orderBy: [{ isAdmin: "desc" }, { name: "asc" }], include: { memberships: { include: { company: { select: { name: true } } } } } })
    : [];
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-accent text-sm font-bold text-white">CA</div>
          <div>
            <div className="text-base font-semibold">Client Acquisition</div>
            <div className="text-xs text-ink-muted">From who to sell to, to what a won client cost.</div>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5 shadow-card">
          <h1 className="text-sm font-semibold">Sign in</h1>
          {sp.error && <p className="mt-2 rounded border border-bad-line bg-bad-soft px-2.5 py-1.5 text-xs text-bad">{ERRORS[sp.error] ?? "Sign-in failed."}</p>}
          <SignInButtons
            microsoft={microsoftEnabled()}
            callbackUrl={sp.callbackUrl ?? "/"}
            devUsers={users.map((u) => ({ email: u.email, name: u.name, detail: u.isAdmin ? "Admin" : u.memberships.map((m) => `${m.role.toLowerCase()} at ${m.company.name}`).join(", ") }))}
          />
          {!microsoftEnabled() && !dev && <p className="mt-3 text-sm text-ink-muted">No sign-in method is configured. Set the Microsoft 365 variables or AUTH_DEV_SIGNIN.</p>}
        </div>
        {dev && <p className="mt-3 text-center text-2xs text-ink-faint">Dev sign-in is on. Turn it off before anyone outside the team can reach this app.</p>}
      </div>
    </main>
  );
}
