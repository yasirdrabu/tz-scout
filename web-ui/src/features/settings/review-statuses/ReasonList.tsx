import { Archive } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../../ui/Button';
import { IconButton } from '../../../ui/IconButton';
import type { ReasonRow } from './draft';
import styles from './ReviewStatuses.module.css';

type Props = {
  title: string;
  intro?: string;
  /** Shown instead of archiving the last live reason. */
  keepOne: string;
  rows: { row: ReasonRow; index: number }[];
  errors: Map<number, string[]>;
  disabled: boolean;
  onChange: (index: number, patch: Partial<ReasonRow>) => void;
  onArchive: (index: number) => void;
  onAdd: (label: string) => void;
};

/** One list of reasons (send back, or an AE's decline): each with "Note required" and "{n} this quarter", add and archive. */
export function ReasonList({ title, intro, keepOne, rows, errors, disabled, onChange, onArchive, onAdd }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const live = rows.filter(({ row }) => !row.archived);

  function archive(index: number) {
    if (live.length <= 1) {
      setProblem(keepOne);
      return;
    }
    setProblem(null);
    onArchive(index);
  }

  function add() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
    setProblem(null);
  }

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {title}
      </h2>
      {intro && <p className={styles.intro}>{intro}</p>}
      <ul className={styles.reasons}>
        {live.map(({ row, index }) => {
          const name = row.was ?? 'the new reason';
          const rowErrors = errors.get(index);
          return (
            <li key={row.id} className={styles.reason}>
              <div className={styles.reasonMain}>
                <input
                  className={`input ${styles.name}`}
                  aria-label={`Name of ${name}`}
                  value={row.label}
                  disabled={disabled}
                  {...(rowErrors ? { 'aria-invalid': true } : {})}
                  onChange={(e) => onChange(index, { label: e.target.value })}
                />
                {rowErrors?.map((m) => (
                  <p key={m} className={styles.error}>
                    {m}
                  </p>
                ))}
              </div>
              <label className={styles.switch}>
                <input type="checkbox" role="switch" aria-label={`Note required for ${name}`} checked={row.note_required} disabled={disabled} onChange={(e) => onChange(index, { note_required: e.target.checked })} />
                Note required
              </label>
              <span className={styles.used}>{row.used_this_quarter ?? 0} this quarter</span>
              <IconButton label={`Archive ${name}`} disabled={disabled} onClick={() => archive(index)}>
                <Archive />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className={styles.error}>
          {problem}
        </p>
      )}
      <div className={styles.addRow}>
        <input
          className={`input ${styles.name}`}
          aria-label={`Add a reason to ${title}`}
          placeholder="Add a reason"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={disabled || !text.trim()}>
          Add
        </Button>
      </div>
    </section>
  );
}
