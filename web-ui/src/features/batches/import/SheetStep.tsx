import { Button } from '../../../ui/Button';
import styles from '../Batches.module.css';

/** §15: a workbook with several sheets asks which one to import, one row per sheet. */
export function SheetStep({ sheets, busy, onPick }: { sheets: string[]; busy: boolean; onPick: (sheet: string) => void }) {
  return (
    <div className={styles.panel}>
      <h2 className={styles.calloutTitle}>Pick the sheet to import</h2>
      <ul className={styles.lines}>
        {sheets.map((s) => (
          <li key={s}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPick(s)}>
              {s}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
