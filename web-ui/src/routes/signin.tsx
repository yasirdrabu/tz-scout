import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useRouter } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { devSignIn, devUsers, safeReturnPath, startMicrosoftSignIn } from '../api/auth';
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
  const dev = useQuery({ queryKey: ['dev-users'], queryFn: devUsers, retry: false, staleTime: Infinity });

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
        <Button className={styles.wide} onClick={() => void microsoft()} disabled={busy}>
          Continue with Microsoft
        </Button>
        {dev.data && dev.data.length > 0 && <DevUserList users={dev.data} disabled={busy} onPick={signInAs} />}
        {dev.isFetched && dev.data === null && import.meta.env.DEV && <DevUserIdForm disabled={busy} onSubmit={signInAs} />}
      </div>
      {dev.data && dev.data.length > 0 && (
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

/** Local development only: the API has no dev user list yet, so take a user id. */
function DevUserIdForm({ disabled, onSubmit }: DevProps & { onSubmit: (id: string) => void }) {
  const id = useId();
  const [userId, setUserId] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (userId.trim()) onSubmit(userId.trim());
  }
  return (
    <form className={styles.dev} onSubmit={submit}>
      <label htmlFor={id} className={styles.devTitle}>
        Developer sign-in: user id
      </label>
      <div className={styles.devRow}>
        <input id={id} className={styles.input} value={userId} onChange={(e) => setUserId(e.target.value)} autoComplete="off" />
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || !userId.trim()}>
          Sign in as this user
        </Button>
      </div>
      <p className={styles.hint}>Works when the backend has AUTH_DEV_SIGNIN=true.</p>
    </form>
  );
}
