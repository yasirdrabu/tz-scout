import { useQuery } from '@tanstack/react-query';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import styles from '../Admin.module.css';
import { runQuery } from './api';

const shown = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output, null, 2));

/**
 * A run expanded: what Scout sent (the subject and a fingerprint), what came back, and the error.
 * With `tenant`, one of that workspace's runs (`/api/v1/ai-runs/{id}`), else any tenant's (admin).
 */
export function RunDetail({ id, tenant }: { id: string; tenant?: string }) {
  const run = useQuery(runQuery(id, tenant));
  if (run.isPending) return <LoadingRows rows={2}>Loading the run</LoadingRows>;
  if (run.isError) return <LoadFailed title="This run didn't load" error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  return (
    <div className={styles.detail}>
      <section className={styles.section} aria-label="What Scout sent">
        <h3 className={styles.sectionTitle}>What Scout sent</h3>
        <dl className={styles.facts}>
          <dt>Account</dt>
          <dd>{r.subject ? `${r.subject.type} ${r.subject.id}` : 'None'}</dd>
          <dt>Fingerprint</dt>
          <dd className={table.mono}>{r.input_hash ?? 'None'}</dd>
          <dt>Prompt</dt>
          <dd>
            {r.prompt_version} · {r.mode}
          </dd>
        </dl>
        <p className={styles.note}>Scout doesn't keep the input itself.</p>
      </section>
      <section className={styles.section} aria-label="What came back">
        <h3 className={styles.sectionTitle}>What came back</h3>
        {r.output === null || r.output === undefined ? <p className={styles.note}>Nothing came back.</p> : <pre className={styles.pre}>{shown(r.output)}</pre>}
      </section>
      {r.error && (
        <section className={styles.section} aria-label="Error">
          <h3 className={styles.sectionTitle}>Error</h3>
          <p className={styles.bad}>{r.error}</p>
        </section>
      )}
    </div>
  );
}
