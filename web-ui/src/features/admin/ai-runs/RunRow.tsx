import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useId } from 'react';
import { cx } from '../../../lib/cx';
import { useFormat } from '../../../lib/useFormat';
import { Pill, type PillTone } from '../../../ui/Pill';
import table from '../../../ui/Table.module.css';
import styles from '../Admin.module.css';
import { statusLabel, taskLabel, type AiRun, type RunStatus } from './api';
import { RunDetail } from './RunDetail';

/** A run slower than this shows its time in red. */
const SLOW_MS = 30_000;

const TONE: Record<RunStatus, PillTone> = { succeeded: 'good', failed: 'bad', stopped_by_limit: 'near' };

type Props = {
  run: Omit<AiRun, 'tenant_name'> & { tenant_name?: string | null };
  expanded: boolean;
  onToggle: () => void;
  /** A workspace's own runs (Settings > AI runs): no tenant column, and the detail comes from `/v1/ai-runs`. */
  tenant?: string;
};

/**
 * One run row and, expanded, its detail. Across tenants (§23) the fourth column is tenant and model;
 * in one workspace it is the model alone, so the table has the same eight columns either way.
 */
export function RunRow({ run: r, expanded, onToggle, tenant }: Props) {
  const f = useFormat();
  const detailId = useId();
  const model = r.model ?? 'Rules, no model';
  return (
    <Fragment>
      <tr>
        <td>
          <button type="button" className={cx(table.open, table.mono)} aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
            {expanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />} {r.id}
          </button>
        </td>
        <td>
          <div className={styles.stack}>
            <Pill tone={TONE[r.status]}>{statusLabel(r.status)}</Pill>
            {r.outcome === 'invalid_output' && <span className={table.muted}>Answer rejected</span>}
          </div>
        </td>
        <td>
          <div className={styles.stack}>
            <span>{taskLabel(r.task)}</span>
            <span className={table.muted}>{r.subject ? `${r.subject.type} ${r.subject.id}` : 'No account'}</span>
          </div>
        </td>
        <td>
          {tenant ? (
            model
          ) : (
            <div className={styles.stack}>
              <span>{r.tenant_name ?? r.tenant_id}</span>
              <span className={table.muted}>{model}</span>
            </div>
          )}
        </td>
        <td className={table.num}>
          {f.compact(r.input_tokens)} in · {f.compact(r.output_tokens)} out
        </td>
        <td className={table.num}>{f.money(r.cost_cents)}</td>
        <td className={cx(table.num, r.duration_ms > SLOW_MS && styles.bad)}>{f.duration(r.duration_ms)}</td>
        <td className={table.muted}>{f.dateTime(r.created_at)}</td>
      </tr>
      {expanded && (
        <tr id={detailId}>
          <td colSpan={8}>
            <RunDetail id={r.id} tenant={tenant} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
