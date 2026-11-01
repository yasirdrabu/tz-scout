import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { bulk, changeStatus, reasonsFor, reasonsQuery, reviewQuery, statusesQuery, type BulkResult, type DialogAccount } from './api';
import { ReasonPicker, reasonReady } from './ReasonPicker';
import styles from './Review.module.css';

export type SendBackProps = {
  tenant: string;
  /** One account (peek, a status pick) or up to 50 (the bulk bar). */
  accounts: DialogAccount[];
  onClose: () => void;
  /** After the API answered: the accounts sent back and the ones it refused, with its words. */
  onDone: (sent: string[], refused: { account_id: string; message: string }[]) => void;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** §5 Send-back dialog: a reason is required on every path, bulk included (C5); the note only for a reason that needs one. */
export function SendBackDialog({ tenant, accounts, onClose, onDone }: SendBackProps) {
  const toast = useToast();
  const single = accounts.length === 1 ? accounts[0]! : null;
  const reasons = useQuery(reasonsQuery(tenant));
  const statuses = useQuery(statusesQuery(tenant));
  const review = useQuery({ ...reviewQuery(tenant, single?.account_id ?? ''), enabled: single !== null });
  const [reasonKey, setReasonKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; onNote: boolean } | null>(null);

  const list = reasonsFor(reasons.data?.data ?? [], 'send_back');
  const target = statuses.data?.data.find((s) => s.returns_to_source && !s.archived);
  const source = single?.source ?? null;
  const owner = single && source ? (review.data?.sources.find((s) => s.source_id === source.source_id) ?? review.data?.sources[0])?.owner_name ?? null : null;

  const title = !single
    ? `Send ${accounts.length} accounts back to their sources`
    : source
      ? owner
        ? `Send back to ${source.name} (${owner})`
        : `Send back to ${source.name}`
      : `Send ${single.name} back to its source`;
  const action = owner ? `Send back to ${firstName(owner)}` : 'Send back';
  const ready = !!target && reasonReady(list, reasonKey, note) && !busy;

  async function submit() {
    if (!target || !reasonKey) return;
    setBusy(true);
    setError(null);
    const change = { to: target.key, reason_key: reasonKey, ...(note.trim() ? { note: note.trim() } : {}) };
    try {
      if (single) {
        await changeStatus(tenant, single.account_id, change);
        toast.show(`Sent back to ${owner ?? source?.name ?? 'its source'}. ${single.name} left the queue.`);
        onDone([single.account_id], []);
      } else {
        const { results } = await bulk(tenant, accounts.map((a) => a.account_id), { action: 'status', ...change });
        const sent = results.filter((r) => r.ok).map((r) => r.account_id);
        const refused = results.filter((r): r is Extract<BulkResult, { ok: false }> => !r.ok).map((r) => ({ account_id: r.account_id, message: r.message }));
        if (sent.length > 0) toast.show(sent.length === 1 ? 'Sent 1 account back to its source.' : `Sent ${sent.length} accounts back to their sources.`);
        onDone(sent, refused);
      }
    } catch (e) {
      setError({ text: errorText(e), onNote: e instanceof ApiError && e.errors.some((x) => x.path === 'note') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      {...(single ? {} : { description: 'One reason and note go with every account.' })}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready}>
            {action}
          </Button>
        </>
      }
    >
      {reasons.isError || statuses.isError ? (
        <p role="alert" className={styles.error}>
          {errorText(reasons.error ?? statuses.error)}
        </p>
      ) : reasons.isPending || statuses.isPending ? (
        <p className={styles.note}>Loading the send-back reasons</p>
      ) : !target ? (
        <p role="alert" className={styles.error}>
          There is no send-back status in Settings, so Scout can't send this back. Ask an owner to check Review statuses.
        </p>
      ) : (
        <ReasonPicker
          legend="Reason"
          reasons={list}
          reasonKey={reasonKey}
          onReason={setReasonKey}
          note={note}
          onNote={setNote}
          noteLabel="What should the source fix before sending this again?"
          noteRequiredHint="This reason needs a note. Say what the source should fix."
          error={error?.onNote ? error.text : null}
        />
      )}
      {error && !error.onNote && (
        <p role="alert" className={styles.error}>
          {error.text}
        </p>
      )}
    </Dialog>
  );
}
