import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, meQuery, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useToast } from '../../ui/Toast';
import type { AccountReview } from '../review/api';
import { Flag } from '../review/parts';
import { errorText } from '../settings/shared';
import { briefQuery, confirmWarmIntro, conflictsQuery, factsQuery, resolveConflict, scoreQuery, type AccountDetail, type Conflict, type ConflictFact, type Fact, type WarmIntro } from './api';
import { BriefCard, notDrafted, Recommendation } from './BriefCard';
import styles from './Account.module.css';
import { BuyingCommittee, InHubSpot, Notes, WhereFrom } from './RightRail';
import { ScoreStrip } from './ScoreStrip';

export type ViewProps = { tenant: string; me: Me; account: AccountDetail; review: AccountReview };

/** The dashed card before Scout's first draft (§4 States, Building). */
function Building({ tenant, id }: { tenant: string; id: string }) {
  const brief = useQuery(briefQuery(tenant, id));
  if (!brief.data || !notDrafted(brief.data)) return null;
  return (
    <div className={styles.building}>
      <h2 className={styles.sectionTitle}>Scout is still building this brief</h2>
      <p className={styles.note}>
        Scores, dated signals and the brief appear here as enrichment finishes. You can decide now with what the source sent, or run Enrich to search
        procurement portals, news, filings and job posts first.
      </p>
    </div>
  );
}

/** The account-level conflicts, open first, then resolved newest first (the API's order). */
function useAccountConflicts(tenant: string, id: string) {
  const conflicts = useQuery(conflictsQuery(tenant, id));
  // Person conflicts (person_id set) get their own UI later; AccountFacts shows account-level facts only.
  const list = (conflicts.data?.data ?? []).filter((c) => c.person_id === null);
  return { conflicts, list, open: list.filter((c) => c.status === 'open') };
}

/** §4a 2. The live warm intro: who, how they know them, its points, and Confirm while it counts half. */
function WarmIntroLine({ tenant, id, intro }: { tenant: string; id: string; intro: WarmIntro }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const how = intro.relationship_label.charAt(0).toLowerCase() + intro.relationship_label.slice(1);
  const text = `${intro.introducer_name ? `Warm intro from ${intro.introducer_name}` : 'Warm intro'} (${how}), +${intro.points}`;

  async function confirm() {
    setBusy(true);
    try {
      await confirmWarmIntro(tenant, intro.warm_intro_id);
      toast.show(`Warm intro confirmed. It now counts all ${intro.full_points} points.`);
      await queryClient.invalidateQueries({ queryKey: ['account', tenant, id] });
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className={styles.dotRow}>
      <span>{intro.confirmed ? text : `${text} · Unconfirmed, +${intro.points} of ${intro.full_points}`}</span>
      {!intro.confirmed && intro.can_confirm && (
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void confirm()}>
          Confirm
        </button>
      )}
    </p>
  );
}

const anchorOf = (c: Conflict) => `conflict-${c.id}`;

