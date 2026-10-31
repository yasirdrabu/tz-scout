import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { Drawer } from '../../../ui/Drawer';
import { Field } from '../../../ui/Field';
import { useToast } from '../../../ui/Toast';
import { errorText } from '../../settings/shared';
import styles from '../Admin.module.css';
import { createTenant, slugFrom, tenantsQuery, workspaceHost, type AdminTenant, type NewTenant } from './api';

type Errors = Partial<Record<keyof NewTenant, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULTS: NewTenant = { name: '', slug: '', owner_email: '', currency: 'USD', timezone: 'America/New_York' };

/** Every IANA timezone this browser knows, with the default first if the list is missing. */
function timezones(): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(DEFAULTS.timezone) ? all : [DEFAULTS.timezone, ...all];
  } catch {
    return [DEFAULTS.timezone];
  }
}

function check(v: NewTenant): Errors {
  const e: Errors = {};
  if (!v.name.trim()) e.name = 'Add the company name.';
  if (!v.slug.trim()) e.slug = 'Add a slug.';
  if (!v.owner_email.trim()) e.owner_email = "Add the owner's email.";
  else if (!EMAIL.test(v.owner_email.trim())) e.owner_email = "That doesn't look like an email address.";
  if (!v.currency.trim()) e.currency = 'Add a currency code, for example USD.';
  return e;
}

/** What the API refused, by field; null when it is not about one field. */
function fieldErrors(err: unknown): Errors | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'slug-taken') return { slug: 'That slug is taken. Pick another.' };
  if (err.status !== 400) return null;
  const known = new Set<string>(Object.keys(DEFAULTS));
  const listed = err.errors.filter((x) => known.has(x.path));
  if (listed.length > 0) return Object.fromEntries(listed.map((x) => [x.path, x.message])) as Errors;
  // The slug rule is the service's own check, sent without a field.
  return { slug: err.message };
}

/** New tenant: name, slug, owner email, currency and timezone, with Scout defaults. Creation is instant. */
export function NewTenantPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [values, setValues] = useState<NewTenant>(DEFAULTS);
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AdminTenant | null>(null);

  function close(o: boolean) {
    if (o) return onOpenChange(true);
    onOpenChange(false);
    setValues(DEFAULTS);
    setSlugEdited(false);
    setErrors({});
    setCreated(null);
  }

  const set = (key: keyof NewTenant, value: string) =>
    setValues((v) => ({ ...v, [key]: value, ...(key === 'name' && !slugEdited ? { slug: slugFrom(value) } : {}) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = check(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const body = { ...values, name: values.name.trim(), slug: values.slug.trim(), owner_email: values.owner_email.trim(), currency: values.currency.trim().toUpperCase() };
      const tenant = await createTenant(body);
      await queryClient.invalidateQueries({ queryKey: tenantsQuery().queryKey });
      setCreated(tenant);
    } catch (err) {
      const byField = fieldErrors(err);
      if (byField) setErrors(byField);
      else toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Drawer
        open={open}
        onOpenChange={close}
        title={`${created.name} is ready`}
        width={460}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Done
            </Button>
            <Button onClick={() => void navigate({ to: '/t/$tenant', params: { tenant: created.slug } })}>Open tenant</Button>
          </>
        }
      >
        <div className={styles.section}>
          <p>It lives at {workspaceHost(created.slug)}.</p>
          {created.owner && <p className={styles.note}>{created.owner.email} is invited as the owner. They sign in with Microsoft.</p>}
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={close}
      title="New tenant"
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-tenant" disabled={busy}>
            Create tenant
          </Button>
        </>
      }
    >
      <form id="new-tenant" className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Company name" error={errors.name}>
          {(c) => <input {...c} className="input" value={values.name} placeholder="Harbor Health Partners" onChange={(e) => set('name', e.target.value)} />}
        </Field>
        <Field
          label="Slug"
          hint={
            <>
              Lowercase letters, numbers and dashes, up to 40 characters. Starts and ends with a letter or number. The workspace lives at{' '}
              {workspaceHost(values.slug || '{slug}')}.
            </>
          }
          error={errors.slug}
        >
          {(c) => (
            <input
              {...c}
              className="input"
              value={values.slug}
              maxLength={40}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                setSlugEdited(true);
                set('slug', e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Owner email" hint="They get the Owner role and sign in with Microsoft." error={errors.owner_email}>
          {(c) => <input {...c} type="email" className="input" value={values.owner_email} placeholder="name@company.com" onChange={(e) => set('owner_email', e.target.value)} />}
        </Field>
        <Field label="Currency" hint="A three-letter code, for example USD or EUR." error={errors.currency}>
          {(c) => <input {...c} className="input" value={values.currency} maxLength={3} onChange={(e) => set('currency', e.target.value)} />}
        </Field>
        <Field label="Timezone" error={errors.timezone}>
          {(c) => (
            <select {...c} className="input" value={values.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {timezones().map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className={styles.note}>The tenant starts with Scout defaults.</p>
      </form>
    </Drawer>
  );
}
