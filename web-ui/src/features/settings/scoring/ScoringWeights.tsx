import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { LoadingLine } from '../../../ui/LoadingLine';
import { useToast } from '../../../ui/Toast';
import { TierChip } from '../../review/parts';
import type { TabProps } from '../SettingsScreen';
import { errorText, LoadFailed, LoadingRows } from '../shared';
import { afterSave, previewQuery, profileQuery, saveProfile, type Cutoffs, type Draft, type Preview, type Profile } from './api';
import { balance, draftOf, isValid, MAX_WEIGHT, problems, same, STEP, total, WEIGHT_KEYS, type WeightKey } from './draft';
import styles from './ScoringWeights.module.css';

const WEIGHTS: Record<WeightKey, { label: string; feeds: string }> = {
  fit: { label: 'Fit', feeds: 'How well the account matches the offer: industry, size, revenue, region and buyer.' },
  intent: { label: 'Buying intent', feeds: 'Signs the account is ready to buy: triggers, research and pain.' },
  revenue: { label: 'Revenue potential', feeds: "How big a deal it could be, from the offer's deal size, the account's size and room to expand." },
  trust: { label: 'Source trust', feeds: "Learned nightly from what each source's accounts became." },
};

const CUTOFFS: { key: keyof Cutoffs; label: string }[] = [
  { key: 'act_now', label: 'Act now' },
  { key: 'good_fit', label: 'Good fit' },
  { key: 'watch', label: 'Watch' },
];

// The preview sends tier values only; the five tiers and their words are fixed by the scoring model.
const TIERS: [string, string][] = [
  ['act_now', 'Act now'],
  ['good_fit', 'Good fit'],
  ['watch', 'Watch'],
  ['nurture', 'Nurture'],
  ['not_fit', 'Not a fit'],
];
const tierLabel = (tier: string) => TIERS.find(([t]) => t === tier)?.[1] ?? tier;

/** Settings > Scoring weights (screens.md §21f): four weights, three tier cutoffs, what a draft would change, and Save and rescore. */
export function ScoringWeights({ tenant }: TabProps) {
  const profile = useQuery(profileQuery(tenant));
  if (profile.isPending) return <LoadingRows>Loading scoring weights</LoadingRows>;
  if (profile.isError) return <LoadFailed title="Scoring weights didn't load" error={profile.error} onRetry={() => void profile.refetch()} />;
  return <Editor tenant={tenant} loaded={profile.data} />;
}

