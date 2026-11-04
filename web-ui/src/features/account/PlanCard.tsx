import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Menu, MenuItem } from '../../ui/Menu';
import { useToast } from '../../ui/Toast';
import type { CurrentAssignment } from '../review/api';
import { errorText, useRun } from '../settings/shared';
import { EditPlanDrawer } from './EditPlanDrawer';
import { planAction, planQuery, type Plan, type PlanActionName } from './api';
import styles from './Account.module.css';
import { StepRow } from './PlanStep';

// Ruling 7: what each history entry says.
const WHAT: Record<string, string> = {
  created: 'created the plan',
  paused: 'paused the plan',
  resumed: 'resumed the plan',
  completed: 'completed the plan',
  abandoned: 'abandoned the plan',
  stopped: 'stopped the plan',
  step_status: "changed a step's status",
  note: 'wrote a note',
  owner: 'changed the owner',
  due_date: 'changed the due date',
  step_added: 'added a step',
  step_edited: 'edited a step',
  step_removed: 'removed a step',
};

const DONE: Record<PlanActionName, string> = { pause: 'Plan paused.', resume: 'Plan resumed.', complete: 'Plan completed.', abandon: 'Plan abandoned.' };

/** Ruling 12: assigned, not accepted yet, so there is no plan to show. */
export function PendingPlan({ assignment }: { assignment: CurrentAssignment }) {
  const ae = assignment.seller_name?.split(' ')[0] ?? 'The AE';
  const text = assignment.playbook_name
    ? `${assignment.playbook_name} starts when ${ae} accepts.`
    : assignment.no_playbook
      ? `No playbook. ${ae} works it with no set steps.`
      : null;
  if (!text) return null;
  return (
    <Card title="Playbook">
      <p className={styles.note}>{text}</p>
    </Card>
  );
}

function AbandonDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Abandon this plan?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Abandon plan
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Why are you abandoning it?" error={error}>
          {(c) => <textarea {...c} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function History({ plan }: { plan: Plan }) {
  const f = useFormat();
  const [open, setOpen] = useState(false);
  if (plan.history.length === 0) return null;
  const rows = [...plan.history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <div>
      <button type="button" className={styles.textButton} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {`History (${plan.history.length})`}
      </button>
      {open && (
        <ul className={styles.rows}>
          {rows.map((h) => (
            <li key={h.id}>
              <span>{`${h.by_name ?? 'Scout'} ${WHAT[h.kind] ?? h.kind} · ${f.dateTime(h.at)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The plan's close, in a line (Ruling 5). */
function closedLine(plan: Plan, date: (when: string) => string): string | null {
  if (plan.status === 'completed') {
    const at = plan.history.find((h) => h.kind === 'completed')?.at;
    return at ? `Completed ${date(at)}` : 'Completed';
  }
  if (plan.status === 'stopped') return plan.status_reason ? `Stopped: ${plan.status_reason}` : 'Stopped';
  if (plan.status === 'abandoned') return plan.status_reason ? `Abandoned: ${plan.status_reason}` : 'Abandoned';
  return null;
}

/** §4b 2: the account's plan; with `playbooks:write` the checkboxes, step edits and the actions menu. No plan, no card. */
export function PlanCard({ tenant, me, accountId, onFind }: { tenant: string; me: Me; accountId: string; onFind: (roles: string[]) => void }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const toast = useToast();
  const [abandoning, setAbandoning] = useState(false);
  const [editing, setEditing] = useState(false);
  const plan = useQuery({ ...planQuery(tenant, accountId), enabled: hasScope(me, 'playbooks:read') });

  if (!hasScope(me, 'playbooks:read')) return null;
  if (plan.isPending) {
    return (
      <Card title="Playbook">
        <p className={styles.note}>Loading the plan</p>
      </Card>
    );
  }
  if (plan.isError) {
    if (plan.error instanceof ApiError && plan.error.status === 404) return null;
    return (
      <Card title="Playbook">
        <p className={styles.error} role="alert">{`The plan didn't load. ${errorText(plan.error)}`}</p>
      </Card>
    );
  }

  const p = plan.data;
  const setPlan = (next: Plan) => queryClient.setQueryData(planQuery(tenant, accountId).queryKey, next);
  const open = p.status === 'active' || p.status === 'paused';
  const canWrite = open && hasScope(me, 'playbooks:write');
  const steps = [...p.steps].sort((a, b) => a.order - b.order);
  const total = p.days + 1;
  const day = Math.min(p.day + 1, total);
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const closed = closedLine(p, f.date);
  const act = (action: PlanActionName) => void run(async () => setPlan(await planAction(tenant, p.id, action)), DONE[action]);

  return (
    <Card
      title="Playbook"
      actions={
        <span className={styles.planHead}>
          <span className={cx(styles.muted, styles.small)}>{`${p.playbook.name} · Day ${day} of ${total}`}</span>
          {canWrite && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit plan
            </Button>
          )}
          {canWrite && (
            <Menu
              align="end"
              width={200}
              trigger={
                <Button size="sm" variant="secondary" disabled={busy}>
                  Plan actions
                </Button>
              }
            >
              <MenuItem onSelect={() => act(p.status === 'paused' ? 'resume' : 'pause')}>{p.status === 'paused' ? 'Resume' : 'Pause'}</MenuItem>
              <MenuItem onSelect={() => act('complete')}>Complete</MenuItem>
              <MenuItem onSelect={() => setAbandoning(true)}>Abandon</MenuItem>
            </Menu>
          )}
        </span>
      }
    >
      <div className={styles.section}>
        <div className={styles.planProgress}>
          <div
            className={styles.planBar}
            role="progressbar"
            aria-label="Plan progress"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={done}
          >
            <div className={styles.fill} style={{ width: steps.length ? `${(done / steps.length) * 100}%` : 0 }} />
          </div>
          <span className={cx(styles.muted, styles.small)}>{`${done} of ${steps.length} done`}</span>
        </div>
        {closed && <p className={styles.note}>{closed}</p>}
        {p.newer_version && <p className={styles.note}>{`A newer version of ${p.playbook.name} exists. This plan keeps the steps it started with.`}</p>}
        <ul className={styles.planRows}>
          {steps.map((s) => (
            <StepRow key={s.id} tenant={tenant} me={me} plan={p} step={s} canWrite={canWrite} onPlan={setPlan} onFind={onFind} />
          ))}
        </ul>
        <History plan={p} />
      </div>
      {canWrite && <EditPlanDrawer tenant={tenant} plan={p} open={editing} onClose={() => setEditing(false)} onPlan={setPlan} />}
      {abandoning && (
        <AbandonDialog
          onClose={() => setAbandoning(false)}
          onSubmit={async (reason) => {
            setPlan(await planAction(tenant, p.id, 'abandon', reason));
            setAbandoning(false);
            toast.show(DONE.abandon);
          }}
        />
      )}
    </Card>
  );
}
