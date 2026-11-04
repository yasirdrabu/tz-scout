import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { buyingRolesQuery } from '../account/api';
import { errorText, LoadingRows } from '../settings/shared';
import { approveOffer, createOffer, offerQuery, patchOffer, unapproveOffer, type Objection, type Offer, type OfferBody, type OfferStatus, type Practice, type PriceModel } from './api';
import { ChipsInput } from './ChipsInput';
import { SECTIONS } from './OfferView';
import styles from './Offers.module.css';

const PRICING: { value: PriceModel; label: string }[] = [
  { value: 'fixed', label: 'Fixed fee' },
  { value: 'starting_at', label: 'Starting at' },
  { value: 'per_month', label: 'Per month' },
  { value: 'custom', label: 'Custom quote' },
];

const BACK_TO_DRAFT = "This offer is back in Draft. Make it active again when you're ready.";
const TITLE_NEEDED = 'Give the offer a title.';

type Values = {
  name: string;
  practiceId: string;
  status: 'approved' | 'draft';
  priceModel: PriceModel | '';
  amount: string;
  /** The top of a price range; empty when the price is one amount. */
  amountMax: string;
  lengthWeeks: string;
  promise: string;
  description: string;
  key_offer: string;
  why_us: string;
  why_now: string;
  typicalDeal: string;
  salesCycleDays: string;
  targetTitles: string[];
  requiredRoles: string[];
  optionalRoles: string[];
  industries: string[];
  sizeMin: string;
  sizeMax: string;
  proofPoints: string;
  talkingPoints: string;
  /** One "objection | answer" per line. */
  objections: string;
  avoid: string;
};

const num = (n: number | null) => (n === null ? '' : String(n));
/** Minor units as a plain amount, cents kept ("25000.5"). */
const dollars = (cents: number | null) => (cents === null ? '' : String(cents / 100));

const flat = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ');

function valuesOf(o: Offer | undefined, practiceId: string, copy: boolean): Values {
  return {
    name: o ? (copy ? `${o.name} (copy)` : o.name) : '',
    practiceId: o?.practice_id ?? practiceId,
    status: o && !copy && o.status === 'approved' ? 'approved' : 'draft',
    priceModel: o?.price_model ?? '',
    amount: dollars(o?.price_min_cents ?? o?.price_max_cents ?? null),
    amountMax: o && o.price_min_cents !== null && o.price_max_cents !== null && o.price_max_cents !== o.price_min_cents ? dollars(o.price_max_cents) : '',
    lengthWeeks: num(o?.length_weeks ?? null),
    promise: o?.promise ?? '',
    description: o?.description ?? '',
    key_offer: o?.key_offer ?? '',
    why_us: o?.why_us ?? '',
    why_now: o?.why_now ?? '',
    typicalDeal: dollars(o?.typical_deal_cents ?? null),
    salesCycleDays: num(o?.sales_cycle_days ?? null),
    targetTitles: o?.target_titles ?? [],
    requiredRoles: o?.target_buying_roles ?? [],
    optionalRoles: o?.optional_buying_roles ?? [],
    industries: o?.industries ?? [],
    sizeMin: num(o?.company_size_min ?? null),
    sizeMax: num(o?.company_size_max ?? null),
    proofPoints: (o?.proof_points ?? []).join('\n'),
    talkingPoints: (o?.talking_points ?? []).join('\n'),
    // A line break inside an objection or answer shows as a space, so one entry stays one line.
    objections: (o?.objections ?? []).map((x) => `${flat(x.objection)} | ${flat(x.answer)}`).join('\n'),
    avoid: (o?.avoid ?? []).join('\n'),
  };
}

const int = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n);
};
const cents = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100);
};
const textOrNull = (s: string) => (s.trim() ? s.trim() : null);

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** "objection | answer" lines, split at the first "|". A line with no "|", or an empty side, is `null`. */
function objectionsOf(s: string): (Objection | null)[] {
  return lines(s).map((l) => {
    const i = l.indexOf('|');
    const objection = i < 0 ? '' : l.slice(0, i).trim();
    const answer = i < 0 ? '' : l.slice(i + 1).trim();
    return objection && answer ? { objection, answer } : null;
  });
}

const OBJECTION_FORMAT = 'Write each line as: objection | answer';
const OBJECTION_PIPE = 'Take the | out of the objection.';

const priceChanged = (v: Values, base: Values) => v.priceModel !== base.priceModel || v.amount !== base.amount || v.amountMax !== base.amountMax;

/**
 * The body for POST and PATCH. The price goes only when Pricing or an amount changed against `base` (the offer as
 * loaded), so a save never rewrites a price nobody touched. Custom quote sends no amount; one amount goes as both
 * min and max, a range as min and max.
 */
