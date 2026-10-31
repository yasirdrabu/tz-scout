import { cx } from '../lib/cx';
import styles from './Avatar.module.css';

/** First and last initials of a name, "?" for none. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0];
  if (!first) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : undefined;
  return (first + (last ?? '')).toUpperCase();
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span role="img" aria-label={name} className={cx(styles.avatar, styles[size])}>
      {initialsOf(name)}
    </span>
  );
}
