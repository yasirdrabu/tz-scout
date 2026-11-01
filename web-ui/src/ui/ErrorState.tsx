import type { ReactNode } from 'react';
import { Button } from './Button';
import styles from './ErrorState.module.css';

export type ErrorStateProps = {
  /** What failed, for example "The review queue didn't load". */
  title: string;
  /** What to do next. */
  children?: ReactNode;
  onRetry?: () => void;
  /** From the API's correlation id, so support can find the request. */
  errorRef?: string;
  /** Printed before the ref, for example the account id: "{subject} · Error ref {ref}". */
  subject?: string;
  actions?: ReactNode;
};

export function ErrorState({ title, children, onRetry, errorRef, subject, actions }: ErrorStateProps) {
  return (
    <div role="alert" className={styles.error}>
      <div className={styles.tile} aria-hidden="true">
        !
      </div>
      <h2 className={styles.title}>{title}</h2>
      {children && <p className={styles.text}>{children}</p>}
      {(onRetry || actions) && (
        <div className={styles.actions}>
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {actions}
        </div>
      )}
      {errorRef && <p className={styles.ref}>{subject ? `${subject} · Error ref ${errorRef}` : `Error ref ${errorRef}`}</p>}
    </div>
  );
}
