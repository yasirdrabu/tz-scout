import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ApiError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { errorText } from '../../settings/shared';
import { sourcesQuery } from '../../sources/api';
import styles from '../Batches.module.css';

export type UploadChoice = { file: File; sourceId?: string; notes?: string };

type Props = {
  tenant: string;
  /** People with sources:manage pick the source (Decision 12); everyone else is credited to their own. */
  canPick: boolean;
  ownSourceId: string | null;
  preselected?: string;
  busy: boolean;
  error: string | null;
  onUpload: (choice: UploadChoice) => void;
};

/** The words for an upload that failed: the API's title, or the 413 copy for a file over 20 MB. */
export function uploadError(e: unknown): string {
  if (e instanceof ApiError && e.status === 413) return 'This file is over 20 MB. Split it and import the parts.';
  return errorText(e);
}

/** §15 Upload: the dropzone, the source it credits and the batch notes. */
export function UploadStep({ tenant, canPick, ownSourceId, preselected, busy, error, onUpload }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [notes, setNotes] = useState('');
  const sources = useQuery({ ...sourcesQuery(tenant, { kind: 'person,partner,list' }), enabled: canPick || !!ownSourceId });
  const choices = (sources.data?.data ?? []).filter((s) => s.status === 'active' && ['person', 'partner', 'list'].includes(s.kind));
  const [sourceId, setSourceId] = useState(preselected ?? '');
  const picked = sourceId || (preselected ?? '') || ownSourceId || '';
  const own = (sources.data?.data ?? []).find((s) => s.id === ownSourceId);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    onUpload({ file, ...(canPick && picked ? { sourceId: picked } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) });
  };

  return (
    <form className={styles.panel} onSubmit={submit}>
      <div
        className={`${styles.drop} ${over ? styles.dropOn : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p className={styles.calloutTitle}>Drop a CSV, Excel or Markdown file here</p>
        <p className={styles.muted}>Or click to choose one. Up to 10,000 rows and 20 MB. One company per row.</p>
        <p className={styles.muted}>Each row needs a company name. A website helps Scout match the right company.</p>
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
          Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          aria-label="File to import"
          className="sr-only"
          accept=".csv,.tsv,.txt,.xlsx,.md,.markdown"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file && <p>{file.name}</p>}
      </div>

      {canPick ? (
        <Field label="Source">
          {(c) => (
            <select {...c} className="input" value={picked} onChange={(e) => setSourceId(e.target.value)}>
              {!picked && <option value="">Pick a source</option>}
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {`${s.name} (${s.kind_label})`}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <div>
          <p className={styles.calloutTitle}>Source</p>
          <p className={styles.muted}>{own ? own.name : 'Your own source'}</p>
        </div>
      )}

      <Field label="Batch notes">
        {(c) => <textarea {...c} className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <Button type="submit" disabled={!file || busy}>
          Upload
        </Button>
      </div>
    </form>
  );
}
