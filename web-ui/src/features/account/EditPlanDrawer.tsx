import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { CHANNEL_WORD, OWNER_WORD, type OwnerRole, type StepChannel } from '../playbooks/api';
import styles from '../playbooks/Playbooks.module.css';
import { errorText } from '../settings/shared';
import { addStep, buyingRolesQuery, patchStep, removeStep, type NewStep, type Plan, type PlanStep, type StepPatch, type StepStatus } from './api';

const DAY_INVALID = 'Use a day from 1 to 366.';
const TITLE_NEEDED = 'Give the step a title.';
const STATUS_WORD: Record<StepStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' };

type Values = {
  day: string;
  channel: StepChannel;
  owner_role: OwnerRole;
  title: string;
  detail: string;
  subject: string;
  body: string;
  target_buying_roles: string[];
  crm_task: boolean;
};

const BLANK: Values = { day: '1', channel: 'email', owner_role: 'seller', title: '', detail: '', subject: '', body: '', target_buying_roles: [], crm_task: true };

const valuesOf = (s: PlanStep): Values => ({
  day: String(s.day + 1),
  channel: s.channel,
  owner_role: s.owner_role,
  title: s.title,
  detail: s.detail ?? '',
  subject: s.subject ?? '',
  body: s.body ?? '',
  target_buying_roles: s.target_buying_roles,
  crm_task: s.crm_task,
});

const textOrNull = (s: string) => (s.trim() ? s.trim() : null);

/** The first problem with the values, by field, before anything is sent. */
function check(v: Values): Record<string, string> {
  const found: Record<string, string> = {};
  const day = Number(v.day);
  if (!v.title.trim()) found.title = TITLE_NEEDED;
  if (!v.day.trim() || !Number.isInteger(day) || day < 1 || day > 366) found.day = DAY_INVALID;
  return found;
}

/** Only what changed, so an edit that changes nothing sends nothing. */
function changes(step: PlanStep, v: Values): StepPatch {
  const patch: StepPatch = {};
  if (v.title.trim() !== step.title) patch.title = v.title.trim();
  if (textOrNull(v.detail) !== step.detail) patch.detail = textOrNull(v.detail);
  if (Number(v.day) - 1 !== step.day) patch.day = Number(v.day) - 1;
  if (v.channel !== step.channel) patch.channel = v.channel;
  if (v.channel === 'email') {
    if (textOrNull(v.subject) !== step.subject) patch.subject = textOrNull(v.subject);
    if (textOrNull(v.body) !== step.body) patch.body = textOrNull(v.body);
  }
  if (v.crm_task !== step.crm_task) patch.crm_task = v.crm_task;
  const a = [...v.target_buying_roles].sort().join();
  if (a !== [...step.target_buying_roles].sort().join()) patch.target_buying_roles = v.target_buying_roles;
  return patch;
}

const FIELDS = ['day', 'channel', 'owner_role', 'title', 'detail', 'subject', 'body', 'target_buying_roles'];

