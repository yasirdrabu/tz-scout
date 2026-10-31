import type { ReactNode } from 'react';
import styles from './LoadingLine.module.css';

/** A thin moving bar and a line of what is loading. Used in place of a spinner. */
export function LoadingLine({ children }: { children: ReactNode }) {
  return (
    <div role="status" className={styles.loading}>
      <div className={styles.track} aria-hidden="true">
        <div className={styles.bar} />
      </div>
      <p className={styles.text}>{children}</p>
    </div>
  );
}
