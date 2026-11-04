import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { buyingRolesQuery } from '../account/api';
import { errorText, LoadingRows } from '../settings/shared';
import {
  CHANNEL_WORD,
  createPlaybook,
  OWNER_WORD,
  patchPlaybook,
  playbookQuery,
  STATUS_WORD,
  STOP_WORD,
  type OwnerRole,
  type PlaybookBody,
  type PlaybookDetail,
  type PlaybookStatus,
  type StepChannel,
  type StopWhen,
} from './api';
import styles from './Playbooks.module.css';

const NAME_NEEDED = 'Give the playbook a name.';
const DAY_INVALID = 'Use a day from 0 to 365.';
const STEPS_NEEDED = 'Add at least one step.';

type StepValues = {
  /** Keeps a step's inputs with it when steps move. */
  key: number;
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

type Values = {
  name: string;
  status: PlaybookStatus;
  when_to_use: string;
  description: string;
  stop_when: StopWhen;
  steps: StepValues[];
};

let nextKey = 1;
const blankStep = (day: string): StepValues => ({
  key: nextKey++,
  day,
  channel: 'email',
  owner_role: 'seller',
  title: '',
  detail: '',
  subject: '',
  body: '',
  target_buying_roles: [],
  crm_task: true,
});

function valuesOf(p: PlaybookDetail | undefined): Values {
  return {
    name: p?.name ?? '',
    status: p?.status ?? 'draft',
    when_to_use: p?.when_to_use ?? '',
    description: p?.description ?? '',
    stop_when: p?.stop_when ?? 'reply_or_meeting',
    steps: (p?.steps ?? []).map((s) => ({
      key: nextKey++,
      day: String(s.day),
      channel: s.channel,
      owner_role: s.owner_role,
      title: s.title,
      detail: s.detail ?? '',
      subject: s.subject ?? '',
      body: s.body ?? '',
      target_buying_roles: s.target_buying_roles,
      crm_task: s.crm_task,
    })),
  };
}

const textOrNull = (s: string) => (s.trim() ? s.trim() : null);

/** The body for POST and PATCH. A step carries only the keys the strict API accepts (Ruling 9), `order` by position. */
function bodyOf(v: Values): PlaybookBody {
  return {
    name: v.name.trim(),
    status: v.status,
    description: textOrNull(v.description),
    when_to_use: textOrNull(v.when_to_use),
    stop_when: v.stop_when,
    steps: v.steps.map((s, i) => ({
      order: i + 1,
      day: Math.round(Number(s.day)) || 0,
      channel: s.channel,
      owner_role: s.owner_role,
      title: s.title.trim(),
      detail: textOrNull(s.detail),
      target_buying_roles: s.target_buying_roles,
      crm_task: s.crm_task,
      subject: s.channel === 'email' ? textOrNull(s.subject) : null,
      body: s.channel === 'email' ? textOrNull(s.body) : null,
    })),
  };
}

/** Whether the form draws a message for this API path, so an error nobody can see still reaches the notice. */
function shown(path: string, steps: StepValues[]): boolean {
  if (/^(name|status|when_to_use|description|stop_when|steps)$/.test(path)) return true;
  const m = /^steps\.(\d+)\.(\w+)$/.exec(path);
  const step = m ? steps[Number(m[1])] : undefined;
  if (!m || !step) return false;
  const f = m[2]!;
  return ['day', 'channel', 'owner_role', 'title', 'detail', 'target_buying_roles'].includes(f) || (step.channel === 'email' && (f === 'subject' || f === 'body'));
}

const withoutStepErrors = (e: Record<string, string>) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('steps')));

type Props = {
  tenant: string;
  open: boolean;
  /** `new` adds one; `edit` changes the playbook `id`. */
  mode: 'new' | 'edit';
  id: string | undefined;
  onClose: () => void;
};

/** §20 playbook form, in a drawer: create or edit a playbook and its steps. */
export function PlaybookForm({ tenant, open, mode, id, onClose }: Props) {
  const source = useQuery({ ...playbookQuery(tenant, id ?? ''), enabled: open && mode === 'edit' && !!id });
  const ready = mode === 'new' || source.data;
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={mode === 'new' ? 'New playbook' : `Edit ${source.data?.name ?? 'playbook'}`} width={640}>
      {!open ? null : ready ? (
        <Fields key={`${mode}:${id ?? ''}`} tenant={tenant} mode={mode} initial={mode === 'edit' ? source.data : undefined} onClose={onClose} />
      ) : source.isError ? (
        <p className={styles.formError}>{errorText(source.error)}</p>
      ) : (
        <LoadingRows>Loading the playbook</LoadingRows>
      )}
    </Drawer>
  );
}

