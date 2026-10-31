import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Drawer } from '../../../ui/Drawer';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { disconnect, integrationsQuery, setDisabled, type Integration, type TestResult } from './api';
import { CallsList } from './CallsList';
import { CredentialSection } from './CredentialSection';
import { ModeSwitch } from './ModeSwitch';
import { TestSection } from './TestSection';

type Props = { service: Integration; tenant: string; onClose: () => void };

/** §21b manage panel: credential, test, mode, today's usage, the last 50 calls, turn off and disconnect. */
export function ManagePanel({ service, tenant, onClose }: Props) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: integrationsQuery(tenant).queryKey });
  const name = service.name;
  const off = service.status === 'disabled';

  async function onDisconnect() {
    const ok = await run(async () => {
      await disconnect(tenant, service.key);
      await refresh();
    }, `Disconnected ${name}. Scout stopped calling it and switched to sample data.`);
    if (ok) {
      setConfirm(false);
      setResult(null);
    }
  }

  const footer = (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await setDisabled(tenant, service.key, !off);
            await refresh();
          }, off ? `${name} turned on.` : `${name} turned off. Scout stops calling it.`)
        }
      >
        {off ? 'Turn on' : 'Turn off'}
      </Button>
      {service.credentials.length > 0 && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>
          <span className={styles.danger}>Disconnect</span>
        </Button>
      )}
    </>
  );

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={name} subtitle={service.used_for} width={420} footer={footer}>
      <CredentialSection service={service} tenant={tenant} onSaved={refresh} onTested={setResult} />
      <TestSection service={service} tenant={tenant} result={result} onTested={setResult} onDone={refresh} />
      <ModeSwitch service={service} tenant={tenant} onChanged={refresh} />
      <div className={styles.tiles}>
        <Tile label="Calls today" value={f.number(service.calls_today)} />
        <Tile label="Errors today" value={f.number(service.errors_today)} />
        <Tile label="Response average" value={service.avg_ms === null ? 'No calls' : `${f.number(service.avg_ms)} ms`} />
      </div>
      <CallsList tenant={tenant} serviceKey={service.key} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${name}?`}
        description="Scout stops calling it, deletes the saved credentials and switches to sample data."
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void onDisconnect()}
      />
    </Drawer>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
    </div>
  );
}
