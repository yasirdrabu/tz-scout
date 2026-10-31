import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './Chip.module.css';

export type ChipProps = {
  /** Plain text, so the remove button can say what it removes. */
  children: string;
  icon?: ReactNode;
  onRemove?: () => void;
};

/** A small tag, for example an active filter "{Category} {value}". */
export function Chip({ children, icon, onRemove }: ChipProps) {
  return (
    <span className={styles.chip}>
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
      {onRemove && (
        <button type="button" className={styles.remove} aria-label={`Remove ${children}`} onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
