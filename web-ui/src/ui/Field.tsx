import { useId, type ReactNode } from 'react';
import styles from './Field.module.css';

/** What a control needs to be labelled and described by its field. */
export type FieldControl = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };

export type FieldProps = {
  label: string;
  hint?: ReactNode;
  /** Shown under the control and read with it. */
  error?: string | null;
  children: (control: FieldControl) => ReactNode;
};

/** A label, the control, a hint and an error, wired together for screen readers. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children({ id, ...(described ? { 'aria-describedby': described } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
