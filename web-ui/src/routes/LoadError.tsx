import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ApiError } from '../api/errors';
import { ErrorState } from '../ui/ErrorState';
import styles from './Page.module.css';

/** When a route cannot load: the API's detail, `Try again` and the error ref. */
export function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className={styles.centered}>
      <ErrorState
        title="Scout couldn't load this page"
        onRetry={() => void router.invalidate()}
        {...(error instanceof ApiError ? { errorRef: error.ref } : {})}
      >
        {error instanceof ApiError ? error.message : 'Something went wrong. Try again in a moment.'}
      </ErrorState>
    </div>
  );
}
