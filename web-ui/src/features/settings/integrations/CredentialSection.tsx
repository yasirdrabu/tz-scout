import { useState, type FormEvent } from 'react';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { useToast } from '../../../ui/Toast';
import { errorText } from '../shared';
import styles from '../Settings.module.css';
import { CREDENTIAL_KINDS, saveCredential, testIntegration, type Integration, type TestResult } from './api';

type Props = { service: Integration; tenant: string; onSaved: () => Promise<unknown>; onTested: (r: TestResult) => void };

const TOO_SHORT = 8;

/** Saved credentials (masked, `Replace`) and the paste form with `Save and test`. */
export function CredentialSection({ service, tenant, onSaved, onTested }: Props) {
  const toast = useToast();
  const saved = service.credentials;
  const [kind, setKind] = useState<string | null>(saved.length === 0 ? (CREDENTIAL_KINDS[0]?.kind ?? 'api_key') : null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = saved.find((c) => c.kind === kind)?.label ?? CREDENTIAL_KINDS.find((k) => k.kind === kind)?.label ?? 'key';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!kind) return;
    const v = value.trim();
    if (!v) return setError(`Paste the ${label} first. You can find it in ${service.name} settings.`);
    if (v.length < TOO_SHORT) return setError(`That is too short to be a ${label}. Check you copied all of it.`);
    setError(null);
    setBusy(true);
    try {
      const row = await saveCredential(tenant, service.key, { kind, value: v });
      setValue('');
      setKind(null);
      const last4 = row.credentials.find((c) => c.kind === kind)?.last4;
      const result = await testIntegration(tenant, service.key);
      onTested(result);
      toast.show(result.ok ? `Saved and connected. Round trip ${result.duration_ms} ms.` : `Saved${last4 ? `. Ends in ${last4}` : ''}. The test failed: ${result.message}`);
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(false);
      await onSaved();
    }
  }

  return (
    <section className={styles.section} aria-label="Credential">
      {saved.map((c) => (
        <div key={c.kind} className={styles.section}>
          <span className={styles.sectionTitle}>{c.label}</span>
          <div className={styles.row}>
            <code className={styles.secret}>{c.last4 ? `••••••••${c.last4}` : '••••••••'}</code>
            <Button size="sm" variant="secondary" aria-label={`Replace the ${c.label}`} onClick={() => setKind(c.kind)}>
              Replace
            </Button>
          </div>
          <p className={styles.note}>{c.last4 ? `Saved. Ends in ${c.last4}.` : 'Saved.'}</p>
        </div>
      ))}
      {kind && (
        <form className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
          {saved.length === 0 && (
            <Field label="Credential type">
              {(control) => (
                <select {...control} className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {CREDENTIAL_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label={`Paste the ${label}`} error={error}>
            {(control) => <input {...control} type="password" autoComplete="off" className="input" value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <div className={styles.row}>
            <Button type="submit" size="sm" disabled={busy}>
              Save and test
            </Button>
            {saved.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setKind(null)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
