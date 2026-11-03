import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError, type FieldError } from '../../../api/errors';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { IconButton } from '../../../ui/IconButton';
import table from '../../../ui/Table.module.css';
import { useToast } from '../../../ui/Toast';
import type { TabProps } from '../SettingsScreen';
import { errorText, LoadFailed, LoadingRows } from '../shared';
import { afterSave, saveWarmIntros, savedToast, warmIntrosQuery, type WarmIntrosView } from './api';
import { check, errorsByField, introducerValue, isDirty, newRule, OTHER, personLabel, pickPerson, pointsValid, ruleName, toDraft, toEdit, type Draft, type RuleRow } from './draft';
import styles from './WarmIntros.module.css';

/** Settings > Warm intros (screens.md §21i): points per relationship and per-introducer rules, saved in one PUT. */
export function WarmIntros({ tenant }: TabProps) {
  const view = useQuery(warmIntrosQuery(tenant));
  if (view.isPending) return <LoadingRows>Loading warm intros</LoadingRows>;
  if (view.isError) return <LoadFailed title="Warm intros didn't load" error={view.error} onRetry={() => void view.refetch()} />;
  return <Editor tenant={tenant} loaded={view.data} />;
}

const Errors = ({ messages }: { messages: string[] | undefined }) =>
  messages?.map((m) => (
    <p key={m} className={styles.error}>
      {m}
    </p>
  ));

