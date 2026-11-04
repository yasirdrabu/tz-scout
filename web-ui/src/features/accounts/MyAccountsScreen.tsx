import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { countsQuery, hasScope, meQuery } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { useHeldRows } from '../../lib/useHeldRows';
import page from '../../routes/Page.module.css';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import table from '../../ui/Table.module.css';
import { useToast } from '../../ui/Toast';
import { reasonsFor, reasonsQuery } from '../review/api';
import { HandoffChip } from '../review/parts';
import { ReasonPicker, reasonReady } from '../review/ReasonPicker';
import review from '../review/Review.module.css';
import { errorText, LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { DueWords } from './NextStep';
import { acceptAssignment, activityText, declineAssignment, markSeen, myAssignmentsQuery, type Assignment } from './api';
import styles from './Accounts.module.css';

const route = getRouteApi('/t/$tenant/my');

const ACCEPTED_AUTOMATICALLY = new Set(['auto_timeout', 'crm_activity']);

/** §7 My accounts: new assignments to accept or decline, and the accounts the AE works. Refreshes every 30 s behind the updates bar (C14). */
export function MyAccountsScreen() {
  const { tenant } = route.useParams();
  const f = useFormat();
  const queryClient = useQueryClient();
  const counts = useQuery(countsQuery(tenant));
  const me = useQuery(meQuery(tenant));
  const showSteps = !!me.data && hasScope(me.data, 'playbooks:read');
  const pendingQ = useInfiniteQuery(myAssignmentsQuery(tenant, 'pending'));
  const activeQ = useInfiniteQuery(myAssignmentsQuery(tenant, 'accepted'));
  const pendingLatest = useMemo(() => pendingQ.data?.pages.flatMap((p) => p.data), [pendingQ.data]);
  const activeLatest = useMemo(() => activeQ.data?.pages.flatMap((p) => p.data), [activeQ.data]);
  const idOf = (a: Assignment) => a.id;
  const pending = useHeldRows(pendingLatest, 'pending', idOf);
  const active = useHeldRows(activeLatest, 'accepted', idOf);
  const updates = pending.updates + active.updates;

  const later = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['my-assignments', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['me-counts', tenant] }),
    ]);
  }

  async function refresh() {
    pending.follow();
    active.follow();
    await invalidate();
  }

  /** The plan is created after the accept returns, so refresh again shortly to pick up the first next step. */
  async function refreshAfterAccept() {
    await refresh();
    clearTimeout(later.current);
    later.current = setTimeout(() => void invalidate(), 2000);
  }

  const n = counts.data?.new_assignments;
  const due = counts.data?.next_steps_due_today ?? null;
  const late = counts.data?.next_steps_overdue ?? null;
  const newText = n === 1 ? '1 new assignment to accept.' : `${f.number(n ?? 0)} new assignments to accept.`;
  // Next-step counts are null without playbooks:read. With them, clauses that are zero are dropped.
  const stepText = [due ? (due === 1 ? '1 next step due today' : `${f.number(due)} next steps due today`) : null, late ? `${f.number(late)} overdue` : null].filter(Boolean).join(', ');
  const subtitle =
    n === null || n === undefined
      ? 'Your assignments and the accounts you work.'
      : [n > 0 || !stepText ? newText : null, stepText ? `${stepText}.` : null].filter(Boolean).join(' ');
  const failed = pendingQ.isError ? pendingQ : activeQ.isError ? activeQ : null;

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>My accounts</h1>
        <p className={page.sub}>{subtitle}</p>
      </div>
      {updates > 0 && (
        <div className={review.updates} role="status">
          <span className={review.grow}>{updates === 1 ? '1 update' : `${updates} updates`}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              pending.apply();
              active.apply();
            }}
          >
            Show
          </Button>
        </div>
      )}
      {failed && !pendingLatest ? (
        <LoadFailed title="My accounts didn't load" error={failed.error} onRetry={() => void failed.refetch()} />
      ) : pendingQ.isPending || activeQ.isPending ? (
        <LoadingRows>Loading your accounts</LoadingRows>
      ) : pending.rows.length === 0 && active.rows.length === 0 ? (
        <EmptyState title="No accounts assigned to you yet">When a leader assigns one, it shows here for you to accept.</EmptyState>
      ) : (
        <>
          {pending.rows.length > 0 && <NewAssignments tenant={tenant} rows={pending.rows} count={n ?? null} onChanged={refresh} onAccepted={refreshAfterAccept} />}
          <Active tenant={tenant} rows={active.rows} showSteps={showSteps} />
        </>
      )}
    </div>
  );
}

function NewAssignments({ tenant, rows, count, onChanged, onAccepted }: { tenant: string; rows: Assignment[]; count: number | null; onChanged: () => Promise<void>; onAccepted: () => Promise<void> }) {
  const assigners = [...new Set(rows.map((r) => r.assigned_by_name ?? ''))];
  const assigner = assigners.length === 1 && assigners[0] ? assigners[0] : 'the person who assigned it';
  return (
    <section className={styles.section} aria-labelledby="new-assignments">
      <div className={styles.sectionHead}>
        <h2 id="new-assignments" className={styles.sectionTitle}>
          New assignments
        </h2>
        {count !== null && count > 0 && <Badge count={count} label="new assignments" />}
      </div>
      <p className={styles.note}>{rows.some((r) => r.playbook_name) ? `Accept to start the playbook. Declining returns the account to ${assigner}.` : `Accept to take it on. Declining returns the account to ${assigner}.`}</p>
      <ul className={styles.list}>
        {rows.map((a) => (
          <NewRow key={a.id} tenant={tenant} a={a} onChanged={onChanged} onAccepted={onAccepted} />
        ))}
      </ul>
    </section>
  );
}