function Editor({ tenant, loaded }: { tenant: string; loaded: Profile }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saved, setSaved] = useState(loaded);
  const [seen, setSeen] = useState(loaded);
  const base = draftOf(saved);
  const [draft, setDraft] = useState<Draft>(base);
  const [moved, setMoved] = useState<WeightKey | undefined>(undefined);
  const [failure, setFailure] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const dirty = !same(draft, base);
  // A refetch never wipes unsaved edits, and never steps back to an older version.
  if (loaded !== seen) {
    setSeen(loaded);
    if (!dirty && loaded.version >= saved.version) {
      setSaved(loaded);
      setDraft(draftOf(loaded));
    }
  }
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });

  const valid = isValid(draft);
  const issues = problems(draft);

  // The preview waits 400 ms after the last change, and never asks about an invalid draft.
  const [settled, setSettled] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setSettled(draft), 400);
    return () => clearTimeout(t);
  }, [draft]);
  const preview = useQuery({
    ...previewQuery(tenant, settled),
    enabled: dirty && valid && isValid(settled) && !same(settled, base),
    placeholderData: keepPreviousData,
  });

  const setWeight = (key: WeightKey, value: number) => {
    setMoved(key);
    setDraft((d) => ({ ...d, weights: { ...d.weights, [key]: value } }));
  };
  const setCutoff = (key: keyof Cutoffs, value: number) => setDraft((d) => ({ ...d, tier_cutoffs: { ...d.tier_cutoffs, [key]: value } }));

  function discard() {
    setDraft(draftOf(saved));
    setMoved(undefined);
    setFailure([]);
  }

  async function save() {
    const body: Partial<Draft> = {
      ...(same({ weights: draft.weights, tier_cutoffs: base.tier_cutoffs }, base) ? {} : { weights: draft.weights }),
      ...(same({ weights: base.weights, tier_cutoffs: draft.tier_cutoffs }, base) ? {} : { tier_cutoffs: draft.tier_cutoffs }),
    };
    setBusy(true);
    setFailure([]);
    try {
      const next = await saveProfile(tenant, body);
      const fresh: Profile = { ...saved, ...next, defaults: next.defaults ?? saved.defaults };
      setSaved(fresh);
      setSeen(fresh);
      qc.setQueryData(profileQuery(tenant).queryKey, fresh);
      setDraft(draftOf(fresh));
      setMoved(undefined);
      afterSave(qc, tenant);
      toast.show('Rescoring started.');
    } catch (e) {
      setFailure(e instanceof ApiError && e.errors.length > 0 ? e.errors.map((x) => x.message) : [errorText(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <p className={styles.intro}>
          Every account gets a priority score from 0 to 100. It blends four scores using these weights, and the result puts the account in a tier. The tier picks which playbook runs.
        </p>
        <div className={styles.buttons}>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(draftOf(saved.defaults));
              setMoved(undefined);
            }}
            disabled={busy || same(draft, draftOf(saved.defaults))}
          >
            Restore defaults
          </Button>
          <Button variant="secondary" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={busy || !dirty || !valid}>
            Save and rescore
          </Button>
        </div>
      </div>

      {failure.length > 0 && (
        <div role="alert" className={styles.failure}>
          {failure.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}

      <section className={styles.section} aria-label="Weights">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Weights</h2>
          <div className={styles.totalRow}>
            {issues.weights ? (
              <>
                <span role="status" className={styles.warn}>
                  {issues.weights}
                </span>
                <Button variant="secondary" size="sm" onClick={() => setDraft((d) => ({ ...d, weights: balance(d.weights, moved) }))}>
                  Balance to 100
                </Button>
              </>
            ) : (
              <span role="status" className={styles.ok}>
                Adds up to 100
              </span>
            )}
          </div>
        </div>
        <ul className={styles.sliders}>
          {WEIGHT_KEYS.map((k) => (
            <li key={k} className={styles.slider}>
              <div className={styles.sliderHead}>
                <label htmlFor={`weight-${k}`} className={styles.sliderLabel}>
                  {WEIGHTS[k].label}
                </label>
                <output htmlFor={`weight-${k}`} className={styles.value}>
                  {draft.weights[k]}
                </output>
              </div>
              <input
                id={`weight-${k}`}
                type="range"
                min={0}
                max={MAX_WEIGHT}
                step={STEP}
                value={draft.weights[k]}
                disabled={busy}
                aria-describedby={`feeds-${k}`}
                onChange={(e) => setWeight(k, Number(e.target.value))}
              />
              <p id={`feeds-${k}`} className={styles.feeds}>
                {WEIGHTS[k].feeds}
              </p>
            </li>
          ))}
        </ul>
        <span className={styles.hidden}>{`Total ${total(draft.weights)}`}</span>
      </section>

      <section className={styles.section} aria-label="Tier cutoffs">
        <h2 className={styles.sectionTitle}>Tier cutoffs</h2>
        <div className={styles.cutoffs}>
          {CUTOFFS.map(({ key, label }) => (
            <label key={key} className={styles.cutoff}>
              <span>{label}</span>
              <input
                type="number"
                className={`input ${styles.number}`}
                min={key === 'watch' ? 1 : 0}
                max={100}
                step={1}
                value={Number.isNaN(draft.tier_cutoffs[key]) ? '' : draft.tier_cutoffs[key]}
                disabled={busy}
                onChange={(e) => setCutoff(key, e.target.value === '' ? NaN : Number(e.target.value))}
              />
            </label>
          ))}
        </div>
        <p className={styles.hint}>Nurture is everything below Watch.</p>
        <p className={styles.hint}>Each tier has to start higher than the one below it, and Act now at 100 or less.</p>
        {issues.cutoffs.map((m) => (
          <p key={m} role="alert" className={styles.error}>
            {m}
          </p>
        ))}
      </section>

      <section className={styles.section} aria-label="What changes">
        <h2 className={styles.sectionTitle}>What changes</h2>
        <Changes preview={preview.data} loading={preview.isFetching} failed={preview.isError ? errorText(preview.error) : null} waiting={dirty && valid} />
      </section>

      <p className={styles.footnote}>
        Saving rescores every account in this workspace, so accounts already with a seller can change tier too. Tiers someone set by hand stay as they are, and running playbooks keep going.
      </p>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="Your changes to the scoring weights are not saved."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}

function Changes({ preview, loading, failed, waiting }: { preview: Preview | undefined; loading: boolean; failed: string | null; waiting: boolean }) {
  if (failed) return <p className={styles.error}>{failed}</p>;
  if (!waiting && !preview) return <p className={styles.hint}>Change a weight or a cutoff to see what it would do.</p>;
  if (!preview) return <LoadingLine>Working out what changes</LoadingLine>;
  return (
    <div className={styles.changes} aria-busy={loading}>
      {loading && <LoadingLine>Working out what changes</LoadingLine>}
      <p className={styles.hint}>Accounts scored in the last 90 days.</p>
      <table className={styles.table}>
        <caption className={styles.hidden}>Accounts in each tier</caption>
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">Now</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map(([tier, label]) => (
            <tr key={tier}>
              <th scope="row">{label}</th>
              <td>{preview.before[tier] ?? 0}</td>
              <td>{preview.after[tier] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.samples.length > 0 && (
        <table className={styles.table}>
          <caption className={styles.hidden}>Sample accounts</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Fit</th>
              <th scope="col">Buying intent</th>
              <th scope="col">Revenue potential</th>
              <th scope="col">Source trust</th>
              <th scope="col">Score</th>
              <th scope="col">Change</th>
              <th scope="col">Tier</th>
            </tr>
          </thead>
          <tbody>
            {preview.samples.map((s) => {
              const change = s.score_after - s.score_before;
              return (
                <tr key={s.account_id}>
                  <th scope="row">{s.name}</th>
                  <td>{s.fit}</td>
                  <td>{s.intent}</td>
                  <td>{s.revenue}</td>
                  <td>{s.trust}</td>
                  <td>{s.score_after}</td>
                  <td>{change === 0 ? '0' : change > 0 ? `+${change}` : `−${-change}`}</td>
                  <td>
                    <span className={styles.tiers}>
                      {s.tier_before !== s.tier_after && (
                        <>
                          <TierChip tier={s.tier_before} label={tierLabel(s.tier_before)} />
                          <span aria-label="to">→</span>
                        </>
                      )}
                      <TierChip tier={s.tier_after} label={tierLabel(s.tier_after)} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
