import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import { meQuery } from '../../api/me';
import { Button, buttonClass } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { createSource, directoryQuery, sourcesQuery, syncSource, type NewKey, type SourceDetail, type SourceKind } from './api';
import { KeyReveal } from './KeyReveal';
import styles from './Sources.module.css';

type Kind = Extract<SourceKind, 'agent' | 'vendor' | 'partner' | 'list' | 'crm'>;

/** The cards of step 1 (§12), with the screens.md words. */
const KINDS: { kind: Kind; label: string; title: string; about: string; placeholder: string }[] = [
  { kind: 'agent', label: 'Agent', title: 'Add an agent', about: 'An AI agent someone on your team runs, like RFP Watch.', placeholder: 'Like Hospital Expansion Watch' },
  { kind: 'vendor', label: 'Data vendor', title: 'Add a data vendor', about: 'A company that sells account or contact data.', placeholder: 'Like GovSpend' },
  { kind: 'partner', label: 'Partner', title: 'Add a partner', about: 'A firm that refers accounts to you.', placeholder: 'Like Kestrel Advisory' },
  { kind: 'list', label: 'List or research sheet', title: 'Add a list or research sheet', about: 'Files someone on your team uploads by hand.', placeholder: 'Like Q4 healthcare research' },
  { kind: 'crm', label: 'CRM', title: 'Add a CRM', about: 'Accounts that already live in HubSpot.', placeholder: 'Like HubSpot inbound' },
];

/** How accounts arrive, by kind; a data vendor's comes with its agent ("Used by" is R1d). */
const ARRIVE: Partial<Record<Kind, { label: string; about: string }>> = {
  agent: { label: 'Send through the API', about: 'Scout creates a key for this source.' },
  partner: { label: 'Send through the API', about: 'Scout creates a key for this source.' },
  list: { label: 'Upload files', about: 'CSV, Excel or Markdown from the Import screen.' },
  crm: {
    label: 'Sync from HubSpot',
    about:
      "Scout checks HubSpot for contacts that match your qualified-lead rule, marketing qualified leads by default, and sends each contact's company. The first check looks back 30 days.",
  },
};

/** The parent copy when an agent or a list has no person over it (Ruling 1). */
const NEEDS_PERSON: Partial<Record<Kind, string>> = {
  agent: 'An agent needs an owner. Pick the person who runs it.',
  list: 'A list needs an owner. Pick the person who uploads it.',
};

const NAME_NEEDED = 'Give the source a name so its batches can be traced back to it.';

type Errors = { name?: string; parent?: string };
type Added = { source: SourceDetail; key: NewKey | null; kind: Kind };

/** The request a source can send to `POST /api/v1/arrivals` with its new key, against this host. */
const sample = (secret: string) =>
  [
    `curl -X POST ${location.origin}/api/v1/arrivals \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"account": {"name": "Acme Health", "domain": "acmehealth.com"}}'`,
  ].join('\n');

type Props = { open: boolean; onOpenChange: (open: boolean) => void; tenant: string; canAddCrm: boolean };

