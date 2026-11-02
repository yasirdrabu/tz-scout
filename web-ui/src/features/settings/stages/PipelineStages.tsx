import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ApiError, type FieldError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import type { TabProps } from '../SettingsScreen';
import { errorText, LoadFailed, LoadingRows } from '../shared';
import { afterSave, saveStages, settingsStagesQuery, type StagesView } from './api';
import { addRow, defaultsDraft, errorsByField, isDirty, moveRow, toDraft, toEdits, type Row } from './draft';
import styles from './PipelineStages.module.css';
import { StageTable } from './StageTable';

/** Settings > Pipeline stages (screens.md §21e): the stages and exits of the workspace, saved in one PUT. */
export function PipelineStages({ tenant }: TabProps) {
  const view = useQuery(settingsStagesQuery(tenant));
  if (view.isPending) return <LoadingRows>Loading pipeline stages</LoadingRows>;
  if (view.isError) return <LoadFailed title="Pipeline stages didn't load" error={view.error} onRetry={() => void view.refetch()} />;
  return <Editor tenant={tenant} loaded={view.data} />;
}

function Editor({ tenant, loaded }: { tenant: string; loaded: StagesView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState(loaded);
  const base = useMemo(() => toDraft(from.stages), [from]);
  const [draft, setDraft] = useState<Row[]>(base);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = isDirty(draft, base);
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });
  const byField = errorsByField(errors);

  const change = (index: number, patch: Partial<Row>) => setDraft((d) => d.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  function remove(index: number) {
    const row = draft[index]!;
    if (row.locked) toast.show(`The ${row.locked} stage can be renamed but not deleted.`);
    else setDraft((d) => d.filter((_, i) => i !== index));
  }

  function discard() {
    setDraft(base);
    setErrors([]);
    setFailure(null);
  }

  async function save() {
    setBusy(true);
    setErrors([]);
    setFailure(null);
    try {
      const saved = await saveStages(tenant, toEdits(draft));
      setFrom(saved);
      setDraft(toDraft(saved.stages));
      afterSave(qc, tenant, saved);
      toast.show('Pipeline stages saved. The pipeline and scorecard use them now.');
    } catch (e) {
      setFailure(errorText(e));
      if (e instanceof ApiError) setErrors(e.errors);
    } finally {
      setBusy(false);
    }
  }

  const tableProps = { all: draft, triggers: from.triggers, errors: byField.fields, disabled: busy, onChange: change, onMove: (i: number, by: -1 | 1) => setDraft((d) => moveRow(d, i, by)), onDelete: remove };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <p className={styles.intro}>
          The stages every account moves through, in order. They drive the pipeline, scorecard, filters and HubSpot sync. Renaming keeps history; deleting moves accounts back one stage.
        </p>
        <div className={styles.buttons}>
          <Button variant="ghost" onClick={() => setDraft(defaultsDraft(from))} disabled={busy}>
            Restore defaults
          </Button>
          <Button variant="secondary" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            Save stages
          </Button>
        </div>
      </div>

      {failure && (
        <div role="alert" className={styles.failure}>
          {byField.rest.length === 0 && <p>{failure}</p>}
          {byField.rest.map((e) => (
            <p key={`${e.path}:${e.message}`}>{e.message}</p>
          ))}
        </div>
      )}

      <StageTable
        {...tableProps}
        kind="flow"
        title="Stages"
        intro="In order. Accounts move down this list. New stages go just before the won stage."
        addLabel="Add stage"
        onAdd={() => setDraft((d) => addRow(d, 'flow'))}
      />
      <StageTable
        {...tableProps}
        kind="exit"
        title="Exits"
        intro="Ways an account leaves the pipeline. They show under the pipeline and count as closed."
        addLabel="Add exit"
        onAdd={() => setDraft((d) => addRow(d, 'exit'))}
      />

      <p className={styles.footer}>
        The first stage and the won stage can be renamed but not deleted. Quarter targets feed the pace markers on the pipeline. Changes apply from the moment you save; past movements keep the stage names they had.
      </p>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="Your changes to the pipeline stages are not saved."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
