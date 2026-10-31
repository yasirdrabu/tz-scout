import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './Pill.module.css';

export type PillTone = 'good' | 'near' | 'bad' | 'neutral' | 'accent';

/** A status: coloured dot and label. Colour carries meaning only together with the label. */
export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className={cx(styles.pill, styles[tone])}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