function bodyOf(v: Values, base: Values | null): OfferBody {
  const min = v.priceModel === 'custom' ? null : cents(v.amount);
  const max = v.priceModel === 'custom' ? null : (cents(v.amountMax) ?? min);
  const price = !base || priceChanged(v, base) ? { price_model: v.priceModel || null, price_min_cents: min, price_max_cents: max } : {};
  return {
    ...price,
    name: v.name.trim(),
    practice_id: v.practiceId,
    promise: v.promise.trim(),
    description: textOrNull(v.description),
    key_offer: textOrNull(v.key_offer),
    why_us: textOrNull(v.why_us),
    why_now: textOrNull(v.why_now),
    length_weeks: int(v.lengthWeeks),
    typical_deal_cents: cents(v.typicalDeal),
    sales_cycle_days: int(v.salesCycleDays),
    target_titles: v.targetTitles,
    target_buying_roles: v.requiredRoles,
    optional_buying_roles: v.optionalRoles,
    industries: v.industries,
    company_size_min: int(v.sizeMin),
    company_size_max: int(v.sizeMax),
    proof_points: lines(v.proofPoints),
    talking_points: lines(v.talkingPoints),
    // Sent only when the text changed (or on create), so a save never rewrites objections nobody touched.
    ...(!base || v.objections !== base.objections ? { objections: objectionsOf(v.objections).filter((x): x is Objection => x !== null) } : {}),
    avoid: lines(v.avoid),
  };
}

/** API field paths to the form's fields, for errors shown at their field. */
const FIELD_OF: Record<string, keyof Values> = {
  name: 'name',
  practice_id: 'practiceId',
  promise: 'promise',
  description: 'description',
  key_offer: 'key_offer',
  why_us: 'why_us',
  why_now: 'why_now',
  price_model: 'priceModel',
  price_min_cents: 'amount',
  price_max_cents: 'amountMax',
  length_weeks: 'lengthWeeks',
  typical_deal_cents: 'typicalDeal',
  sales_cycle_days: 'salesCycleDays',
  company_size_min: 'sizeMin',
  company_size_max: 'sizeMax',
  target_buying_roles: 'requiredRoles',
  optional_buying_roles: 'optionalRoles',
  proof_points: 'proofPoints',
  talking_points: 'talkingPoints',
  objections: 'objections',
  avoid: 'avoid',
};

type Props = {
  tenant: string;
  open: boolean;
  /** `edit` changes `offerId`; `new` adds one, prefilled from `offerId` when it is set (Duplicate). */
  mode: 'edit' | 'new';
  offerId: string | undefined;
  practiceId: string | undefined;
  practices: Practice[];
  /** A section to start at, from "Not written yet. Add it". */
  field: string | undefined;
  onClose: () => void;
};

/** §19 Offer form, in a drawer: create, edit or duplicate, then :approve or :unapprove when Status changed. */
export function OfferForm({ tenant, open, mode, offerId, practiceId, practices, field, onClose }: Props) {
  const source = useQuery({ ...offerQuery(tenant, offerId ?? ''), enabled: open && !!offerId });
  const title = mode === 'edit' ? 'Edit offer' : 'Add an offer';
  const ready = !offerId || source.data;
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={title} width={560}>
      {!open ? null : ready ? (
        <Fields
          key={`${mode}:${offerId ?? ''}`}
          tenant={tenant}
          mode={mode}
          initial={source.data}
          practiceId={practiceId ?? practices[0]?.id ?? ''}
          practices={practices}
          field={field}
          onClose={onClose}
        />
      ) : source.isError ? (
        <p className={styles.formError}>{errorText(source.error)}</p>
      ) : (
        <LoadingRows>Loading the offer</LoadingRows>
      )}
    </Drawer>
  );
}

type FieldsProps = {
  tenant: string;
  mode: 'edit' | 'new';
  initial: Offer | undefined;
  practiceId: string;
  practices: Practice[];
  field: string | undefined;
  onClose: () => void;
};

