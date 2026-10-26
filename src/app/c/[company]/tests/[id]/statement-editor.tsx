"use client";

// Draft statement editing: text, problem or outcome, a live word count, add and remove.

import { useMemo, useState } from "react";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { cx } from "@/components/ui";
import { addStatementAction, removeStatementAction, updateStatementAction } from "../actions";
import { KIND_LABEL, MAX_WORDS, wordCount, type KindKey } from "../labels";

type Row = { id: string; text: string; kind: KindKey; rewriteOf: string | null };

function Words({ text }: { text: string }) {
  const n = wordCount(text);
  return <span className={cx("tnum text-2xs", n > MAX_WORDS ? "font-medium text-bad" : "text-ink-muted")}>{n > MAX_WORDS ? `${n} words, cut to ${MAX_WORDS}` : `${n} of ${MAX_WORDS} words`}</span>;
}

function KindSelect({ value, onChange, disabled }: { value: KindKey; onChange: (k: KindKey) => void; disabled?: boolean }) {
  return (
    <select name="kind" value={value} onChange={(e) => onChange(e.target.value as KindKey)} className="input w-28 shrink-0" aria-label="Kind" disabled={disabled}>
      {(Object.keys(KIND_LABEL) as KindKey[]).map((k) => (
        <option key={k} value={k}>
          {KIND_LABEL[k]}
        </option>
      ))}
    </select>
  );
}

function StatementRow({ slug, row, index, canEdit }: { slug: string; row: Row; index: number; canEdit: boolean }) {
  const [text, setText] = useState(row.text);
  const [kind, setKind] = useState<KindKey>(row.kind);
  const save = useMemo(() => updateStatementAction.bind(null, slug, row.id), [slug, row.id]);
  const remove = useMemo(() => removeStatementAction.bind(null, slug, row.id), [slug, row.id]);
  const dirty = text.trim() !== row.text || kind !== row.kind;
  const over = wordCount(text) > MAX_WORDS;

  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <span className="tnum mt-2 w-5 shrink-0 text-right text-xs text-ink-faint">{index + 1}</span>
      <ActionForm action={save} className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <KindSelect value={kind} onChange={setKind} disabled={!canEdit} />
          <div className="min-w-0 flex-1">
            <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} rows={2} className={cx("input", over && "border-bad-line")} disabled={!canEdit} />
            <div className="mt-1 flex items-center gap-3">
              <Words text={text} />
              {row.rewriteOf && <span className="truncate text-2xs text-ink-faint" title={row.rewriteOf}>From an earlier batch: {row.rewriteOf}</span>}
            </div>
          </div>
          {canEdit && (
            <SubmitButton size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty || over} pendingText="Saving...">
              Save
            </SubmitButton>
          )}
        </div>
      </ActionForm>
      {canEdit && (
        <ActionButton action={remove} variant="ghost" size="sm" confirm="Remove this statement from the batch?">
          Remove
        </ActionButton>
      )}
    </li>
  );
}

function AddStatement({ slug, batchId }: { slug: string; batchId: string }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<KindKey>("PROBLEM");
  const add = useMemo(() => addStatementAction.bind(null, slug, batchId), [slug, batchId]);
  const over = wordCount(text) > MAX_WORDS;
  return (
    <ActionForm action={add} onDone={(r) => r.ok && setText("")} className="border-t border-line bg-sunken/40 px-4 py-3">
      <div className="flex items-start gap-2 pl-8">
        <KindSelect value={kind} onChange={setKind} />
        <div className="min-w-0 flex-1">
          <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} rows={2} className={cx("input", over && "border-bad-line")} placeholder="Write a new statement in the buyer's words" />
          <div className="mt-1">
            <Words text={text} />
          </div>
        </div>
        <SubmitButton size="sm" variant="secondary" disabled={!text.trim() || over} pendingText="Adding...">
          Add statement
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

export function StatementEditor({ slug, batchId, rows, canEdit }: { slug: string; batchId: string; rows: Row[]; canEdit: boolean }) {
  return (
    <>
      <ol>
        {rows.map((r, i) => (
          <StatementRow key={r.id} slug={slug} row={r} index={i} canEdit={canEdit} />
        ))}
        {rows.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">No statements yet. Add at least two.</li>}
      </ol>
      {canEdit && <AddStatement slug={slug} batchId={batchId} />}
    </>
  );
}
