import { useId } from 'react';
import { Field } from '../../ui/Field';
import type { Reason } from './api';
import styles from './Review.module.css';

export const NOTE_MAX = 4000;

export type ReasonPickerProps = {
  legend: string;
  reasons: Reason[];
  reasonKey: string | null;
  onReason: (key: string) => void;
  note: string;
  onNote: (note: string) => void;
  noteLabel: string;
  /** Under the note when the picked reason is marked "Note required". */
  noteRequiredHint: string;
  error?: string | null;
};

/** True when a reason is picked and, if it needs one, a note is written (C5, Decision 1). */
export const reasonReady = (reasons: Reason[], key: string | null, note: string) => {
  const r = reasons.find((x) => x.key === key);
  return !!r && (!r.note_required || note.trim().length > 0);
};

/** Reason chips (one required) and a note that is required only for a reason marked "Note required". */
export function ReasonPicker({ legend, reasons, reasonKey, onReason, note, onNote, noteLabel, noteRequiredHint, error }: ReasonPickerProps) {
  const name = useId();
  const picked = reasons.find((r) => r.key === reasonKey);
  return (
    <div className={styles.stack}>
      <fieldset className={styles.chips}>
        <legend className={styles.chipsLegend}>{legend}</legend>
        {reasons.map((r) => (
          <label key={r.key} className={styles.reason}>
            <input type="radio" name={name} value={r.key} checked={r.key === reasonKey} onChange={() => onReason(r.key)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <Field label={noteLabel} hint={picked?.note_required ? noteRequiredHint : undefined} error={error ?? null}>
        {(c) => (
          <textarea
            {...c}
            className="input"
            value={note}
            maxLength={NOTE_MAX}
            required={picked?.note_required ?? false}
            onChange={(e) => onNote(e.target.value)}
          />
        )}
      </Field>
      {!picked && <p className={styles.note}>Pick a reason to continue.</p>}
    </div>
  );
}