function Fields({ tenant, mode, initial, practiceId, practices, field, onClose }: FieldsProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const statusName = useId();
  const roles = useQuery(buyingRolesQuery(tenant)).data?.data ?? [];
  const [v, setV] = useState<Values>(() => valuesOf(initial, practiceId, mode === 'new'));
  // What the price fields are compared with: the offer as loaded, then as last saved. A new offer sends them all.
  const [base, setBase] = useState<Values | null>(() => (mode === 'edit' ? valuesOf(initial, practiceId, false) : null));
  const ranged = !!base && base.amountMax !== '';
  // The offer as saved: an edit, or a new one once it has been added (an incomplete approve keeps it open).
  const [savedId, setSavedId] = useState<string | null>(mode === 'edit' ? (initial?.id ?? null) : null);
  const [savedStatus, setSavedStatus] = useState<OfferStatus>(mode === 'edit' && initial ? initial.status : 'draft');
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retired = savedStatus === 'archived';
  const formRef = useRef<HTMLFormElement>(null);
  // "Not written yet. Add it" opens the form at that section, after the drawer has placed its focus.
  useEffect(() => {
    if (!field) return;
    const timer = setTimeout(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [field]);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((prev) => ({ ...prev, [k]: value }));

  function fieldErrors(err: ApiError): boolean {
    const found: Partial<Record<keyof Values, string>> = {};
    for (const e of err.errors) {
      // A list's errors come as "objections.2.answer": they show at the list's field.
      const k = FIELD_OF[e.path] ?? FIELD_OF[e.path.split('.')[0]!];
      if (k && !found[k]) found[k] = e.message;
    }
    setErrors(found);
    return Object.keys(found).length > 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!v.name.trim()) {
      setErrors({ name: TITLE_NEEDED });
      return;
    }
    // An objection may not contain "|": a saved one that does would be split at the wrong place if it stays as it is.
    const piped = v.objections !== base?.objections && (initial?.objections ?? []).some((x) => x.objection.includes('|') && lines(v.objections).includes(`${flat(x.objection)} | ${flat(x.answer)}`));
    if (piped || objectionsOf(v.objections).includes(null)) {
      setErrors({ objections: piped ? OBJECTION_PIPE : OBJECTION_FORMAT });
      formRef.current?.querySelector<HTMLElement>('[data-field="objections"]')?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    const practiceName = practices.find((p) => p.id === v.practiceId)?.name ?? '';
    let id = savedId;
    let status = savedStatus;
    try {
      let warning: string | undefined;
      if (id) {
        const saved = await patchOffer(tenant, id, bodyOf(v, base));
        warning = saved.warning;
        status = saved.status;
        toast.show(`Changes to ${saved.name} saved.`);
      } else {
        const made = await createOffer(tenant, bodyOf(v, null));
        id = made.id;
        status = made.status;
        setSavedId(id);
        toast.show(`${made.name} added to ${practiceName}.`);
      }
      setSavedStatus(status);
      setBase(v);
      const name = v.name.trim();
      if (warning) {
        // A buyer edit moved it back to Draft: show it, and leave making it active again to the person.
        set('status', 'draft');
        setNotice(BACK_TO_DRAFT);
      } else if (v.status !== status) {
        if (v.status === 'approved') {
          await approveOffer(tenant, id);
          status = 'approved';
          toast.show(`${name} is active.`);
        } else {
          await unapproveOffer(tenant, id);
          status = 'draft';
          toast.show(`${name} is back in Draft.`);
        }
        setSavedStatus(status);
      }
      await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
      if (warning) return;
      onClose();
      if (mode === 'new') void navigate({ to: '/t/$tenant/offers/$practiceId/$offerId', params: { tenant, practiceId: v.practiceId, offerId: id } });
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
      if (err instanceof ApiError && err.code === 'offer-incomplete') {
        set('status', 'draft');
        setNotice(`To make this offer active, add: ${err.errors.map((x) => x.message).join(' ')}`);
      } else if (!(err instanceof ApiError && fieldErrors(err))) {
        setNotice(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const area = (k: 'promise' | 'description' | 'key_offer' | 'why_us' | 'why_now', label: string) => (
    <Field key={k} label={label} error={errors[k] ?? null}>
      {(c) => <textarea {...c} className="input" rows={3} value={v[k]} data-field={k} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  );
  const guide = (k: 'talkingPoints' | 'objections' | 'proofPoints' | 'avoid', label: string, hint: string, rows: number, dataField: string) => (
    <Field label={label} hint={hint} error={errors[k] ?? null}>
      {(c) => <textarea {...c} className="input" rows={rows} value={v[k]} data-field={dataField} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  );
  const roleGroup = (k: 'requiredRoles' | 'optionalRoles', label: string, other: 'requiredRoles' | 'optionalRoles') => (
    <fieldset className={styles.radios}>
      <legend className={styles.legendTitle}>{label}</legend>
      {roles.map((r) => (
        <label key={r.key} className={styles.radio}>
          <input
            type="checkbox"
            checked={v[k].includes(r.key)}
            disabled={v[other].includes(r.key)}
            onChange={(e) => set(k, e.target.checked ? [...v[k], r.key] : v[k].filter((x) => x !== r.key))}
          />
          <span>{r.label}</span>
        </label>
      ))}
      {errors[k] && <p className={styles.formError}>{errors[k]}</p>}
    </fieldset>
  );
  const number = (k: 'amount' | 'amountMax' | 'lengthWeeks' | 'typicalDeal' | 'salesCycleDays' | 'sizeMin' | 'sizeMax', label: string, hint?: string) => (
    <Field label={label} error={errors[k] ?? null} {...(hint ? { hint } : {})}>
      {(c) => <input {...c} className="input" type="number" min={0} step={k === 'amount' || k === 'amountMax' || k === 'typicalDeal' ? 'any' : 1} inputMode={k === 'amount' || k === 'amountMax' || k === 'typicalDeal' ? 'decimal' : 'numeric'} value={v[k]} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  );

  return (
    <form ref={formRef} className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      {notice && (
        <p role="alert" className={styles.formError}>
          {notice}
        </p>
      )}
      <fieldset disabled={retired} className={styles.fieldset}>
        <Field label="Title" error={errors.name ?? null}>
          {(c) => <input {...c} className="input" value={v.name} onChange={(e) => set('name', e.target.value)} />}
        </Field>
        <Field label="Practice" error={errors.practiceId ?? null}>
          {(c) => (
            <select {...c} className="input" value={v.practiceId} onChange={(e) => set('practiceId', e.target.value)}>
              {practices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {retired ? (
          <p className={styles.note}>Retired. Kept for history.</p>
        ) : (
          <fieldset className={styles.radios}>
            <legend className={styles.legendTitle}>Status</legend>
            {(
              [
                ['approved', 'Active', 'Scout matches accounts to it'],
                ['draft', 'Draft', 'Hidden from matching'],
              ] as const
            ).map(([value, label, about]) => (
              <label key={value} className={styles.radio}>
                <input type="radio" name={statusName} checked={v.status === value} onChange={() => set('status', value)} />
                <span>
                  {label}
                  <span className={styles.note}> {about}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className={styles.row}>
          <Field label="Pricing" error={errors.priceModel ?? null}>
            {(c) => (
              <select {...c} className="input" value={v.priceModel} onChange={(e) => set('priceModel', e.target.value as PriceModel | '')}>
                <option value="">Not set</option>
                {PRICING.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {v.priceModel !== 'custom' && number('amount', 'Amount')}
          {v.priceModel !== 'custom' && ranged && number('amountMax', 'Up to')}
          {number('lengthWeeks', 'Length (weeks)')}
        </div>
        {SECTIONS.map((s) => area(s.field, s.label))}
        <fieldset className={styles.group}>
          <legend className={styles.legendTitle}>Who it's for</legend>
          <div className={styles.row}>
            {number('typicalDeal', 'Typical deal size')}
            {number('salesCycleDays', 'Sales cycle in days')}
          </div>
          <Field label="Target titles or roles" hint="Press Enter after each one.">
            {(c) => <ChipsInput control={c} values={v.targetTitles} onChange={(x) => set('targetTitles', x)} />}
          </Field>
          {roles.length > 0 && roleGroup('requiredRoles', 'Required buying roles', 'optionalRoles')}
          {roles.length > 0 && roleGroup('optionalRoles', 'Optional buying roles', 'requiredRoles')}
          <Field label="Industries" hint="Press Enter after each one.">
            {(c) => <ChipsInput control={c} values={v.industries} onChange={(x) => set('industries', x)} />}
          </Field>
          <div className={styles.row}>
            {number('sizeMin', 'Company size min')}
            {number('sizeMax', 'Company size max')}
          </div>
        </fieldset>
        <fieldset className={styles.group}>
          <legend className={styles.legendTitle}>Seller guide</legend>
          <p className={styles.note}>What to say, what to expect, what to avoid. Shown to the AE on every account matched to this offer.</p>
          {guide('talkingPoints', 'Talking points', 'One per line, in the order a seller would use them.', 5, 'talking_points')}
          {guide('objections', 'Objections', 'One per line, written as: objection | answer', 4, 'objections')}
          {guide('proofPoints', 'Proof points', 'Case studies and numbers sellers can cite. One per line.', 4, 'proof_points')}
          {guide('avoid', 'Avoid', 'Things not to say or promise. One per line.', 3, 'avoid')}
        </fieldset>
      </fieldset>
      <div className={styles.formFooter}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        {!retired && (
          <Button type="submit" disabled={busy}>
            {savedId ? 'Save changes' : 'Add offer'}
          </Button>
        )}
      </div>
    </form>
  );
}
