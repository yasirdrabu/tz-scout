import { useId, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './Card.module.css';

export type CardProps = { title?: string; actions?: ReactNode; className?: string; children: ReactNode };

/** A white card. With a title it is a named region. */
export function Card({ title, actions, className, children }: CardProps) {
  const id = useId();
  if (!title) return <div className={cx(styles.card, className)}>{children}</div>;
  return (
    <section className={cx(styles.card, className)} aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
