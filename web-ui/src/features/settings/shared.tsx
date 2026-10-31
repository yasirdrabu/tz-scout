import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { ErrorState } from '../../ui/ErrorState';
import { LoadingLine } from '../../ui/LoadingLine';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import styles from './Settings.module.css';

/** The copy for a failed call: the API's detail or title. */
export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again in a moment.');

/** Copies text; false when the browser refuses (no clipboard access). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one action at a time: on success shows `done` as a toast, on failure the API's words.
 * Resolves true when it worked.
 */
export function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run<T>(action: () => Promise<T>, done: string | ((result: T) => string)): Promise<boolean> {
    setBusy(true);
    try {
      const result = await action();
      toast.show(typeof done === 'string' ? done : done(result));
      return true;
    } catch (e) {
      toast.show(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy };
}

/** Skeleton rows with a line of what is loading. */
export function LoadingRows({ children, rows = 4 }: { children: string; rows?: number }) {
  return (
    <div className={styles.loading}>
      <LoadingLine>{children}</LoadingLine>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={14} soft={i % 2 === 1} />
      ))}
    </div>
  );
}

/** What failed, the API's words, Try again and the error ref. */
export function LoadFailed({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <ErrorState title={title} onRetry={onRetry} {...(error instanceof ApiError ? { errorRef: error.ref } : {})}>
      {errorText(error)}
    </ErrorState>
  );
}
