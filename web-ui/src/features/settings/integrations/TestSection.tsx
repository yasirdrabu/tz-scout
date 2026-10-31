import { Button } from '../../../ui/Button';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { testIntegration, type Integration, type TestResult } from './api';

type Props = {
  service: Integration;
  tenant: string;
  result: TestResult | null;
  onTested: (r: TestResult) => void;
  onDone: () => Promise<unknown>;
};

const resultLine = (r: TestResult) => (r.ok ? `Connected. Round trip ${r.duration_ms} ms.` : r.message);

/** `Test connection` and what the last test found. */
export function TestSection({ service, tenant, result, onTested, onDone }: Props) {
  const { run, busy } = useRun();

  function test() {
    void run(async () => {
      const r = await testIntegration(tenant, service.key);
      onTested(r);
      await onDone();
      return r;
    }, resultLine);
  }

  return (
    <section className={styles.section} aria-label="Connection test">
      <div className={styles.row}>
        <Button size="sm" variant="secondary" onClick={test} disabled={busy}>
          Test connection
        </Button>
      </div>
      {result && (
        <div className={styles.note}>
          <p className={result.ok ? undefined : styles.danger}>{resultLine(result)}</p>
          {result.ok && result.message && <p>{result.message}</p>}
          {result.missing_permissions && result.missing_permissions.length > 0 && <p>Missing: {result.missing_permissions.join(', ')}</p>}
        </div>
      )}
    </section>
  );
}
