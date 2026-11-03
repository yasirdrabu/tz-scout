import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { declineRequest, type EnrichmentRequest } from './api';
import styles from './Enrichment.module.css';
import { DECLINE_NEEDED, declinedText } from './words';

const REASON_MAX = 500;

/** §22 Decline dialog: the reason is required, and the requester will see it. */
export function DeclineDialog({ tenant, request, onClose }: { tenant: string; request: EnrichmentRequest; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const why = reason.trim();
    if (!why) {
      setReasonError(DECLINE_NEEDED);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await declineRequest(tenant, request.id, why);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['enrichment-requests', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['account', tenant, request.account_id] }),
      ]);
      toast.show(declinedText(request.requested_by_label));
      onClose();
    } catch (e) {
      const field = e instanceof ApiError ? e.errors.find((x) => x.path === 'reason') : undefined;
      if (field) setReasonError(field.message);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Decline enrichment for ${request.account_name ?? 'this account'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Decline
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Why decline?" error={reasonError}>
          {(c) => (
            <textarea
              {...c}
              className="input"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(null);
              }}
            />
          )}
        </Field>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
