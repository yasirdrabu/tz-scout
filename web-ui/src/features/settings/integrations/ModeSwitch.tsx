import { useId, useState } from 'react';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { setMode, type Integration } from './api';

type Props = { service: Integration; tenant: string; onChanged: () => Promise<unknown> };

const OPTIONS = [
  { mode: 'mock', label: 'Using sample data' },
  { mode: 'live', label: 'Live' },
] as const;

/** Sample data or live. Live asks first; the API needs a saved credential and a passing test. */
export function ModeSwitch({ service, tenant, onChanged }: Props) {
  const id = useId();
  const { run, busy } = useRun();
  const [confirm, setConfirm] = useState(false);
  const name = service.name;

  async function change(mode: 'mock' | 'live') {
    const ok = await run(async () => {
      await setMode(tenant, service.key, mode);
      await onChanged();
    }, mode === 'live' ? `${name} is live.` : `${name} is using sample data.`);
    if (ok) setConfirm(false);
  }

  function pick(mode: 'mock' | 'live') {
    if (mode === service.mode) return;
    if (mode === 'live') setConfirm(true);
    else void change('mock');
  }

  return (
    <fieldset className={styles.section}>
      <legend className={styles.sectionTitle}>Mode</legend>
      <div className={styles.segment}>
        {OPTIONS.map((o) => (
          <span key={o.mode}>
            <input
              id={`${id}-${o.mode}`}
              type="radio"
              name={`${id}-mode`}
              checked={service.mode === o.mode}
              disabled={busy}
              onChange={() => pick(o.mode)}
            />
            <label htmlFor={`${id}-${o.mode}`}>{o.label}</label>
          </span>
        ))}
      </div>
      <p className={styles.note}>
        {service.mode === 'live' ? `Scout reads and writes real records in ${name}.` : `Scout uses sample records and writes nothing to ${name}.`}
      </p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Switch ${name} to live?`}
        description={`Scout reads and writes real records in ${name}.`}
        confirmLabel="Switch to live"
        cancelLabel="Keep sample data"
        busy={busy}
        onConfirm={() => void change('live')}
      />
    </fieldset>
  );
}
