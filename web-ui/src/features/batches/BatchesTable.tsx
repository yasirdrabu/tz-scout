import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Pill, type PillTone } from '../../ui/Pill';
import table from '../../ui/Table.module.css';
import { useToast } from '../../ui/Toast';
import { errorText, useRun } from '../settings/shared';
import { downloadRejections, retryBatch, saveBlob, type Batch, type BatchStatusKey, type Stages } from './api';
import styles from './Batches.module.css';

const TONES: Record<BatchStatusKey, PillTone> = { complete: 'good', in_progress: 'accent', needs_attention: 'near', failed: 'bad' };

/** "{source} · {person}", or just the sender when there is no source. */
export const sentByText = (b: Pick<Batch, 'source' | 'sent_by'>) => [b.source?.name, b.sent_by.name].filter(Boolean).join(' · ');

/** The stacked bar: resolved, rejected and waiting rows, as shares of the bar (the numbers beside it are the API's). */
export function ProgressBar({ stages, label }: { stages: Stages; label: string }) {
  const parts = [
    { key: 'resolved', n: stages.resolved },
    { key: 'rejected', n: stages.rejected },
    { key: 'waiting', n: stages.waiting },
  ];
  const all = parts.reduce((s, p) => s + p.n, 0);
  return (
    <div>
      <div className={styles.progress} aria-hidden="true">
        {all > 0 && parts.map((p) => p.n > 0 && <span key={p.key} className={styles[p.key]} style={{ width: `${(p.n / all) * 100}%` }} />)}
      </div>
      <span className={table.muted}>{label}</span>
    </div>
  );
}

type Props = {
  tenant: string;
  rows: Batch[];
  /** Retry is for people with imports:run. */
  canRetry: boolean;
};

/** §13's table, shared by Batches and the Source page's Batches tab. Status, issue and progress words are the API's. */
export function BatchesTable({ tenant, rows, canRetry }: Props) {
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const retry = useRun();

  async function report(b: Batch) {
    try {
      saveBlob(await downloadRejections(tenant, b.id), `${b.id}-rejected.csv`);
    } catch (e) {
      toast.show(errorText(e));
    }
  }

  async function retryRows(b: Batch) {
    const ok = await retry.run(() => retryBatch(tenant, b.id), (r) => `Retrying ${r.retried} rows in ${b.id}. They're waiting again.`);
    if (ok) await qc.invalidateQueries({ queryKey: ['batches', tenant] });
  }

  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Batch</th>
            <th scope="col">Status</th>
            <th scope="col">Sent by</th>
            <th scope="col">Run date</th>
            <th scope="col" className={table.num}>
              Accounts
            </th>
            <th scope="col">Notes and files</th>
            <th scope="col">Progress</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>
                <Link to="/t/$tenant/batches/$id" params={{ tenant, id: b.id }} className={styles.link}>
                  {b.id}
                </Link>
              </td>
              <td>
                <Pill tone={TONES[b.status_key]}>{b.status_label}</Pill>
              </td>
              <td>{sentByText(b)}</td>
              <td>{f.date(b.run_at)}</td>
              <td className={table.num}>{f.number(b.item_count)}</td>
              <td>
                <div className={styles.cellStack}>
                  <span>{b.notes ?? b.name}</span>
                  {b.files[0] && <span className={table.muted}>{b.files[0].file_name}</span>}
                  {b.issue && <span className={styles.issue}>{b.issue}</span>}
                  {(canRetry && b.retryable > 0) || b.stages.rejected > 0 ? (
                    <div className={styles.rowActions}>
                      {canRetry && b.retryable > 0 && (
                        <Button size="sm" variant="secondary" disabled={retry.busy} onClick={() => void retryRows(b)}>
                          {`Retry ${b.retryable} rows`}
                        </Button>
                      )}
                      {b.stages.rejected > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => void report(b)}>
                          Download error report
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              </td>
              <td>
                <ProgressBar stages={b.stages} label={b.progress_label} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
