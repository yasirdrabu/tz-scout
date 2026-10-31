import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../lib/cx';
import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  /** What the button does; it is the accessible name, since the icon has no text. */
  label: string;
  variant?: 'ghost' | 'secondary';
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

export function IconButton({ label, variant = 'ghost', className, type = 'button', children, ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} title={label} className={cx(styles.button, styles[variant], className)} {...rest}>
      <span aria-hidden="true" className={styles.icon}>
        {children}
      </span>
    </button>
  );
}
