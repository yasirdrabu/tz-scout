import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useFormat } from '../../../lib/useFormat';
import { buttonClass } from '../../../ui/Button';
import { LoadingLine } from '../../../ui/LoadingLine';
import { LoadFailed } from '../../settings/shared';
import { batchQuery, importQuery } from '../api';
import styles from '../Batches.module.css';
import { ProgressBar } from '../BatchesTable';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * §15 Resolve: polls the import and its batch every 2 s (C14) until the import has run and the batch is no longer
 * in progress, then says what happened, with the counts from the API.
 */
export function ResolveStep({ tenant, importId, canReview }: { tenant: string; importId: string; canReview: boolean }) {
  const f = useFormat();
  const imp = useQuery(importQuery(tenant, importId, true));
  const ran = imp.data?.status === 'imported' || imp.data?.status === 'failed';
  const batchId = imp.data?.batch_id;
  const batch = useQuery({
    ...batchQuery(tenant, batchId ?? ''),
    enabled: !!batchId,
    refetchInterval: (query) => (!ran || query.state.data?.status_key === 'in_progress' ? 2_000 : false),
  });

  if (imp.isError) return <LoadFailed title="The import didn't load" error={imp.error} onRetry={() => void imp.refetch()} />;
  if (batch.isError) return <LoadFailed title="The batch didn't load" error={batch.error} onRetry={() => void batch.refetch()} />;
  const b = batch.data;
  const done = ran && !!b && b.status_key !== 'in_progress';
  const resolved = b?.stages.resolved ?? 0;
  const waiting = b?.stages.waiting ?? 0;

  return (
    <div className={styles.panel}>
      <ul className={styles.lines}>
        {batchId && <li>{`Batch ${batchId} created`}</li>}
        {done ? (
          b.status_key === 'failed' ? (
            <li className={styles.issue}>{b.issue}</li>
          ) : (
            <li className={styles.calloutTitle}>
              {`Done. ${f.number(resolved)} ${plural(resolved, 'account', 'accounts')} resolved. ${f.number(waiting)} ${plural(waiting, 'row needs', 'rows need')} you.`}
            </li>
          )
        ) : (
          <li>
            <LoadingLine>Matching companies and checking for duplicates</LoadingLine>
          </li>
        )}
        {done && canReview && b.in_queue !== null && <li>{`${f.number(b.in_queue)} are in the review queue.`}</li>}
        {b && <li className={styles.muted}>{`${b.notes ?? b.name} · ${f.number(b.item_count)} accounts`}</li>}
      </ul>
      {b && <ProgressBar stages={b.stages} label={b.progress_label} />}
      {done && (
        <div className={styles.buttons}>
          {waiting > 0 && (
            <Link to="/t/$tenant/batches/$id" params={{ tenant, id: b.id }} search={{ tab: 'waiting' }} className={buttonClass('primary')}>
              {`Open the ${f.number(waiting)} waiting rows`}
            </Link>
          )}
          {canReview && (
            <Link to="/t/$tenant/queue" params={{ tenant }} className={buttonClass('secondary')}>
              Go to review queue
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