/** The step fields, as the playbook form has them; "Done by" only when adding (a step's owner is set from its row). */
function StepFields({ tenant, v, onChange, errors, showOwner }: { tenant: string; v: Values; onChange: (patch: Partial<Values>) => void; errors: Record<string, string>; showOwner: boolean }) {
  const rolesLoaded = useQuery(buyingRolesQuery(tenant)).data?.data;
  const roles = rolesLoaded ?? [];
  const options = [...roles.map((r) => ({ key: r.key, label: r.label })), ...(rolesLoaded ? v.target_buying_roles.filter((k) => !roles.some((r) => r.key === k)) : []).map((k) => ({ key: k, label: `${k} (archived)` }))];
  return (
    <>
      <div className={styles.row}>
        <Field label="Day" error={errors.day ?? null}>
          {(c) => <input {...c} className="input" type="number" min={1} max={366} step={1} inputMode="numeric" value={v.day} onChange={(e) => onChange({ day: e.target.value })} />}
        </Field>
        <Field label="Channel" error={errors.channel ?? null}>
          {(c) => (
            <select {...c} className="input" value={v.channel} onChange={(e) => onChange({ channel: e.target.value as StepChannel })}>
              {(Object.keys(CHANNEL_WORD) as StepChannel[]).map((k) => (
                <option key={k} value={k}>
                  {CHANNEL_WORD[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {showOwner && (
          <Field label="Done by" error={errors.owner_role ?? null}>
            {(c) => (
              <select {...c} className="input" value={v.owner_role} onChange={(e) => onChange({ owner_role: e.target.value as OwnerRole })}>
                {(Object.keys(OWNER_WORD) as OwnerRole[]).map((k) => (
                  <option key={k} value={k}>
                    {OWNER_WORD[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      <Field label="Title" error={errors.title ?? null}>
        {(c) => <input {...c} data-focus="title" className="input" value={v.title} onChange={(e) => onChange({ title: e.target.value })} />}
      </Field>
      <Field label="Detail" error={errors.detail ?? null}>
        {(c) => <textarea {...c} className="input" rows={2} value={v.detail} onChange={(e) => onChange({ detail: e.target.value })} />}
      </Field>
      {v.channel === 'email' && (
        <>
          <Field label="Subject" error={errors.subject ?? null}>
            {(c) => <input {...c} className="input" value={v.subject} onChange={(e) => onChange({ subject: e.target.value })} />}
          </Field>
          <Field label="Body" error={errors.body ?? null}>
            {(c) => <textarea {...c} className="input" rows={5} value={v.body} onChange={(e) => onChange({ body: e.target.value })} />}
          </Field>
        </>
      )}
      {options.length > 0 && (
        <fieldset className={styles.radios}>
          <legend className={styles.legendTitle}>Buying roles</legend>
          {options.map((r) => (
            <label key={r.key} className={styles.radio}>
              <input
                type="checkbox"
                checked={v.target_buying_roles.includes(r.key)}
                onChange={(e) => onChange({ target_buying_roles: e.target.checked ? [...v.target_buying_roles, r.key] : v.target_buying_roles.filter((x) => x !== r.key) })}
              />
              <span>{r.label}</span>
            </label>
          ))}
          {errors.target_buying_roles && <p className={styles.formError}>{errors.target_buying_roles}</p>}
        </fieldset>
      )}
      <label className={styles.radio}>
        <input type="checkbox" checked={v.crm_task} onChange={(e) => onChange({ crm_task: e.target.checked })} />
        <span>HubSpot task</span>
      </label>
    </>
  );
}

/** One step form's state: values, field errors from the API, and a save that maps them. */
function useStepForm<T>(initial: Values, send: (v: Values) => Promise<T>, done: (result: T, reset: () => void) => void) {
  const toast = useToast();
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const onChange = (patch: Partial<Values>) => {
    setV((prev) => ({ ...prev, ...patch }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !(k in patch))));
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = check(v);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      done(await send(v), () => setV(initial));
    } catch (err) {
      const mapped: Record<string, string> = {};
      if (err instanceof ApiError) for (const x of err.errors) if (FIELDS.includes(x.path)) mapped[x.path] ??= x.message;
      setErrors(mapped);
      if (!Object.keys(mapped).length) toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return { v, setV, onChange, errors, busy, submit };
}

function AddStep({ tenant, plan, onPlan, onAdded }: { tenant: string; plan: Plan; onPlan: (p: Plan) => void; onAdded: (p: Plan, before: Set<string>) => void }) {
  const toast = useToast();
  const form = useStepForm(
    { ...BLANK, day: String(Math.min(plan.day + 1, 366)) },
    (v) => {
      const body: NewStep = {
        day: Number(v.day) - 1,
        channel: v.channel,
        owner_role: v.owner_role,
        title: v.title.trim(),
        detail: textOrNull(v.detail),
        target_buying_roles: v.target_buying_roles,
        crm_task: v.crm_task,
        ...(v.channel === 'email' ? { subject: textOrNull(v.subject), body: textOrNull(v.body) } : {}),
      };
      return addStep(tenant, plan.id, body);
    },
    (next, reset) => {
      const before = new Set(plan.steps.map((s) => s.id));
      onPlan(next);
      toast.show('Step added.');
      reset();
      onAdded(next, before);
    },
  );
  return (
    <form aria-label="Add step" className={styles.stepBox} onSubmit={(e) => void form.submit(e)} noValidate>
      <h3 className={styles.legendTitle}>Add step</h3>
      <StepFields tenant={tenant} v={form.v} onChange={form.onChange} errors={form.errors} showOwner />
      <div className={styles.actions}>
        <Button type="submit" data-focus="add" disabled={form.busy}>
          Add step
        </Button>
      </div>
    </form>
  );
}

function EditStep({ tenant, plan, step, onPlan, onClose }: { tenant: string; plan: Plan; step: PlanStep; onPlan: (p: Plan) => void; onClose: () => void }) {
  const toast = useToast();
  const form = useStepForm(
    valuesOf(step),
    (v) => {
      const patch = changes(step, v);
      return Object.keys(patch).length ? patchStep(tenant, plan.id, step.id, patch) : Promise.resolve(null);
    },
    (next) => {
      if (next) {
        onPlan(next);
        toast.show('Step saved.');
      }
      onClose();
    },
  );
  return (
    <form aria-label={`Edit ${step.title}`} className={styles.form} onSubmit={(e) => void form.submit(e)} noValidate>
      <StepFields tenant={tenant} v={form.v} onChange={form.onChange} errors={form.errors} showOwner={false} />
      <div className={styles.actions}>
        <Button type="submit" disabled={form.busy}>
          Save step
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Props = { tenant: string; plan: Plan; open: boolean; onClose: () => void; onPlan: (plan: Plan) => void };

/** Ruling 13: change a plan's steps one request at a time; every answer replaces the plan on the card. */
export function EditPlanDrawer({ tenant, plan, open, onClose, onPlan }: Props) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const steps = [...plan.steps].sort((a, b) => a.order - b.order);
  /** Focus a control once the new plan has rendered. */
  const focusSoon = (selector: string) => setTimeout(() => bodyRef.current?.querySelector<HTMLElement>(selector)?.focus(), 0);

  async function remove(step: PlanStep, i: number) {
    setBusy(true);
    try {
      const next = await removeStep(tenant, plan.id, step.id);
      const near = steps[i + 1];
      onPlan(next);
      focusSoon(near ? `[data-step-id="${near.id}"] [data-focus="edit"]` : '[data-focus="add"]');
      toast.show('Step removed.');
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title="Edit plan" width={640}>
        <div ref={bodyRef} className={styles.group}>
          <p className={styles.note}>Changes here apply to this plan only. The playbook stays as it is.</p>
          <ul className={styles.group} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((s, i) => (
              <li key={s.id} data-step-id={s.id} tabIndex={-1} className={styles.stepBox}>
                <div>
                  <strong>{s.title}</strong>
                  <p className={styles.note}>{[`Day ${s.day + 1}`, CHANNEL_WORD[s.channel], s.owner_name ?? OWNER_WORD[s.owner_role], STATUS_WORD[s.status]].join(' · ')}</p>
                </div>
                {editing === s.id ? (
                  <EditStep
                    key={s.id}
                    tenant={tenant}
                    plan={plan}
                    step={s}
                    onPlan={onPlan}
                    onClose={() => {
                      setEditing(null);
                      focusSoon(`[data-step-id="${s.id}"] [data-focus="edit"]`);
                    }}
                  />
                ) : (
                  <div className={styles.actions}>
                    <Button size="sm" variant="secondary" data-focus="edit" aria-label={`Edit ${s.title}`} onClick={() => setEditing(s.id)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${s.title}`} disabled={busy || s.status === 'done'} onClick={() => void remove(s, i)}>
                      Remove
                    </Button>
                    {s.status === 'done' && <span className={styles.note}>Skip it instead.</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <AddStep
            tenant={tenant}
            plan={plan}
            onPlan={onPlan}
            onAdded={(next, before) => {
              const added = next.steps.find((s) => !before.has(s.id));
              if (added) focusSoon(`[data-step-id="${added.id}"]`);
            }}
          />
        </div>
    </Drawer>
  );
}