function Fields({ tenant, mode, initial, onClose }: { tenant: string; mode: 'new' | 'edit'; initial: PlaybookDetail | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const rolesLoaded = useQuery(buyingRolesQuery(tenant)).data?.data;
  const roles = rolesLoaded ?? [];
  const [v, setV] = useState<Values>(() => valuesOf(initial));
  /** Messages by the API's field path ("name", "steps.2.title"). */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);
  /** Where focus goes once the steps have re-rendered. */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target) formRef.current?.querySelector<HTMLElement>(target)?.focus();
  }, [v.steps]);
  const clearError = (...keys: string[]) => setErrors((e) => (keys.some((k) => k in e) ? Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))) : e));
  const set = <K extends keyof Values>(k: K, value: Values[K]) => {
    setV((prev) => ({ ...prev, [k]: value }));
    clearError(k);
  };
  const setStep = (i: number, patch: Partial<StepValues>) => {
    set('steps', v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    clearError(...Object.keys(patch).map((k) => `steps.${i}.${k}`));
  };
  const addStep = () => {
    const added = blankStep(v.steps.at(-1)?.day ?? '0');
    refocus.current = `[data-step-key="${added.key}"] [data-focus="title"]`;
    set('steps', [...v.steps, added]);
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'steps')));
  };
  const removeStep = (i: number) => {
    const near = v.steps[i + 1] ?? v.steps[i - 1];
    refocus.current = near ? `[data-step-key="${near.key}"] [data-focus="remove"]` : '[data-focus="add"]';
    set('steps', v.steps.filter((_, j) => j !== i));
    setErrors(withoutStepErrors);
  };
  const moveStep = (i: number, by: -1 | 1) => {
    const at = i + by;
    const atEdge = by === -1 ? at === 0 : at === v.steps.length - 1;
    const keep = atEdge ? (by === -1 ? 'down' : 'up') : by === -1 ? 'up' : 'down';
    refocus.current = `[data-step-key="${v.steps[i]!.key}"] [data-focus="${keep}"]`;
    const next = [...v.steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    set('steps', next);
    setErrors(withoutStepErrors);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    const found: Record<string, string> = {};
    if (!v.name.trim()) found.name = NAME_NEEDED;
    if (!v.steps.length) found.steps = STEPS_NEEDED;
    v.steps.forEach((s, i) => {
      const day = Number(s.day);
      if (!s.day.trim() || !Number.isInteger(day) || day < 0 || day > 365) found[`steps.${i}.day`] = DAY_INVALID;
    });
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const saved = initial ? await patchPlaybook(tenant, initial.id, bodyOf(v)) : await createPlaybook(tenant, bodyOf(v));
      toast.show(initial ? `Changes to ${saved.name} saved.` : `${saved.name} created.`);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['playbooks', tenant] }), queryClient.invalidateQueries({ queryKey: ['offers', tenant] })]);
      if (mode === 'new') void navigate({ to: '/t/$tenant/playbooks/$id', params: { tenant, id: saved.id } });
      else onClose();
    } catch (err) {
      const mapped: Record<string, string> = {};
      let hidden = false;
      if (err instanceof ApiError) {
        for (const x of err.errors) {
          if (shown(x.path, v.steps)) mapped[x.path] ??= x.message;
          else hidden = true;
        }
      }
      setErrors(mapped);
      if (hidden || !Object.keys(mapped).length) setNotice(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (k: 'name' | 'when_to_use', label: string) => (
    <Field label={label} error={errors[k] ?? null}>
      {(c) => <input {...c} className="input" value={v[k]} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  );

  return (
    <form ref={formRef} className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      {notice && (
        <p role="alert" className={styles.formError}>
          {notice}
        </p>
      )}
      {text('name', 'Name')}
      <Field label="Status" error={errors.status ?? null}>
        {(c) => (
          <select {...c} className="input" value={v.status} onChange={(e) => set('status', e.target.value as PlaybookStatus)}>
            {(['active', 'draft', 'archived'] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_WORD[s]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {text('when_to_use', 'When to use it')}
      <Field label="Description" error={errors.description ?? null}>
        {(c) => <textarea {...c} className="input" rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} />}
      </Field>
      <Field label="Stop when" error={errors.stop_when ?? null}>
        {(c) => (
          <select {...c} className="input" value={v.stop_when} onChange={(e) => set('stop_when', e.target.value as StopWhen)}>
            {(Object.keys(STOP_WORD) as StopWhen[]).map((s) => (
              <option key={s} value={s}>
                {STOP_WORD[s]}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className={styles.group}>
        <h3 className={styles.legendTitle}>Steps</h3>
        <p className={styles.note}>Day counts from when the AE accepts the account.</p>
        {v.steps.map((s, i) => {
          const err = (f: string) => errors[`steps.${i}.${f}`] ?? null;
          return (
            <fieldset key={s.key} className={styles.stepBox} data-step-key={s.key}>
              <legend className={styles.legendTitle}>Step {i + 1}</legend>
              <div className={styles.row}>
                <Field label="Day" error={err('day')}>
                  {(c) => <input {...c} className="input" type="number" min={0} max={365} step={1} inputMode="numeric" value={s.day} onChange={(e) => setStep(i, { day: e.target.value })} />}
                </Field>
                <Field label="Channel" error={err('channel')}>
                  {(c) => (
                    <select {...c} className="input" value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value as StepChannel })}>
                      {(Object.keys(CHANNEL_WORD) as StepChannel[]).map((k) => (
                        <option key={k} value={k}>
                          {CHANNEL_WORD[k]}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Done by" error={err('owner_role')}>
                  {(c) => (
                    <select {...c} className="input" value={s.owner_role} onChange={(e) => setStep(i, { owner_role: e.target.value as OwnerRole })}>
                      {(Object.keys(OWNER_WORD) as OwnerRole[]).map((k) => (
                        <option key={k} value={k}>
                          {OWNER_WORD[k]}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <Field label="Title" error={err('title')}>
                {(c) => <input {...c} data-focus="title" className="input" value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} />}
              </Field>
              <Field label="Detail" error={err('detail')}>
                {(c) => <textarea {...c} className="input" rows={2} value={s.detail} onChange={(e) => setStep(i, { detail: e.target.value })} />}
              </Field>
              {s.channel === 'email' && (
                <>
                  <Field label="Subject" error={err('subject')}>
                    {(c) => <input {...c} className="input" value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />}
                  </Field>
                  <Field label="Body" error={err('body')}>
                    {(c) => <textarea {...c} className="input" rows={5} value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />}
                  </Field>
                </>
              )}
              {(roles.length > 0 || s.target_buying_roles.length > 0) && (
                <fieldset className={styles.radios}>
                  <legend className={styles.legendTitle}>Buying roles</legend>
                  {[...roles.map((r) => ({ key: r.key, label: r.label })), ...(rolesLoaded ? s.target_buying_roles.filter((k) => !roles.some((r) => r.key === k)) : []).map((k) => ({ key: k, label: `${k} (archived)` }))].map((r) => (
                    <label key={r.key} className={styles.radio}>
                      <input
                        type="checkbox"
                        checked={s.target_buying_roles.includes(r.key)}
                        onChange={(e) => setStep(i, { target_buying_roles: e.target.checked ? [...s.target_buying_roles, r.key] : s.target_buying_roles.filter((x) => x !== r.key) })}
                      />
                      <span>{r.label}</span>
                    </label>
                  ))}
                  {err('target_buying_roles') && <p className={styles.formError}>{err('target_buying_roles')}</p>}
                </fieldset>
              )}
              <label className={styles.radio}>
                <input type="checkbox" checked={s.crm_task} onChange={(e) => setStep(i, { crm_task: e.target.checked })} />
                <span>CRM task</span>
              </label>
              <div className={styles.actions}>
                <Button size="sm" variant="ghost" data-focus="up" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>
                  Move up
                </Button>
                <Button size="sm" variant="ghost" data-focus="down" onClick={() => moveStep(i, 1)} disabled={i === v.steps.length - 1} aria-label={`Move step ${i + 1} down`}>
                  Move down
                </Button>
                <Button size="sm" variant="ghost" data-focus="remove" onClick={() => removeStep(i)} aria-label={`Remove step ${i + 1}`}>
                  Remove
                </Button>
              </div>
            </fieldset>
          );
        })}
        {errors.steps && (
          <p role="alert" className={styles.formError}>
            {errors.steps}
          </p>
        )}
        <div>
          <Button variant="secondary" data-focus="add" onClick={addStep}>
            Add step
          </Button>
        </div>
      </div>

      <div className={styles.formFooter}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {mode === 'new' ? 'Create playbook' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
