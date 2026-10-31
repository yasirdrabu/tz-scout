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

/** Initials in a circle. Set `decorative` when the name is already written next to it. */
export function Avatar({ name, size = 'md', decorative = false }: { name: string; size?: 'sm' | 'md'; decorative?: boolean }) {
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name };
  return (
    <span {...a11y} className={cx(styles.avatar, styles[size])}>
      {initialsOf(name)}
    </span>
  );
}
