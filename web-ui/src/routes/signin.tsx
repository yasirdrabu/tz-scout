import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { authConfig, devSignIn, devUsers, safeReturnPath, startMicrosoftSignIn } from '../api/auth';
import { ApiError } from '../api/errors';
import { Button } from '../ui/Button';
import { rootRoute } from './root';
import styles from './signin.module.css';

type SignInSearch = { return?: string; error?: string };

const FAILED = "Sign-in didn't work. Try again, and if it keeps failing, ask your owner.";

/** One message per sign-in error code the API returns (screens.md §1). */
export const SIGN_IN_ERRORS: Record<string, string> = {
  not_set_up: "Your account isn't a member of any workspace yet. Ask your owner for an invite.",
  account_turned_off: 'Your account is turned off. Ask your owner to turn it back on.',
  sign_in_failed: FAILED,
};

const errorCopy = (code: string) => SIGN_IN_ERRORS[code.toLowerCase()] ?? FAILED;

export const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...(typeof search.return === 'string' ? { return: search.return } : {}),
    ...(typeof search.error === 'string' ? { error: search.error } : {}),
  }),
  component: SignInPage,
});

function SignInPage() {
  const search = signinRoute.useSearch();
  const returnPath = safeReturnPath(search.return) ?? '/';
  const router = useRouter();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which methods to offer comes from the API. If the config can't load, Microsoft is offered anyway.
  const config = useQuery({ queryKey: ['auth-config'], queryFn: authConfig, retry: false, staleTime: Infinity });
  const devOn = config.data?.dev_sign_in === true;
  const microsoftOn = config.isError || (config.data?.methods.includes('microsoft') ?? false);
  const dev = useQuery({ queryKey: ['dev-users'], queryFn: devUsers, retry: false, staleTime: Infinity, enabled: devOn });
  const devList = devOn && dev.data && dev.data.length > 0 ? dev.data : null;

  const message = problem ?? (search.error ? errorCopy(search.error) : null);

  async function microsoft() {
    setBusy(true);
    setProblem(null);
    try {
      await startMicrosoftSignIn(returnPath);
    } catch {
      setProblem(FAILED);
      setBusy(false);
    }
  }

  async function signInAs(userId: string) {
    setBusy(true);
    setProblem(null);
    try {
      await devSignIn(userId);
      queryClient.clear();
      router.history.push(returnPath);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : FAILED);
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.mark} aria-hidden="true">
          S
        </div>
        <h1 className={styles.title}>Sign in to Scout</h1>
        {message && (
          <p role="alert" className={styles.error}>
            {message}
          </p>
        )}
        {microsoftOn && (
          <Button className={styles.wide} onClick={() => void microsoft()} disabled={busy}>
            Continue with Microsoft
          </Button>
        )}
        {devList && <DevUserList users={devList} disabled={busy} onPick={signInAs} />}
      </div>
      {devList && (
        <p className={styles.footnote}>Developer sign-in is on. Turn it off before anyone outside the team can reach this app.</p>
      )}
    </main>
  );
}

type DevProps = { disabled: boolean };

function DevUserList({ users, disabled, onPick }: DevProps & { users: { id: string; name: string; email: string; platform_admin: boolean }[]; onPick: (id: string) => void }) {
  return (
    <section className={styles.dev} aria-labelledby="dev-sign-in">
      <h2 id="dev-sign-in" className={styles.devTitle}>
        Sign in as
      </h2>
      <ul className={styles.devList}>
        {users.map((u) => (
          <li key={u.id}>
            <button type="button" className={styles.devUser} disabled={disabled} onClick={() => onPick(u.id)}>
              <span className={styles.devName}>{u.name}</span>
              <span className={styles.devEmail}>{u.platform_admin ? `${u.email} · Platform admin` : u.email}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

