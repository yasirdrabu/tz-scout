import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { OWNER_WORD } from '../playbooks/api';
import { copyText, errorText, useRun } from '../settings/shared';
import { directoryQuery } from '../sources/api';
import { buyingRolesQuery, patchStep, type Plan, type PlanStep, type StepPatch, type StepStatus } from './api';
import styles from './Account.module.css';

const STATUS_WORD: Record<StepStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' };

/** "Nov 18" for a calendar date, whatever the timezone. */
const monthDay = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${day.slice(0, 10)}T00:00:00Z`));

const isDue = (s: PlanStep) => s.status === 'todo' && (s.overdue || s.due_today);

/** Ruling 3: the row's status pill. */
function StatusPill({ step }: { step: PlanStep }) {
  if (step.status === 'done') return <span className={cx(styles.planPill, styles.pillDone)}>Done</span>;
  if (step.status === 'skipped') return <span className={cx(styles.planPill, styles.pillIdle)}>Skipped</span>;
  if (step.status === 'in_progress') return <span className={cx(styles.planPill, styles.pillProgress)}>In progress</span>;
  if (isDue(step) && step.due_date) return <span className={cx(styles.planPill, styles.pillDue)}>{`Due ${monthDay(step.due_date)}`}</span>;
  return <span className={cx(styles.planPill, styles.pillIdle)}>Not started</span>;
}

type Props = { tenant: string; me: Me; plan: Plan; step: PlanStep; canWrite: boolean; onPlan: (p: Plan) => void; onFind: (roles: string[]) => void };

/** One plan row; the title opens the step in place. */
export function StepRow({ tenant, me, plan, step, canWrite, onPlan, onFind }: Props) {
  const [open, setOpen] = useState(false);
  const { run, busy } = useRun();
  const detailId = `step-${step.id}`;
  const toggle = () => void run(async () => onPlan(await patchStep(tenant, plan.id, step.id, { status: step.status === 'done' ? 'todo' : 'done' })), 'Step updated.');
  return (
    <li className={cx(styles.planRow, isDue(step) && styles.planRowDue, step.status === 'done' && styles.planRowDone)}>
      <span className={styles.planCheck}>
        {canWrite && (
          <input
            type="checkbox"
            checked={step.status === 'done'}
            disabled={busy}
            onChange={toggle}
            aria-label={step.status === 'done' ? `Mark ${step.title} not done` : `Mark ${step.title} done`}
          />
        )}
      </span>
      <span className={styles.muted}>{`Day ${step.day + 1}`}</span>
      <button type="button" className={styles.planTitle} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => setOpen((o) => !o)}>
        {step.title}
      </button>
      <span className={styles.muted}>{step.owner_name ?? OWNER_WORD[step.owner_role]}</span>
      <StatusPill step={step} />
      {open && (
        <div id={detailId} className={styles.planDetail}>
          <StepDetail key={[step.status, step.owner_user_id, step.due_date, step.note].join("|")} tenant={tenant} me={me} plan={plan} step={step} canWrite={canWrite} onPlan={onPlan} onFind={onFind} />
        </div>
      )}
    </li>
  );
}

function StepDetail({ tenant, me, plan, step, canWrite, onPlan, onFind }: Props) {
  const toast = useToast();
  const roles = useQuery(buyingRolesQuery(tenant));
  const directory = useQuery({ ...directoryQuery(tenant), enabled: canWrite });
  const [note, setNote] = useState(step.note ?? '');
  const [owner, setOwner] = useState(step.owner_user_id ?? '');
  const [due, setDue] = useState(step.due_date?.slice(0, 10) ?? '');
  const [status, setStatus] = useState<StepStatus>(step.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** Lowercase the label's first letter for mid-sentence use, unless it opens with an acronym (CIO). */
  const label = (key: string) => {
    const text = roles.data?.data.find((r) => r.key === key)?.label ?? key.replace(/_/g, ' ');
    return /^[A-Z]{2,}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
  };
  const find = hasScope(me, 'enrichment:request');
  const members = directory.data ?? [];
  const ownerKnown = !step.owner_user_id || members.some((m) => m.user_id === step.owner_user_id);

  const patch: StepPatch = {};
  if (note !== (step.note ?? '')) patch.note = note === '' ? null : note;
  if (owner !== (step.owner_user_id ?? '')) patch.owner_user_id = owner === '' ? null : owner;
  if (due !== '' && due !== (step.due_date?.slice(0, 10) ?? '')) patch.due_date = due;
  if (status !== step.status) patch.status = status;
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      onPlan(await patchStep(tenant, plan.id, step.id, patch));
      toast.show('Step updated.');
    } catch (e) {
      const fields = e instanceof ApiError ? e.errors : [];
      if (fields.length > 0) setFieldErrors(Object.fromEntries(fields.map((x) => [x.path, x.message])));
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    const text = `Subject: ${step.subject ?? ''}\n\n${step.body ?? ''}`;
    toast.show((await copyText(text)) ? 'Draft copied.' : "Couldn't copy. Select the text and copy it instead.");
  }

  return (
    <div className={styles.form}>
      {step.detail && <p className={styles.text}>{step.detail}</p>}
      {step.channel === 'email' && (step.subject || step.body) && (
        <div className={styles.draft}>
          <div className={styles.briefHead}>
            <strong>{step.subject}</strong>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              Copy
            </Button>
          </div>
          {step.body && <p className={styles.draftBody}>{step.body}</p>}
        </div>
      )}
      {(step.people.length > 0 || step.missing_roles.length > 0) && (
        <ul className={styles.planPeople}>
          {step.people.length > 0 && <li>{`To: ${step.people.map((p) => p.name).join(', ')}`}</li>}
          {step.missing_roles.map((key) => (
            <li key={key}>
              <span>{`No ${label(key)} on file`}</span>
              {find && (
                <button type="button" className={styles.textButton} aria-label={`Find ${label(key)}`} onClick={() => onFind([key])}>
                  Find
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save();
          }}
        >
          <Field label="Note" error={fieldErrors.note ?? null}>
            {(c) => <textarea {...c} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className={styles.planFields}>
            <Field label="Owner" error={fieldErrors.owner_user_id ?? null}>
              {(c) => (
                <select {...c} className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">No one</option>
                  {!ownerKnown && <option value={step.owner_user_id!}>{step.owner_name ?? 'Someone'}</option>}
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Due date" error={fieldErrors.due_date ?? null}>
              {(c) => <input {...c} type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />}
            </Field>
            <Field label="Status" error={fieldErrors.status ?? null}>
              {(c) => (
                <select {...c} className="input" value={status} onChange={(e) => setStatus(e.target.value as StepStatus)}>
                  {(Object.keys(STATUS_WORD) as StepStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_WORD[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button size="sm" type="submit" disabled={!dirty || busy}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className={cx(styles.muted, styles.small)}>
          {[step.note && `Note: ${step.note}`, step.due_date && `Due ${monthDay(step.due_date)}`, `Status: ${STATUS_WORD[step.status]}`].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
