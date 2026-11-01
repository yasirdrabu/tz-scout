import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { hasScope, meQuery } from '../../../api/me';
import page from '../../../routes/Page.module.css';
import { Tabs } from '../../../ui/Tabs';
import { useToast } from '../../../ui/Toast';
import { errorText, LoadFailed, LoadingRows } from '../../settings/shared';
import { discardImport, importQuery, uploadImport, type MappingColumn, type UploadAnswer } from '../api';
import styles from '../Batches.module.css';
import { ConfirmStep } from './ConfirmStep';
import { MatchStep } from './MatchStep';
import { ResolveStep } from './ResolveStep';
import { SheetStep } from './SheetStep';
import { uploadError, UploadStep, type UploadChoice } from './UploadStep';

const route = getRouteApi('/t/$tenant/batches/import');

export type ImportStep = 'upload' | 'sheet' | 'match' | 'confirm' | 'resolve';
const STEPS: { id: ImportStep; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'match', label: 'Match columns' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'resolve', label: 'Resolve' },
];

/**
 * §15 Import a list: Upload (and Sheet for a workbook with several sheets), Match columns, Confirm and Resolve. The URL
 * carries the step, the import and the source to credit (C10). A layout Scout knows goes straight to Resolve.
 */
export function ImportScreen() {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const go = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery(meQuery(tenant));
  const step: ImportStep = (['upload', 'sheet', 'match', 'confirm', 'resolve'] as const).find((s) => s === search.step) ?? 'upload';
  const importId = search.import;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ choice: UploadChoice; sheets: string[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, MappingColumn[]>>({});
  const needsImport = step === 'match' || step === 'confirm';
  const view = useQuery({ ...importQuery(tenant, importId ?? ''), enabled: needsImport && !!importId });

  const to = (next: ImportStep, extra: { import?: string | undefined } = {}) =>
    void navigate({ search: (prev) => ({ ...prev, step: next === 'upload' ? undefined : next, ...extra }) });

  function landed(answer: UploadAnswer, choice: UploadChoice) {
    if (answer.status === 'needs_sheet') {
      setPending({ choice, sheets: answer.sheets });
      to('sheet');
    } else {
      setPending(null);
      to(answer.status === 'queued' ? 'resolve' : 'match', { import: answer.import_id });
    }
  }

  async function upload(choice: UploadChoice, sheet?: string) {
    setBusy(true);
    setError(null);
    try {
      landed(await uploadImport(tenant, { ...choice, ...(sheet ? { sheet } : {}) }), choice);
    } catch (e) {
      setError(uploadError(e));
      if (step !== 'upload') to('upload');
    } finally {
      setBusy(false);
    }
  }

  async function differentFile() {
    if (!importId) return to('upload');
    setBusy(true);
    try {
      await discardImport(tenant, importId);
      void qc.removeQueries({ queryKey: ['imports', tenant, importId] });
      to('upload', { import: undefined });
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = step === 'sheet' ? 'upload' : step;
  const mapping = importId ? (edits[importId] ?? view.data?.mapping ?? []) : [];
  const canPick = !!me && hasScope(me, 'sources:manage');

  let body;
  if (step === 'upload' || (step === 'sheet' && !pending)) {
    body = (
      <UploadStep
        tenant={tenant}
        canPick={canPick}
        ownSourceId={me?.source_id ?? null}
        {...(search.source ? { preselected: search.source } : {})}
        busy={busy}
        error={error}
        onUpload={(c) => void upload(c)}
      />
    );
  } else if (step === 'sheet' && pending) {
    body = <SheetStep sheets={pending.sheets} busy={busy} onPick={(s) => void upload(pending.choice, s)} />;
  } else if (step === 'resolve' && importId) {
    body = <ResolveStep tenant={tenant} importId={importId} canReview={!!me && hasScope(me, 'review:act')} />;
  } else if (!importId) {
    body = <LoadFailed title="This import was not found" error={null} onRetry={() => to('upload', { import: undefined })} />;
  } else if (view.isPending) {
    body = <LoadingRows>Loading the import</LoadingRows>;
  } else if (view.isError) {
    body = <LoadFailed title="The import didn't load" error={view.error} onRetry={() => void view.refetch()} />;
  } else if (step === 'match') {
    body = (
      <MatchStep
        view={view.data}
        mapping={mapping}
        onChange={(m) => setEdits((prev) => ({ ...prev, [importId]: m }))}
        busy={busy}
        onDifferentFile={() => void differentFile()}
        onContinue={() => to('confirm')}
      />
    );
  } else {
    body = <ConfirmStep tenant={tenant} importId={importId} mapping={mapping} onBack={() => to('match')} onStarted={() => to('resolve')} />;
  }

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Batches and imports</h1>
        <p className={page.sub}>Every delivery from a source or a list you bring in. Scout matches each account, scores it and sends it to review.</p>
      </div>
      <Tabs
        label="Batches and imports"
        tabs={[
          { id: 'batches', label: 'Batches' },
          { id: 'import', label: 'Import a list' },
        ]}
        value="import"
        onChange={(id) => id === 'batches' && void go({ to: '/t/$tenant/batches', params: { tenant } })}
      />
      <ol className={styles.stepper} aria-label="Import steps">
        {STEPS.map((s) => (
          <li key={s.id} {...(s.id === shown ? { 'aria-current': 'step' as const } : {})}>
            {s.label}
          </li>
        ))}
      </ol>
      {body}
    </div>
  );
}
