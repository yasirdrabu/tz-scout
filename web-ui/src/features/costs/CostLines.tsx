import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { meQuery } from '../../api/me';
import { centsToInput, parseMoney } from '../../lib/money-input';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Dialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import table from '../../ui/Table.module.css';
import { LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { addLine, CATEGORIES, CATEGORY_WORD, costsKey, editLine, linesQuery, voidLine, type CostCategory, type CostLine } from './api';
import styles from './Costs.module.css';

type Props = { tenant: string; canWrite: boolean };
type Editing = { mode: 'add' } | { mode: 'edit'; line: CostLine } | { mode: 'void'; line: CostLine } | null;

const NEEDS_AMOUNT = 'Enter an amount above zero.';
const NEEDS_REASON = "Say why you're voiding this cost.";

/** Today as YYYY-MM-DD in the workspace's timezone. */
const today = (timeZone: string | undefined) => new Intl.DateTimeFormat('en-CA', { ...(timeZone ? { timeZone } : {}) }).format(new Date());

/** "Cost lines": every cost newest first, with Add cost, Edit and Void for `costs:write`. */
export function CostLines({ tenant, canWrite }: Props) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const [voided, setVoided] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const lines = useInfiniteQuery(linesQuery(tenant, voided));
  const rows = lines.data?.pages.flatMap((p) => p.data) ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: costsKey(tenant) });

  return (
    <Card
      title="Cost lines"
      actions={
        <div className={styles.actions}>
          <label className={styles.toggle}>
            <input type="checkbox" checked={voided} onChange={(e) => setVoided(e.target.checked)} />
            Show voided
          </label>
          {canWrite && (
            <Button size="sm" onClick={() => setEditing({ mode: 'add' })}>
              Add cost
            </Button>
          )}
        </div>
      }
    >
      {lines.isPending ? (
        <LoadingRows rows={3}>Loading cost lines</LoadingRows>
      ) : lines.isError ? (
        <LoadFailed title="Cost lines didn't load" error={lines.error} onRetry={() => void lines.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No costs yet">Paid calls and costs added by hand appear here.</EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Category</th>
                <th scope="col">Source</th>
                <th scope="col">Note</th>
                <th scope="col" className={table.num}>
                  Amount
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className={l.voided_at ? styles.voided : ''}>
                  <td>{f.day(l.occurred_on)}</td>
                  <td>{CATEGORY_WORD[l.category]}</td>
                  <td>{l.origin === 'manual' ? 'Added by hand' : l.provider ? l.provider.charAt(0).toUpperCase() + l.provider.slice(1) : 'Automatic'}</td>
                  <td>
                    {l.note ?? ''}
                    {l.voided_at && <div>{`Voided: ${l.void_reason ?? ''}`}</div>}
                  </td>
                  <td className={`${table.num} ${styles.struck ?? ''}`.trim()}>{f.moneyFixed(l.amount_cents)}</td>
                  <td className={table.actions}>
                    {canWrite && !l.voided_at && (
                      <>
                        {l.origin === 'manual' && (
                          <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'edit', line: l })}>
                            Edit
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'void', line: l })}>
                          Void
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lines.hasNextPage && (
        <Button size="sm" variant="secondary" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
          Show more
        </Button>
      )}
      {editing && (editing.mode === 'void' ? (
        <VoidDialog tenant={tenant} line={editing.line} onClose={() => setEditing(null)} onDone={refresh} />
      ) : (
        <LineDialog tenant={tenant} line={editing.mode === 'edit' ? editing.line : null} onClose={() => setEditing(null)} onDone={refresh} />
      ))}
    </Card>
  );
}

type DialogProps = { tenant: string; onClose: () => void; onDone: () => Promise<unknown> };

/** Add cost / Edit cost: date, category, amount and a note. */
function LineDialog({ tenant, line, onClose, onDone }: DialogProps & { line: CostLine | null }) {
  const me = useQuery(meQuery(tenant));
  const { currency } = useFormat();
  const { run, busy } = useRun();
  const [date, setDate] = useState(line?.occurred_on ?? today(me.data?.tenant?.timezone));
  const [category, setCategory] = useState<CostCategory>(line?.category ?? 'partner_fees');
  const [amount, setAmount] = useState(line ? centsToInput(line.amount_cents, currency) : '');
  const [note, setNote] = useState(line?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const parsed = parseMoney(amount, currency);
    if ('error' in parsed) return setError(parsed.error);
    const cents = parsed.cents;
    if (cents <= 0) return setError(NEEDS_AMOUNT);
    setError(null);
    const body = { occurred_on: date, category, amount_cents: cents, note: note.trim() || null };
    const ok = await run(async () => {
      if (line) await editLine(tenant, line.id, body);
      else await addLine(tenant, body);
      await onDone();
    }, line ? 'Cost saved.' : 'Cost added.');
    if (ok) onClose();
  }

  const title = line ? 'Edit cost' : 'Add cost';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {line ? 'Save cost' : 'Add cost'}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label="Date">{(c) => <input {...c} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Category">
          {(c) => (
            <select {...c} className="input" value={category} onChange={(e) => setCategory(e.target.value as CostCategory)}>
              {CATEGORIES.map((k) => (
                <option key={k} value={k}>
                  {CATEGORY_WORD[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Amount" error={error}>
          {(c) => <input {...c} inputMode="decimal" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Note">{(c) => <textarea {...c} className="input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

/** Void asks for the reason; the line stays in the list under Show voided. */
function VoidDialog({ tenant, line, onClose, onDone }: DialogProps & { line: CostLine }) {
  const { run, busy } = useRun();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) return setError(NEEDS_REASON);
    setError(null);
    const ok = await run(async () => {
      await voidLine(tenant, line.id, reason.trim());
      await onDone();
    }, 'Cost voided.');
    if (ok) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Void this cost?"
      description="It stops counting toward spend and budgets. It stays in the list under Show voided."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="dark" disabled={busy} onClick={() => void submit()}>
            Void cost
          </Button>
        </>
      }
    >
      <Field label="Reason" error={error}>
        {(c) => <input {...c} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
