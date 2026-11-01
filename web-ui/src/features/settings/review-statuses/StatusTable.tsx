import { Archive, ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { IconButton } from '../../../ui/IconButton';
import table from '../../../ui/Table.module.css';
import type { Color } from '../../review/api';
import { StatusDot } from '../../review/parts';
import type { StatusRow } from './draft';
import styles from './ReviewStatuses.module.css';

const SET_BY = [
  { value: 'scout', label: 'Scout, automatically' },
  { value: 'reviewer', label: 'A reviewer' },
];

type Props = {
  rows: StatusRow[];
  colors: { value: Color; label: string }[];
  errors: Map<number, string[]>;
  disabled: boolean;
  onChange: (index: number, patch: Partial<StatusRow>) => void;
  onMove: (index: number, by: -1 | 1) => void;
  onArchive: (index: number) => void;
  onAdd: () => void;
};

/** The review statuses (screens.md §21d), live ones in order. `index` is the row's place in the whole list the save sends. */
export function StatusTable({ rows, colors, errors, disabled, onChange, onMove, onArchive, onAdd }: Props) {
  const live = rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.archived);
  return (
    <section className={styles.section} aria-labelledby="review-statuses-title">
      <div className={styles.sectionHead}>
        <h2 id="review-statuses-title" className={styles.sectionTitle}>
          Review statuses
        </h2>
        <Button variant="secondary" size="sm" icon={<Plus />} onClick={onAdd} disabled={disabled}>
          Add status
        </Button>
      </div>
      <div className={table.wrap}>
        <table className={`${table.table} ${styles.statuses}`}>
          <thead>
            <tr>
              <th>Color</th>
              <th>Name</th>
              <th>What it means</th>
              <th>Set by</th>
              <th>Flag after</th>
              <th className={table.num}>In it now</th>
              <th>
                <span className={styles.hidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {live.map(({ row, index }, at) => {
              const name = row.was ?? 'the new status';
              const rowErrors = errors.get(index);
              return (
                <tr key={row.id}>
                  <td>
                    <div className={styles.color}>
                      <StatusDot color={row.color}>{''}</StatusDot>
                      <select
                        className={`input ${styles.select}`}
                        aria-label={`Color for ${name}`}
                        value={row.color}
                        disabled={disabled}
                        onChange={(e) => onChange(index, { color: e.target.value as Color })}
                      >
                        {colors.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td>
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
                  </td>
                  <td>
                    <textarea
                      className={`input ${styles.meaning}`}
                      rows={2}
                      aria-label={`What ${name} means`}
                      value={row.description}
                      disabled={disabled}
                      onChange={(e) => onChange(index, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className={`input ${styles.select}`}
                      aria-label={`Who sets ${name}`}
                      value={row.set_by}
                      disabled={disabled}
                      onChange={(e) => onChange(index, { set_by: e.target.value as StatusRow['set_by'] })}
                    >
                      {SET_BY.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {row.is_final ? (
                      <span className={table.muted}>Final</span>
                    ) : (
                      <span className={styles.hours}>
                        <input
                          className={`input ${styles.hoursInput}`}
                          type="number"
                          min={1}
                          max={720}
                          inputMode="numeric"
                          placeholder="Never"
                          aria-label={`Flag ${name} after how many hours`}
                          value={row.flag_after_hours ?? ''}
                          disabled={disabled}
                          onChange={(e) => onChange(index, { flag_after_hours: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                        <span className={table.muted}>hours</span>
                      </span>
                    )}
                  </td>
                  <td className={table.num}>
                    {row.in_status_count ?? 0}
                    {row.late_count ? <span className={styles.late}> {row.late_count} late</span> : null}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <IconButton label={`Move ${name} up`} disabled={disabled || at === 0} onClick={() => onMove(index, -1)}>
                        <ArrowUp />
                      </IconButton>
                      <IconButton label={`Move ${name} down`} disabled={disabled || at === live.length - 1} onClick={() => onMove(index, 1)}>
                        <ArrowDown />
                      </IconButton>
                      {row.required ? (
                        <span className={`${table.muted} ${styles.required}`}>Scout needs this status</span>
                      ) : (
                        <IconButton label={`Archive ${name}`} disabled={disabled} onClick={() => onArchive(index)}>
                          <Archive />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
