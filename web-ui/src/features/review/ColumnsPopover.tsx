import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronDown, ChevronUp, Columns3 } from 'lucide-react';
import { IconButton } from '../../ui/IconButton';
import { Popover } from '../../ui/Popover';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { columnsQuery, resetColumns, saveColumns, type Columns } from './api';
import styles from './Review.module.css';

/** `Columns {n} of 12`: show, hide and reorder the queue's columns, saved for this person (API). */
export function ColumnsPopover({ tenant, columns }: { tenant: string; columns: Columns }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const list = columns.columns;

  // Saved on every change; only a failure says so.
  async function save(next: Columns['columns'] | null) {
    setBusy(true);
    try {
      const out = next ? await saveColumns(tenant, next) : await resetColumns(tenant);
      queryClient.setQueryData(columnsQuery(tenant).queryKey, out);
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, by: -1 | 1) => {
    const next = [...list];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c!);
    void save(next);
  };

  return (
    <Popover
      label="Customize columns"
      align="end"
      className={styles.columns}
      trigger={
        <button type="button" className={styles.columnsButton}>
          <Columns3 aria-hidden="true" />
          Columns <span className={styles.muted}>{`${columns.shown} of ${columns.total}`}</span>
        </button>
      }
    >
      <div className={styles.columnsHead}>
        <span>Customize columns</span>
        <button type="button" className={styles.textButton} disabled={busy || columns.is_default} onClick={() => void save(null)}>
          Reset
        </button>
      </div>
      <p className={styles.columnsHint}>Show, hide and reorder. Saved for you only.</p>
      <div className={`${styles.columnRow} ${styles.columnFixed}`}>
        <input type="checkbox" checked disabled aria-label="Account" />
        <span className={styles.grow}>Account</span>
        <span className={styles.muted}>Always shown</span>
      </div>
      {list.map((c, i) => (
        <div key={c.key} className={styles.columnRow}>
          <input
            type="checkbox"
            id={`col-${c.key}`}
            checked={c.visible}
            disabled={busy}
            onChange={() => void save(list.map((x) => (x.key === c.key ? { ...x, visible: !x.visible } : x)))}
          />
          <label htmlFor={`col-${c.key}`} className={styles.grow}>
            {c.label}
          </label>
          <IconButton label={`Move ${c.label} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
            <ChevronUp />
          </IconButton>
          <IconButton label={`Move ${c.label} down`} disabled={busy || i === list.length - 1} onClick={() => move(i, 1)}>
            <ChevronDown />
          </IconButton>
        </div>
      ))}
    </Popover>
  );
}