/** §4a 2. Before you approve: unresolved conflicts (or "Facts agree" after) and the warm intro; no card without either. */
function BeforeYouApprove({ tenant, id }: { tenant: string; id: string }) {
  const value = useFactValue();
  const score = useQuery(scoreQuery(tenant, id));
  const facts = useQuery(factsQuery(tenant, id));
  const { list, open } = useAccountConflicts(tenant, id);
  const intro = score.data?.warm_intro;
  const settled = open.length === 0 ? list.find((c) => c.status === 'resolved') : undefined;
  // An edit's kept fact is not one of the conflict's facts; the key's current fact is.
  const settledFact = settled && (settled.facts.find((x) => x.id === settled.kept_fact_id) ?? facts.data?.data.find((x) => x.key === settled.key && x.person_id === null));
  if (!intro && open.length === 0 && !settledFact) return null;

  function jump() {
    const row = document.getElementById(anchorOf(open[0]!));
    row?.scrollIntoView?.({ block: 'center' });
    row?.focus();
  }

  return (
    <Card title="Before you approve">
      {open.length > 0 && (
        <p className={cx(styles.dotRow, styles.dotWarn)}>
          <span>{open.length === 1 ? `Resolve 1 conflicting fact: ${open[0]!.label}.` : `Resolve ${open.length} conflicting facts.`}</span>
          <button type="button" className={styles.textButton} onClick={jump}>
            Resolve
          </button>
        </p>
      )}
      {settled && settledFact && <p className={styles.dotRow}>{`Facts agree. ${settled.label} set to ${value(settledFact.value, settled.key)}.`}</p>}
      {intro && <WarmIntroLine tenant={tenant} id={id} intro={intro} />}
    </Card>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** §4a 4. Why now: dated signals, newest first, each with its date, text and source link. */
export function WhyNow({ account }: { account: AccountDetail }) {
  const f = useFormat();
  const dated = account.signals.filter((s) => s.occurred_at);
  return (
    <Card
      title="Why now"
      actions={dated.length > 0 ? <span className={cx(styles.muted, styles.small)}>{`${dated.length === 1 ? '1 signal' : `${dated.length} signals`} · newest first`}</span> : undefined}
    >
      {dated.length === 0 ? (
        <p className={styles.note}>No dated signals yet. Signals show here with their date and a link to where Scout found them.</p>
      ) : (
        <ul className={styles.rows}>
          {dated.map((s) => (
            <li key={s.id}>
              <span className={styles.when}>{f.day(s.occurred_at!)}</span>
              <span className={styles.stack}>
                <span>{s.title}</span>
                {s.detail && <span className={styles.muted}>{s.detail}</span>}
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" className={styles.small}>
                    {s.source_name ?? hostOf(s.url)}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A fact's value as text; a `_cents` key is money. */
function useFactValue() {
  const f = useFormat();
  return (v: unknown, key?: string): string => {
    if (typeof v === 'number') return key?.endsWith('_cents') ? f.money(v) : f.number(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(', ');
    return v === null || v === undefined ? 'None' : JSON.stringify(v);
  };
}

const sourceOf = (x: Pick<Fact, 'source_names'>) => x.source_names.vendor ?? x.source_names.agent ?? x.source_names.person;

/**
 * A conflict's values side by side with source and date. Open: `Keep this one` for a reviewer. Kept:
 * "Kept by {name} · Change", the other values dimmed; `Change` reopens the choice (Ruling 6).
 */
function ConflictRow({ tenant, id, conflict: c, canAct }: { tenant: string; id: string; conflict: Conflict; canAct: boolean }) {
  const f = useFormat();
  const value = useFactValue();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const choosing = c.status === 'open' || changing;
  // Where focus goes once Change or Cancel has rendered: the first `Keep this one`, or `Change`.
  const focusNext = useRef<'keep' | 'change' | null>(null);
  const row = () => document.getElementById(anchorOf(c));
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    row()?.querySelector<HTMLElement>(`[data-focus="${want}"]`)?.focus();
  });
  const change = (to: boolean, focus: 'keep' | 'change') => {
    focusNext.current = focus;
    setChanging(to);
  };

  async function keep(x: ConflictFact) {
    setBusy(true);
    try {
      await resolveConflict(tenant, c.id, x.id);
      toast.show(`Kept ${value(x.value, c.key)} from ${sourceOf(x) ?? 'a source'}. Scout will use it in the brief and HubSpot.`);
      setChanging(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['account', tenant, id] }), queryClient.invalidateQueries({ queryKey: ['review-queue', tenant] })]);
      // The Keep button is gone; focus stays on the fact.
      row()?.focus();
    } catch (e) {
      // 409: the value was replaced since the page loaded, so show the latest values.
      if (e instanceof ApiError && e.status === 409) {
        toast.show(e.title);
        await queryClient.invalidateQueries({ queryKey: ['account', tenant, id] });
      } else toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id={anchorOf(c)} tabIndex={-1} className={styles.fact}>
      <dt className={styles.factLabel}>{c.label}</dt>
      <dd className={cx(styles.stack, styles.grow)}>
        {choosing ? (
          <span className={cx(styles.disagree, styles.small)}>
            Sources disagree
            {changing && (
              <>
                {' · '}
                <button type="button" className={styles.textButton} onClick={() => change(false, 'change')}>
                  Cancel
                </button>
              </>
            )}
          </span>
        ) : (
          <span className={cx(styles.muted, styles.small)}>
            {`Kept by ${c.resolved_by_name ?? 'someone'}`}
            {canAct && (
              <>
                {' · '}
                <button type="button" className={styles.textButton} data-focus="change" onClick={() => change(true, 'keep')}>
                  Change
                </button>
              </>
            )}
          </span>
        )}
        <span className={styles.sides}>
          {c.facts.map((x) => (
            <span key={x.id} className={cx(styles.side, !choosing && x.id !== c.kept_fact_id && styles.dim)}>
              <span>
                {value(x.value, c.key)}
                {!choosing && x.id === c.kept_fact_id && <span className="sr-only"> (kept)</span>}
              </span>
              <span className={cx(styles.muted, styles.small)}>{[sourceOf(x), f.day(x.observed_at)].filter(Boolean).join(' · ')}</span>
              {choosing && canAct && x.id !== c.kept_fact_id && (
                <span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    data-focus="keep"
                    aria-label={`Keep ${value(x.value, c.key)} from ${sourceOf(x) ?? 'a source'}`}
                    onClick={() => void keep(x)}
                  >
                    Keep this one
                  </Button>
                </span>
              )}
            </span>
          ))}
        </span>
        {c.explanation && <span className={cx(styles.muted, styles.small)}>{c.explanation}</span>}
      </dd>
    </div>
  );
}

/** §4a 5. Account facts: label, value and "{source} · {date}"; a fact sources disagree on shows both values. */
export function AccountFacts({ tenant, id, readOnly = false }: { tenant: string; id: string; readOnly?: boolean }) {
  const f = useFormat();
  const value = useFactValue();
  const { data: me } = useQuery(meQuery(tenant));
  const canAct = !readOnly && !!me && hasScope(me, 'review:act');
  const facts = useQuery(factsQuery(tenant, id));
  const { conflicts, list, open } = useAccountConflicts(tenant, id);
  const rows = (facts.data?.data ?? []).filter((x) => x.person_id === null);
  // Per key, the open conflict, else the latest resolved one. An edit settled its conflict (null), so that
  // row reads as any fact and an older "Kept by" for the key stays hidden.
  const byKey = new Map<string, Conflict | null>();
  for (const c of list) if (!byKey.has(c.key)) byKey.set(c.key, c.resolution === 'edited' ? null : c);
  const extra = [...byKey.values()].filter((c): c is Conflict => !!c && !rows.some((x) => x.key === c.key));
  const badge = conflicts.isSuccess ? (
    <Flag tone={open.length > 0 ? 'amber' : 'green'}>{open.length === 0 ? 'All facts agree' : open.length === 1 ? '1 conflict to resolve' : `${open.length} conflicts to resolve`}</Flag>
  ) : undefined;
  return (
    <Card title="Account facts" actions={badge}>
      {conflicts.isError && <p className={cx(styles.muted, styles.small)} role="alert">{`Conflicts didn't load. ${errorText(conflicts.error)}`}</p>}
      {facts.isPending ? (
        <p className={styles.note}>Loading facts</p>
      ) : facts.isError ? (
        <p className={styles.error} role="alert">{`Facts didn't load. ${errorText(facts.error)}`}</p>
      ) : rows.length === 0 && extra.length === 0 ? (
        <p className={styles.note}>No facts yet. Facts show here as sources send them.</p>
      ) : (
        <dl className={styles.rows}>
          {rows.map((x) => {
            const c = byKey.get(x.key);
            if (c) return <ConflictRow key={c.id} tenant={tenant} id={id} conflict={c} canAct={canAct} />;
            return (
              <div key={x.id} className={styles.fact}>
                <dt className={styles.factLabel}>{x.label}</dt>
                <dd className={styles.stack}>
                  <span>{value(x.value, x.key)}</span>
                  <span className={cx(styles.muted, styles.small)}>{[sourceOf(x), f.day(x.observed_at)].filter(Boolean).join(' · ')}</span>
                </dd>
              </div>
            );
          })}
          {extra.map((c) => (
            <ConflictRow key={c.id} tenant={tenant} id={id} conflict={c} canAct={canAct} />
          ))}
        </dl>
      )}
    </Card>
  );
}

/** §4a: the decision first, then scores, signals, facts and the brief; the rail on the right. */
export function ReviewView({ tenant, me, account, review }: ViewProps) {
  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Building tenant={tenant} id={account.id} />
        <Recommendation tenant={tenant} id={account.id} />
        <BeforeYouApprove tenant={tenant} id={account.id} />
        <ScoreStrip tenant={tenant} id={account.id} />
        <WhyNow account={account} />
        <AccountFacts tenant={tenant} id={account.id} />
        <BriefCard tenant={tenant} me={me} id={account.id} />
      </div>
      <aside className={styles.rail} aria-label="Account details">
        <BuyingCommittee tenant={tenant} me={me} account={account} />
        <Notes tenant={tenant} id={account.id} />
        <WhereFrom review={review} />
        <InHubSpot tenant={tenant} me={me} id={account.id} />
      </aside>
    </div>
  );
}
