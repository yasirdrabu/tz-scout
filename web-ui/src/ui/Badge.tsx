import styles from './Badge.module.css';

const MAX = 999;

/** A count, for example accounts waiting. `label` says what is counted, for screen readers. */
export function Badge({ count, label }: { count: number; label: string }) {
  return (
    <span className={styles.badge}>
      {count > MAX ? `${MAX}+` : count}{' '}
      <span className="sr-only">{label}</span>
    </span>
  );
}
