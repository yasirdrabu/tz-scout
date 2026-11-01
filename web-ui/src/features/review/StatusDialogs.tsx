import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { errorText } from '../settings/shared';
import { changeStatus, reasonsFor, reasonsQuery, type ReviewStatus } from './api';
import { NOTE_MAX, ReasonPicker, reasonReady } from './ReasonPicker';
import styles from './Review.module.css';

type Props = {
  tenant: string;
  account: { account_id: string; name: string };
  status: ReviewStatus;
  onClose: () => void;
  /** After the API took the change; `to` is the key it moved to. */
  onDone: (to: string) => void;
};

/** Picking a declined status in the peek: a decline reason first, and a note when the reason needs one. */
export function DeclineDialog({ tenant, account, status, onClose, onDone }: Props) {
  const reasons = useQuery(reasonsQuery(tenant));
  const list = reasonsFor(reasons.data?.data ?? [], 'review');
  const [reasonKey, setReasonKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reasonKey) return;
    setBusy(true);
    setError(null);
    try {
      await changeStatus(tenant, account.account_id, { to: status.key, reason_key: reasonKey, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(status.key);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Why is ${account.name} ${status.label.toLowerCase()}?`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="dark" onClick={() => void submit()} disabled={busy || !reasonReady(list, reasonKey, note)}>
            {`Mark ${status.label}`}
          </Button>
        </>
      }
    >
      {reasons.isError ? (
        <p role="alert" className={styles.error}>
          {errorText(reasons.error)}
        </p>
      ) : (
        <ReasonPicker
          legend="Reason"
          reasons={list}
          reasonKey={reasonKey}
          onReason={setReasonKey}
          note={note}
          onNote={setNote}
          noteLabel="Note"
          noteRequiredHint="This reason needs a note."
        />
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Moving a declined account to another status: a note first, and the API puts it back in review. */
export function ReopenDialog({ tenant, account, status, onClose, onDone }: Props) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const out = await changeStatus(tenant, account.account_id, { to: status.key, note: note.trim() });
      const to = (out as { review_status_key?: unknown } | null)?.review_status_key;
      onDone(typeof to === 'string' ? to : status.key);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reopen ${account.name}?`}
      description="It goes back in review, and the note goes in its change log."
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !note.trim()}>
            Reopen
          </Button>
        </>
      }
    >
      <Field label="Why are you reopening it?" error={error}>
        {(c) => <textarea {...c} className="input" value={note} maxLength={NOTE_MAX} required onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
