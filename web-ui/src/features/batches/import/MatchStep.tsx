import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import table from '../../../ui/Table.module.css';
import type { ImportView, MappingColumn } from '../api';
import styles from '../Batches.module.css';

type Props = {
  view: ImportView;
  mapping: MappingColumn[];
  onChange: (mapping: MappingColumn[]) => void;
  busy: boolean;
  onDifferentFile: () => void;
  onContinue: () => void;
};

/** "{type} {file}, {n} rows · {sheet} · uploaded by {person}", leaving out a missing sheet. */
export function fileCard(view: ImportView, rows: (n: number) => string): string {
  return [`${view.file.type} ${view.file.name}, ${rows(view.row_count)} rows`, view.file.sheet, `uploaded by ${view.uploaded_by.name}`].filter(Boolean).join(' · ');
}

/** The tag beside a column: what Scout suggested, what it found no match for, or what the person changed. */
function tagOf(original: MappingColumn | undefined, now: MappingColumn): string {
  if ((original?.target ?? null) !== now.target) return 'Changed by you';
  return now.target === null ? 'No match. Check this one' : 'Suggested';
}

/** §15 Match columns: each column with its sample values and the Scout field from the API's list. */
export function MatchStep({ view, mapping, onChange, busy, onDifferentFile, onContinue }: Props) {
  const f = useFormat();
  const set = (header: string, target: string | null) => onChange(mapping.map((c) => (c.header === header ? { ...c, target } : c)));
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <p>{fileCard(view, f.number)}</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDifferentFile}>
          Use a different file
        </Button>
      </div>
      <div>
        <h2 className={styles.calloutTitle}>Match your columns</h2>
        <p className={styles.muted}>{`Scout suggested ${view.suggested_count} of ${view.headers.length}. Check them, then confirm.`}</p>
      </div>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Your column</th>
              <th scope="col">Sample values</th>
              <th scope="col">Scout field</th>
              <th scope="col">
                <span className="sr-only">Check</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.headers.map((header, i) => {
              const now = mapping.find((c) => c.header === header) ?? { header, target: null, confidence: 0 };
              const samples = view.sample_rows.slice(0, 3).map((r) => r[i] ?? '').filter(Boolean);
              return (
                <tr key={header}>
                  <td>{header}</td>
                  <td className={table.muted}>{samples.join(', ')}</td>
                  <td>
                    <select
                      className="input"
                      aria-label={`Scout field for ${header}`}
                      value={now.target ?? ''}
                      onChange={(e) => set(header, e.target.value || null)}
                    >
                      {view.targets.map((t) => (
                        <option key={t.key ?? ''} value={t.key ?? ''}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={styles.tag}>{tagOf(view.mapping.find((c) => c.header === header), now)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.buttons}>
        <Button onClick={onContinue} disabled={busy}>
          Continue
        </Button>
      </div>
    </div>
  );
}