/** §12 Add a source: pick a kind, then the details, then what to do next (the key once, the first upload or sync). */
export function AddSourceDialog({ open, onOpenChange, tenant, canAddCrm }: Props) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const kindId = useId();
  const { data: me } = useQuery(meQuery(tenant));
  const people = useQuery({ ...sourcesQuery(tenant, { kind: 'person' }), enabled: open });
  const directory = useQuery({ ...directoryQuery(tenant), enabled: open });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);

  const kinds = KINDS.filter((k) => k.kind !== 'crm' || canAddCrm);
  const def = KINDS.find((k) => k.kind === kind);
  const needsPerson = kind ? NEEDS_PERSON[kind] : undefined;
  const persons = people.data?.data ?? [];
  const parent = persons.find((p) => p.id === parentId);
  const myId = me && directory.data?.some((m) => m.user_id === me.id) ? me.id : '';
  // The owner starts as the person it sits under, else the person adding it (Decision 11).
  const ownerValue = owner ?? (needsPerson ? (parent?.owner?.user_id ?? '') : myId);

  function close(o: boolean) {
    onOpenChange(o);
    if (o) return;
    setStep(1);
    setKind(null);
    setName('');
    setParentId('');
    setOwner(null);
    setErrors({});
    setAdded(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!kind) return;
    const found: Errors = { ...(name.trim() ? {} : { name: NAME_NEEDED }), ...(needsPerson && !parentId ? { parent: needsPerson } : {}) };
    setErrors(found);
    if (found.name || found.parent) return;
    setBusy(true);
    try {
      const withKey = kind === 'agent' || kind === 'partner';
      const res = await createSource(tenant, {
        kind,
        name: name.trim(),
        ...(needsPerson ? { parent_id: parentId } : {}),
        owner_user_id: ownerValue || null,
        ...(withKey ? { create_key: true } : {}),
      });
      const { api_key: key, ...source } = res;
      setAdded({ source, key: key ?? null, kind });
      setStep(3);
      toast.show(`Added ${source.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['sources', tenant] });
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) {
        setErrors({
          ...(err.errors.find((x) => x.path === 'name') ? { name: err.errors.find((x) => x.path === 'name')!.message } : {}),
          ...(err.errors.find((x) => x.path === 'parent_id') ? { parent: err.errors.find((x) => x.path === 'parent_id')!.message } : {}),
        });
      } else toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function firstSync(id: string) {
    try {
      await syncSource(tenant, id);
      toast.show('Sync started.');
      close(false);
    } catch (err) {
      toast.show(errorText(err));
    }
  }

  if (step === 3 && added) {
    const s = added.source;
    const footer =
      added.kind === 'list' ? (
        <Link to="/t/$tenant/batches/import" params={{ tenant }} search={{ source: s.id }} className={buttonClass('primary', 'md')} onClick={() => close(false)}>
          Upload the first list
        </Link>
      ) : added.kind === 'crm' ? (
        <Button onClick={() => void firstSync(s.id)}>Run the first sync</Button>
      ) : (
        <Button onClick={() => close(false)}>Done</Button>
      );
    return (
      <Dialog open={open} onOpenChange={close} title="Source added" width={600} footer={footer}>
        <div className={styles.section}>
          <p>{`${s.name} is in your sources.`}</p>
          {added.key && (
            <>
              <p className={styles.note}>{`API key for ${s.name}`}</p>
              <KeyReveal secret={added.key.secret} />
              <p className={styles.note}>Send an account with it:</p>
              <pre className={styles.sample}>{sample(added.key.secret)}</pre>
            </>
          )}
          {added.kind === 'list' && <p className={styles.note}>Upload the first list now, or later from Import. Each upload becomes a batch credited to this source.</p>}
        </div>
      </Dialog>
    );
  }

  if (step === 2 && def) {
    const arrive = ARRIVE[def.kind];
    return (
      <Dialog open={open} onOpenChange={close} title={def.title} width={560}>
        <form className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Name" error={errors.name ?? null}>
            {(c) => <input {...c} className="input" value={name} placeholder={def.placeholder} onChange={(e) => setName(e.target.value)} />}
          </Field>
          {needsPerson && (
            <Field label="Under" error={errors.parent ?? null}>
              {(c) => (
                <select
                  {...c}
                  className="input"
                  value={parentId}
                  onChange={(e) => {
                    setParentId(e.target.value);
                    setOwner(null);
                  }}
                >
                  <option value="">Pick a person</option>
                  {persons.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Owner" hint="Answers for what this source sends.">
            {(c) => (
              <select {...c} className="input" value={ownerValue} onChange={(e) => setOwner(e.target.value)}>
                <option value="">No owner</option>
                {directory.data?.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {arrive && (
            <div className={styles.section}>
              <span className={styles.panelTitle}>How accounts arrive</span>
              <div>
                <strong>{arrive.label}</strong>
                <p className={styles.note}>{arrive.about}</p>
              </div>
            </div>
          )}
          <p className={styles.note}>Trust shows Not enough data yet until Scout learns from what this source sends.</p>
          <div className={styles.footer}>
            <span className={styles.note}>{parent ? `Shows under ${parent.name}` : 'Shows as a top-level source'}</span>
            <span className={styles.grow} />
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="submit" disabled={busy}>
              Add source
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add a source"
      description="Pick what kind of source this is. You can change the details later."
      width={600}
      footer={
        <Button disabled={!kind} onClick={() => setStep(2)}>
          Continue
        </Button>
      }
    >
      <fieldset className={styles.cards}>
        <legend className="sr-only">Kind of source</legend>
        {kinds.map((k) => (
          <label key={k.kind} className={styles.choice}>
            <span className={styles.choiceHead}>
              <input type="radio" name={`${kindId}-kind`} checked={kind === k.kind} onChange={() => setKind(k.kind)} />
              {k.label}
            </span>
            <span className={styles.note}>{k.about}</span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
