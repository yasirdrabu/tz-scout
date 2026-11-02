import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { IconButton } from '../../../ui/IconButton';
import table from '../../../ui/Table.module.css';
import type { Trigger } from './api';
import { canMove, triggerOpen, type Row } from './draft';
import styles from './PipelineStages.module.css';

type Props = {
  kind: 'flow' | 'exit';
  title: string;
  intro: string;
  addLabel: string;
  /** Every row of the draft, in the order the save sends: a row's `index` is its place in it. */
  all: Row[];
  triggers: Trigger[];
  /** The API's errors by `{index}.{field}`. */
  errors: Map<string, string[]>;
  disabled: boolean;
  onChange: (index: number, patch: Partial<Row>) => void;
  onMove: (index: number, by: -1 | 1) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
};

/** One of the two tables of screens.md §21e: Stages (flow) or Exits. */
export function StageTable({ kind, title, intro, addLabel, all, triggers, errors, disabled, onChange, onMove, onDelete, onAdd }: Props) {
  const rows = all.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === kind);
  const id = `stages-${kind}`;
  const labelOf = (key: string) => triggers.find((t) => t.key === key)?.label ?? key;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <div>
          <h2 id={id} className={styles.sectionTitle}>
            {title}
          </h2>
          <p className={styles.sectionIntro}>{intro}</p>
        </div>
        <Button variant="secondary" size="sm" icon={<Plus />} onClick={onAdd} disabled={disabled}>
          {addLabel}
        </Button>
      </div>
      <div className={table.wrap}>
        <table className={`${table.table} ${styles.stages}`} aria-label={title}>
          <thead>
            <tr>
              <th>Name</th>
              <th>What it means</th>
              <th>Moves here when</th>
              <th>HubSpot stage</th>
              <th>{kind === 'flow' ? 'Quarter target' : 'Target'}</th>
              <th>
                <span className={styles.hidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, index }, at) => {
              const name = row.was ?? (kind === 'flow' ? 'the new stage' : 'the new exit');
              const errs = (field: string) => errors.get(`${index}.${field}`);
              const hubspotNeeded = row.trigger === 'deal_reaches_stage';
              const fieldErrors = (field: string) =>
                errs(field)?.map((m) => (
                  <p key={m} className={styles.error}>
                    {m}
                  </p>
                ));
              return (
                <tr key={row.id}>
                  <td>
                    <span className={styles.nameCell}>
                      <span className={row.locked === 'won' ? styles.dotWon : styles.dot} aria-hidden="true">
                        {kind === 'flow' ? at + 1 : '–'}
                      </span>
                      <input
                        className={`input ${styles.name}`}
                        aria-label={`Name of ${name}`}
                        value={row.name}
                        disabled={disabled}
                        {...(errs('name') ? { 'aria-invalid': true } : {})}
                        onChange={(e) => onChange(index, { name: e.target.value })}
                      />
                    </span>
                    {fieldErrors('name')}
                  </td>
                  <td>
                    <input
                      className={`input ${styles.meaning}`}
                      aria-label={`What ${name} means`}
                      value={row.description}
                      disabled={disabled}
                      onChange={(e) => onChange(index, { description: e.target.value })}
                    />
                    {fieldErrors('description')}
                  </td>
                  <td>
                    {row.locked ? (
                      <span>{labelOf(row.trigger)}</span>
                    ) : (
                      <select
                        className={`input ${styles.select}`}
                        aria-label={`Moves here when for ${name}`}
                        value={row.trigger}
                        disabled={disabled}
                        {...(errs('trigger') ? { 'aria-invalid': true } : {})}
                        onChange={(e) => onChange(index, { trigger: e.target.value })}
                      >
                        {triggers.map((t) => (
                          <option key={t.key} value={t.key} disabled={!triggerOpen(t, row, all)}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {fieldErrors('trigger')}
                  </td>
                  <td>
                    <input
                      className={`input ${styles.hubspot}`}
                      aria-label={`HubSpot stage for ${name}`}
                      placeholder="Not synced"
                      value={row.hubspot_stage}
                      required={hubspotNeeded}
                      disabled={disabled}
                      {...(errs('hubspot_stage') ? { 'aria-invalid': true } : {})}
                      onChange={(e) => onChange(index, { hubspot_stage: e.target.value })}
                    />
                    {fieldErrors('hubspot_stage')}
                  </td>
                  <td>
                    <input
                      className={`input ${styles.target}`}
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      aria-label={`${kind === 'flow' ? 'Quarter target' : 'Target'} for ${name}`}
                      value={kind === 'exit' ? '' : row.quarter_target}
                      disabled={disabled || kind === 'exit'}
                      {...(errs('quarter_target') ? { 'aria-invalid': true } : {})}
                      onChange={(e) => onChange(index, { quarter_target: e.target.value })}
                    />
                    {fieldErrors('quarter_target')}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <IconButton label={`Move ${name} up`} disabled={disabled || !canMove(all, index, -1)} onClick={() => onMove(index, -1)}>
                        <ArrowUp />
                      </IconButton>
                      <IconButton label={`Move ${name} down`} disabled={disabled || !canMove(all, index, 1)} onClick={() => onMove(index, 1)}>
                        <ArrowDown />
                      </IconButton>
                      <IconButton label={`Delete ${name}`} disabled={disabled} onClick={() => onDelete(index)}>
                        <Trash2 />
                      </IconButton>
                    </div>
                    {fieldErrors('')}
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
