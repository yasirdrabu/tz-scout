import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ApiError, type FieldError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import type { TabProps } from '../SettingsScreen';
import { errorText, LoadFailed, LoadingRows } from '../shared';
import { afterSave, restoreReviewDefaults, reviewSettingsQuery, saveReviewSettings, type ReasonList as List, type ReviewSettings } from './api';
import { changes, errorsByRow, inList, localId, toDraft, type Draft, type ReasonRow, type StatusRow } from './draft';
import { ReasonList } from './ReasonList';
import styles from './ReviewStatuses.module.css';
import { StatusTable } from './StatusTable';

const DAYS = Array.from({ length: 10 }, (_, i) => i + 1);

/** Settings > Review statuses (screens.md §21d): the statuses, the send-back and AE decline reasons and auto-accept, saved in one PUT. */
export function ReviewStatusesTab({ tenant }: TabProps) {
  const settings = useQuery(reviewSettingsQuery(tenant));
  if (settings.isPending) return <LoadingRows>Loading review statuses</LoadingRows>;
  if (settings.isError) return <LoadFailed title="Review statuses didn't load" error={settings.error} onRetry={() => void settings.refetch()} />;
  // A save or a restore brings new settings: the editor starts again from them.
  return <Editor key={settings.dataUpdatedAt} tenant={tenant} loaded={settings.data} />;
}