function Editor({ tenant, loaded }: { tenant: string; loaded: WarmIntrosView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState(loaded);
  const base = useMemo(() => toDraft(from), [from]);
  const [draft, setDraft] = useState<Draft>(base);
  const [apiErrors, setApiErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = isDirty(draft, base);
  const mine = check(draft, attempted);
  const pointsBad = !pointsValid(draft);
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });
  const byField = errorsByField(apiErrors);

  const messages = (place: string) => {
    const own = mine.get(place);
    return own ? [own] : byField.fields.get(place);
  };

  const setPoints = (i: number, points: string) => setDraft((d) => ({ ...d, relationships: d.relationships.map((r, at) => (at === i ? { ...r, points } : r)) }));
  const changeRule = (i: number, patch: Partial<RuleRow>) => setDraft((d) => ({ ...d, rules: d.rules.map((r, at) => (at === i ? { ...r, ...patch } : r)) }));

  function discard() {
    setDraft(base);
    setApiErrors([]);
    setFailure(null);
    setAttempted(false);
  }

  async function save() {
    setAttempted(true);
    setApiErrors([]);
    setFailure(null);
    if (check(draft, true).size > 0) return;
    setBusy(true);
    try {
      const saved = await saveWarmIntros(tenant, toEdit(draft));
      setFrom(saved);
      setDraft(toDraft(saved));
      setAttempted(false);
      afterSave(qc, tenant, saved);
      toast.show(savedToast(saved.rescoring_account_count));
    } catch (e) {
      setFailure(errorText(e));
      if (e instanceof ApiError) setApiErrors(e.errors);
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (key: string) => draft.relationships.find((r) => r.key === key)?.label ?? key;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <p className={styles.intro}>
          Warm intros add points to an account&apos;s priority, from 0 to 20. An intro gets its relationship&apos;s points unless the introducer has a rule of their own. An intro an agent or vendor declared
          counts half until someone confirms it. Only the strongest intro on an account counts.
        </p>
        <div className={styles.buttons}>
          <Button variant="secondary" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={busy || !dirty || pointsBad}>
            Save warm intros
          </Button>
        </div>
      </div>

      {failure && (apiErrors.length === 0 || byField.rest.length > 0) && (
        <div role="alert" className={styles.failure}>
          {apiErrors.length === 0 && <p>{failure}</p>}
          {byField.rest.map((e) => (
            <p key={`${e.path}:${e.message}`}>{e.message}</p>
          ))}
        </div>
      )}

      <section className={styles.section} aria-labelledby="warm-relationships">
        <h2 id="warm-relationships" className={styles.sectionTitle}>
          Relationships
        </h2>
        <div className={table.wrap}>
          <table className={`${table.table} ${styles.grid}`} aria-label="Relationships">
            <thead>
              <tr>
                <th>Relationship</th>
                <th>Points</th>
                <th>Intros</th>
              </tr>
            </thead>
            <tbody>
              {draft.relationships.map((r, i) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td>
                    <input
                      className={`input ${styles.points}`}
                      type="number"
                      min={0}
                      max={20}
                      step={1}
                      inputMode="numeric"
                      aria-label={`Points for ${r.label}`}
                      value={r.points}
                      disabled={busy}
                      {...(messages(`relationships.${i}.points`) ? { 'aria-invalid': true } : {})}
                      onChange={(e) => setPoints(i, e.target.value)}
                    />
                    <Errors messages={messages(`relationships.${i}.points`)} />
                    <Errors messages={byField.fields.get(`relationships.${i}.relationship_key`)} />
                  </td>
                  <td>{r.intro_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="warm-rules">
        <div className={styles.sectionHead}>
          <div>
            <h2 id="warm-rules" className={styles.sectionTitle}>
              Introducer rules
            </h2>
            <p className={styles.sectionIntro}>Give one person&apos;s intros more or fewer points than their relationship.</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus />}
            disabled={busy}
            onClick={() => setDraft((d) => ({ ...d, rules: [...d.rules, newRule(d.relationships[0]?.key ?? 'other')] }))}
          >
            Add a rule
          </Button>
        </div>
        {draft.rules.length === 0 && <p className={styles.empty}>No introducer rules yet. Every intro gets its relationship&apos;s points.</p>}
        {draft.rules.length > 0 && (
          <div className={table.wrap}>
            <table className={`${table.table} ${styles.grid}`} aria-label="Introducer rules">
              <thead>
                <tr>
                  <th>Introducer</th>
                  <th>Relationship</th>
                  <th>Points</th>
                  <th>Intros</th>
                  <th>
                    <span className={styles.hidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.rules.map((r, i) => {
                  const name = ruleName(r, i);
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.key ? (
                          personLabel({ name: r.name || null, email: r.email || null })
                        ) : (
                          <div className={styles.person}>
                            <select
                              className={`input ${styles.select}`}
                              aria-label={`Introducer for ${name}`}
                              value={r.pick}
                              disabled={busy}
                              onChange={(e) => changeRule(i, pickPerson(r, e.target.value, from.introducers))}
                            >
                              <option value="">Pick a person</option>
                              {from.introducers.map((p) => (
                                <option key={introducerValue(p)} value={introducerValue(p)}>
                                  {personLabel(p)}
                                </option>
                              ))}
                              <option value={OTHER}>Someone else</option>
                            </select>
                            {r.pick === OTHER && (
                              <>
                                <input
                                  className={`input ${styles.text}`}
                                  aria-label={`Name of the new introducer, rule ${i + 1}`}
                                  placeholder="Name"
                                  value={r.name}
                                  disabled={busy}
                                  onChange={(e) => changeRule(i, { name: e.target.value })}
                                />
                                <input
                                  className={`input ${styles.text}`}
                                  type="email"
                                  aria-label={`Email of the new introducer, rule ${i + 1}`}
                                  placeholder="Email"
                                  value={r.email}
                                  disabled={busy}
                                  onChange={(e) => changeRule(i, { email: e.target.value })}
                                />
                              </>
                            )}
                          </div>
                        )}
                        <Errors messages={messages(`rules.${i}.person`)} />
                        <Errors messages={byField.fields.get(`rules.${i}.id`)} />
                      </td>
                      <td>
                        <select
                          className={`input ${styles.select}`}
                          aria-label={`Relationship for ${name}`}
                          value={r.relationship_key}
                          disabled={busy}
                          {...(byField.fields.get(`rules.${i}.relationship_key`) ? { 'aria-invalid': true } : {})}
                          onChange={(e) => changeRule(i, { relationship_key: e.target.value })}
                        >
                          {draft.relationships.map((rel) => (
                            <option key={rel.key} value={rel.key}>
                              {rel.label}
                            </option>
                          ))}
                        </select>
                        <Errors messages={byField.fields.get(`rules.${i}.relationship_key`)} />
                      </td>
                      <td>
                        <input
                          className={`input ${styles.points}`}
                          type="number"
                          min={0}
                          max={20}
                          step={1}
                          inputMode="numeric"
                          aria-label={`Points for ${name}, ${labelOf(r.relationship_key)}`}
                          value={r.points}
                          disabled={busy}
                          {...(messages(`rules.${i}.points`) ? { 'aria-invalid': true } : {})}
                          onChange={(e) => changeRule(i, { points: e.target.value })}
                        />
                        <Errors messages={messages(`rules.${i}.points`)} />
                      </td>
                      <td>{r.intro_count}</td>
                      <td>
                        <span className={styles.actions}>
                          <IconButton label={`Remove rule for ${name}`} disabled={busy} onClick={() => setDraft((d) => ({ ...d, rules: d.rules.filter((_, at) => at !== i) }))}>
                            <Trash2 />
                          </IconButton>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className={styles.footer}>Saving rescores only the accounts whose intros change. Tiers someone set by hand stay as they are.</p>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="Your changes to the warm intros are not saved."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