function AccountLink({ tenant, id, name, seen }: { tenant: string; id: string; name: string; seen?: boolean }) {
  return (
    <Link
      to="/t/$tenant/accounts/$id"
      params={{ tenant, id }}
      search={{ from: 'my' }}
      className={styles.accountLink}
      onClick={(e) => {
        e.stopPropagation();
        // Opening it marks it seen ("New from {source}" clears); a failure here changes nothing on screen.
        if (seen) void markSeen(tenant, id).catch(() => undefined);
      }}
    >
      {name}
    </Link>
  );
}

function NewRow({ tenant, a, onChanged, onAccepted }: { tenant: string; a: Assignment; onChanged: () => Promise<void>; onAccepted: () => Promise<void> }) {
  const f = useFormat();
  const { run, busy } = useRun();
  const [declining, setDeclining] = useState(false);
  const name = a.account_name ?? 'This account';
  const by = a.assigned_by_name ?? 'your leader';
  return (
    <li className={styles.item}>
      <div className={styles.itemRow}>
        <div className={styles.grow}>
          <AccountLink tenant={tenant} id={a.account_id} name={name} seen />
          {a.offer_name && <div className={styles.sub}>{a.playbook_name ? `${a.offer_name} · ${a.playbook_name} playbook` : a.offer_name}</div>}
          <div className={styles.sub}>{`Assigned by ${by} · ${f.relative(a.assigned_at)}`}</div>
          {a.notes && <blockquote className={styles.quote}>{`"${a.notes}"`}</blockquote>}
          {a.handoff && a.handoff.state !== 'in_crm' && (
            <div className={styles.chips}>
              <HandoffChip state={a.handoff.state} />
            </div>
          )}
        </div>
        {!declining && (
          <div className={styles.actions}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDeclining(true)} aria-label={`Decline ${name}`}>
              Decline
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label={`Accept ${name}`}
              onClick={() =>
                void run(async () => {
                  await acceptAssignment(tenant, a.id);
                  await onAccepted();
                }, a.playbook_name ? `Accepted. ${a.playbook_name} starts today.` : `Accepted. ${name} is in your accounts.`)
              }
            >
              Accept
            </Button>
          </div>
        )}
      </div>
      {declining && <DeclinePanel tenant={tenant} a={a} name={name} by={by} onCancel={() => setDeclining(false)} onChanged={onChanged} />}
    </li>
  );
}

function DeclinePanel({ tenant, a, name, by, onCancel, onChanged }: { tenant: string; a: Assignment; name: string; by: string; onCancel: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const reasons = useQuery(reasonsQuery(tenant));
  const list = reasonsFor(reasons.data?.data ?? [], 'assignment');
  const [reasonKey, setReasonKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reasonKey) return;
    setBusy(true);
    setError(null);
    try {
      await declineAssignment(tenant, a.id, { reason_key: reasonKey, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.show(`Declined. ${name} is back with ${by}, with your reason.`);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-label={`Decline ${name}`}>
      <h3 className={styles.panelTitle}>Why are you declining?</h3>
      {reasons.isError ? (
        <p role="alert" className={review.error}>
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
          noteLabel={`Anything ${by} should know before reassigning`}
          noteRequiredHint="This reason needs a note."
        />
      )}
      {error && (
        <p role="alert" className={review.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="dark" onClick={() => void submit()} disabled={busy || !reasonReady(list, reasonKey, note)}>
          {`Decline and return to ${by}`}
        </Button>
      </div>
    </section>
  );
}

function Active({ tenant, rows, showSteps }: { tenant: string; rows: Assignment[]; showSteps: boolean }) {
  const f = useFormat();
  const navigate = useNavigate();
  return (
    <section className={styles.section} aria-labelledby="active">
      <h2 id="active" className={styles.sectionTitle}>
        Active
      </h2>
      {rows.length === 0 ? (
        <p className={styles.note}>Nothing active yet. Accounts you accept show here.</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Stage</th>
                <th scope="col">Last HubSpot activity</th>
                {showSteps && (
                  <>
                    <th scope="col">Next step</th>
                    <th scope="col">Due</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={styles.clickable} onClick={() => void navigate({ to: '/t/$tenant/accounts/$id', params: { tenant, id: a.account_id }, search: { from: 'my' } })}>
                  <td>
                    <AccountLink tenant={tenant} id={a.account_id} name={a.account_name ?? 'This account'} />
                    {a.offer_name && <div className={styles.sub}>{a.offer_name}</div>}
                    {a.accepted_how && ACCEPTED_AUTOMATICALLY.has(a.accepted_how) && <div className={styles.sub}>Accepted automatically</div>}
                  </td>
                  <td>{a.stage_label && <span className={styles.stage}>{a.stage_label}</span>}</td>
                  <td className={cx(!a.last_activity && table.muted)}>
                    {a.last_activity ? (
                      <>
                        <div>{activityText(a.last_activity)}</div>
                        <div className={styles.sub}>{f.relative(a.last_activity.at)}</div>
                      </>
                    ) : (
                      'No activity yet'
                    )}
                  </td>
                  {showSteps && (
                    <>
                      <td className={cx(!a.next_step && table.muted)}>{a.next_step ? a.next_step.title : 'No next step'}</td>
                      <td>{a.next_step && <DueWords step={a.next_step} />}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
