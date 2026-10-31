import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export type EmptyStateProps = {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
};

/** What an empty screen or section says: why it is empty and what to do next. */
export function EmptyState({ title, icon = <Check />, actions, note, children }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <div className={styles.tile} aria-hidden="true">
        {icon}
      </div>
      <h2 className={styles.title}>{title}</h2>
      {children && <p className={styles.text}>{children}</p>}
      {actions && <div className={styles.actions}>{actions}</div>}
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
