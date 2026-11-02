import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Menu, MenuItem } from '../../ui/Menu';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { stagesQuery, type Stage } from '../settings/stages/api';
import styles from './Account.module.css';

const NOTE_MAX = 1000;

const moveStage = (tenant: string, id: string, stage: string, note: string) =>
  apiFetch<unknown>(`/accounts/${encodeURIComponent(id)}:move-stage`, { tenant, method: 'POST', body: { stage, ...(note ? { note } : {}) } });

type Props = { tenant: string; account: { id: string; name: string }; current: string | null; onMoved: () => void };

/** §4 `Move to stage` (review:act): a menu of the workspace's live stages, then an optional note (REV-E5-S4). */
export function MoveToStage({ tenant, account, current, onMoved }: Props) {
  const toast = useToast();
  const stages = useQuery(stagesQuery(tenant));
  const [target, setTarget] = useState<Stage | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = (stages.data?.stages ?? []).filter((s) => s.key !== current);
  if (live.length === 0) return null;

  function close() {
    setTarget(null);
    setNote('');
    setError(null);
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await moveStage(tenant, account.id, target.key, note.trim());
      toast.show(`${account.name} moved to ${target.name}.`);
      close();
      onMoved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button size="sm" variant="secondary">
            Move to stage
          </Button>
        }
      >
        {live.map((s) => (
          <MenuItem key={s.key} onSelect={() => setTarget(s)}>
            {s.name}
          </MenuItem>
        ))}
      </Menu>
      {target && (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && close()}
          title={`Move ${account.name} to ${target.name}`}
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={busy}>
                Move
              </Button>
            </>
          }
        >
          <Field label="Note" hint="Optional. It shows in the account's history.">
            {(c) => <textarea {...c} className="input" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {error && (
            <p role="alert" className={styles.moveError}>
              {error}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
