import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { errorText, LoadFailed, LoadingRows } from '../../settings/shared';
import { confirmImport, previewImport, type MappingColumn } from '../api';
import styles from '../Batches.module.css';

type Props = { tenant: string; importId: string; mapping: MappingColumn[]; onBack: () => void; onStarted: () => void };

/** §15 Confirm: how many rows have no website (from `:preview`), then `:confirm` starts the import. */
export function ConfirmStep({ tenant, importId, mapping, onBack, onStarted }: Props) {
  const f = useFormat();
  const preview = useQuery({
    queryKey: ['imports', tenant, importId, 'preview', mapping],
    queryFn: () => previewImport(tenant, importId, mapping),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await confirmImport(tenant, importId, mapping);
      onStarted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (preview.isPending) return <LoadingRows>Checking the rows</LoadingRows>;
  if (preview.isError) return <LoadFailed title="The rows didn't load" error={preview.error} onRetry={() => void preview.refetch()} />;
  const held = preview.data.without_website;
  const go = preview.data.go_ahead;
  return (
    <div className={styles.panel}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {held > 0 && (
        <div className={styles.callout} role="note">
          <p className={styles.calloutTitle}>{held === 1 ? '1 row has no website' : `${f.number(held)} rows have no website`}</p>
          <p className={styles.muted}>
            {`${held === 1 ? "It'll" : "They'll"} be held in the batch until you add one. The other ${f.number(go)} rows go ahead now. You can add websites here or later from the batch.`}
          </p>
        </div>
      )}
      <div className={styles.buttons}>
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button disabled={busy} onClick={() => void start()}>
          {held > 0 ? `Import ${f.number(go)} rows and hold ${f.number(held)}` : `Import ${f.number(go)} rows`}
        </Button>
      </div>
    </div>
  );
}