function Editor({ tenant, loaded }: { tenant: string; loaded: ReviewSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useMemo(() => toDraft(loaded), [loaded]);
  const [draft, setDraft] = useState<Draft>(base);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const edit = changes(draft, base);
  const dirty = Object.keys(edit).length > 0;
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });
  const byRow = errorsByRow(errors);
  const live = draft.statuses.filter((s) => !s.archived);
  const first = (live.find((s) => s.is_initial) ?? live[0])?.label.trim() ?? '';
  const savedFirst = base.statuses.find((s) => s.is_initial && !s.archived)?.label ?? first;

  const setStatus = (index: number, patch: Partial<StatusRow>) => setDraft((d) => ({ ...d, statuses: d.statuses.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  const setReason = (index: number, patch: Partial<ReasonRow>) => setDraft((d) => ({ ...d, reasons: d.reasons.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));

  function move(index: number, by: -1 | 1) {
    setDraft((d) => {
      const visible = d.statuses.map((s, i) => (s.archived ? -1 : i)).filter((i) => i >= 0);
      const other = visible[visible.indexOf(index) + by];
      if (other === undefined) return d;
      const statuses = [...d.statuses];
      [statuses[index], statuses[other]] = [statuses[other]!, statuses[index]!];
      return { ...d, statuses };
    });
  }

  function archiveStatus(index: number) {
    // A status that was never saved just goes.
    if (draft.statuses[index]!.key === null) setDraft((d) => ({ ...d, statuses: d.statuses.filter((_, i) => i !== index) }));
    else setArchiving(index);
  }

  function addStatus() {
    const row: StatusRow = {
      id: localId(),
      key: null,
      was: null,
      label: '',
      color: 'gray',
      description: '',
      set_by: 'reviewer',
      flag_after_hours: null,
      is_initial: false,
      is_final: false,
      required: false,
      archived: false,
      in_status_count: null,
      late_count: null,
    };
    setDraft((d) => {
      // New statuses go after the live ones, before the archived ones.
      const at = d.statuses.findIndex((s) => s.archived);
      const statuses = [...d.statuses];
      statuses.splice(at === -1 ? statuses.length : at, 0, row);
      return { ...d, statuses };
    });
  }

  function archiveReason(index: number) {
    if (draft.reasons[index]!.key === null) setDraft((d) => ({ ...d, reasons: d.reasons.filter((_, i) => i !== index) }));
    else setReason(index, { archived: true });
  }

  const addReason = (list: List) => (label: string) =>
    setDraft((d) => ({ ...d, reasons: [...d.reasons, { id: localId(), key: null, was: null, label, applies_to: list, note_required: false, archived: false, used_this_quarter: null }] }));

  async function act(action: () => Promise<ReviewSettings>, done?: string) {
    setBusy(true);
    setErrors([]);
    setFailure(null);
    try {
      afterSave(qc, tenant, await action());
      if (done) toast.show(done);
    } catch (e) {
      setFailure(errorText(e));
      if (e instanceof ApiError) setErrors(e.errors);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setDraft(base);
    setErrors([]);
    setFailure(null);
  }

  const reasonsIn = (list: List) => draft.reasons.map((row, index) => ({ row, index })).filter(({ row }) => inList(row, list));
  const archivingRow = archiving === null ? null : draft.statuses[archiving];

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <p className={styles.intro}>
          The steps an account goes through in the review queue, before it reaches a seller. Statuses set by Scout change on their own. Statuses set by a reviewer change when someone acts.
        </p>
        <div className={styles.buttons}>
          <Button variant="ghost" onClick={() => setRestoring(true)} disabled={busy}>
            Restore defaults
          </Button>
          <Button variant="secondary" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          <Button onClick={() => void act(() => saveReviewSettings(tenant, edit), 'Review statuses saved. The review queue now shows them.')} disabled={busy || !dirty}>
            Save statuses
          </Button>
        </div>
      </div>

      {failure && (
        <div role="alert" className={styles.failure}>
          <p>{failure}</p>
          {byRow.rest
            .filter((e) => e.path !== 'auto_accept_working_days' && e.message !== failure)
            .map((e) => (
              <p key={`${e.path}:${e.message}`}>{e.message}</p>
            ))}
        </div>
      )}

      <StatusTable rows={draft.statuses} colors={loaded.colors} errors={byRow.statuses} disabled={busy} onChange={setStatus} onMove={move} onArchive={archiveStatus} onAdd={addStatus} />

      <ReasonList
        title="Send-back reasons"
        intro="A reviewer picks one when sending an account back. Sources see the reason, and it feeds their trust score."
        keepOne="Keep at least one send-back reason."
        rows={reasonsIn('send_back')}
        errors={byRow.reasons}
        disabled={busy}
        onChange={setReason}
        onArchive={archiveReason}
        onAdd={addReason('send_back')}
      />

      <ReasonList
        title="Decline reasons for AEs"
        keepOne="Keep at least one decline reason for AEs."
        rows={reasonsIn('assignment')}
        errors={byRow.reasons}
        disabled={busy}
        onChange={setReason}
        onArchive={archiveReason}
        onAdd={addReason('assignment')}
      />

      <section className={styles.section} aria-label="Accept assignments automatically">
        <div className={styles.auto}>
          <label className={styles.switch}>
            <input type="checkbox" role="switch" checked={draft.autoAccept !== null} disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, autoAccept: e.target.checked ? 2 : null }))} />
            Accept assignments automatically after
          </label>
          <select
            className={`input ${styles.select}`}
            aria-label="Working days before an assignment is accepted"
            value={draft.autoAccept ?? ''}
            disabled={busy || draft.autoAccept === null}
            onChange={(e) => setDraft((d) => ({ ...d, autoAccept: Number(e.target.value) }))}
          >
            {draft.autoAccept === null && <option value="">Off</option>}
            {DAYS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>working days</span>
        </div>
        {byRow.rest
          .filter((e) => e.path === 'auto_accept_working_days')
          .map((e) => (
            <p key={e.message} className={styles.error}>
              {e.message}
            </p>
          ))}
      </section>

      <ConfirmDialog
        open={archivingRow != null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archivingRow?.label.trim() ?? ''}?`}
        description={`Its ${archivingRow?.in_status_count ?? 0} accounts move to ${first}.`}
        confirmLabel="Archive"
        onConfirm={() => {
          if (archiving !== null) setStatus(archiving, { archived: true });
          setArchiving(null);
        }}
      />
      <ConfirmDialog
        open={restoring}
        onOpenChange={setRestoring}
        title="Restore the default statuses and reasons?"
        description={`Statuses and reasons you added are archived and their accounts move to ${savedFirst}.`}
        confirmLabel="Restore defaults"
        busy={busy}
        onConfirm={() => {
          setRestoring(false);
          void act(() => restoreReviewDefaults(tenant));
        }}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="Your changes to the review statuses are not saved."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
