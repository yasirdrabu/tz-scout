import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { hasScope, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { IconButton } from '../../ui/IconButton';
import { useRun } from '../settings/shared';
import {
  addNote,
  changeStatus,
  changesQuery,
  notesQuery,
  offersQuery,
  retryPush,
  setLeadOffer,
  setTier,
  signalsQuery,
  type Change,
  type FacetOption,
  type QueueRow,
  type ReviewStatus,
} from './api';
import { RowFlags, kindAndPlace } from './parts';
import { NOTE_MAX } from './ReasonPicker';
import styles from './Review.module.css';
import { DeclineDialog, ReopenDialog } from './StatusDialogs';

export type PeekProps = {
  tenant: string;
  me: Me;
  accountId: string;
  /** The row in the list shown; null when it is not (or no longer) in this view. */
  row: QueueRow | null;
  /** "{i} of {n}": the row's place in the filtered list and the list's total from the API. */
  position: { index: number; total: number } | null;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onClose: () => void;
  onAssign: (row: QueueRow) => void;
  onSendBack: (row: QueueRow) => void;
  /** After a change the queue should show at once. */
  onChanged: () => void;
  tiers: FacetOption[];
  statuses: ReviewStatus[];
};

/** Shortcuts do nothing while the person types in a field. */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** §3 Queue peek drawer: scores, inline Details, Why now, Notes and Changes for one account, with previous and next (`j`, `k`). */
export function PeekDrawer(props: PeekProps) {
  const { tenant, accountId, row, position, onPrev, onNext, onClose } = props;
  // On the window, so the keys work wherever focus is (a button that went disabled drops it), but
  // not while the person types or while a dialog opened from the drawer is on top.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      if (e.key === 'j' && onNext) {
        e.preventDefault();
        onNext();
      } else if (e.key === 'k' && onPrev) {
        e.preventDefault();
        onPrev();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNext, onPrev]);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={460}
      title={row?.name ?? 'Account'}
      subtitle={row ? [kindAndPlace(row), row.domain].filter(Boolean).join(' · ') : undefined}
      toolbar={
        <>
          <IconButton label="Previous account" variant="secondary" disabled={!onPrev} onClick={onPrev}>
            <ChevronUp />
          </IconButton>
          <IconButton label="Next account" variant="secondary" disabled={!onNext} onClick={onNext}>
            <ChevronDown />
          </IconButton>
          {position && <span className={styles.position}>{`${position.index} of ${position.total}`}</span>}
          <span className={styles.grow} />
          <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: accountId }} className={styles.textButton}>
            Open full page
          </Link>
        </>
      }
      actions={
        row && (
          <>
            {hasScope(props.me, 'assign:act') && (
              <Button size="sm" onClick={() => props.onAssign(row)}>
                Approve and assign
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => props.onSendBack(row)}>
              Send back
            </Button>
          </>
        )
      }
    >
      {row ? <Body key={row.account_id} {...props} row={row} /> : <p className={styles.note}>This account isn&apos;t in this view of the queue now. Open its full page to see it.</p>}
    </Drawer>
  );
}

function Body({ tenant, me, row, onChanged, onSendBack, tiers, statuses }: PeekProps & { row: QueueRow }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const offers = useQuery(offersQuery(tenant));
  const [tierNote, setTierNote] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'decline' | 'reopen'; status: ReviewStatus } | null>(null);
  const id = row.account_id;
  const tierName = (key: string | null) => (key ? (tiers.find((t) => t.value === key)?.label ?? key) : 'None');
  const statusName = (key: string) => statuses.find((s) => s.key === key)?.label ?? key;

  const changed = async () => {
    onChanged();
    await queryClient.invalidateQueries({ queryKey: ['account', tenant, id] });
  };

  // Best offer: someone's pick (Decision 5), else Scout's.
  const approved = offers.data?.data ?? [];
  const scoutOffer = row.best_offer_id ? (approved.find((o) => o.id === row.best_offer_id)?.name ?? (row.lead_offer?.chosen ? null : row.lead_offer?.name)) : null;
  const chosen = row.lead_offer?.chosen ? row.lead_offer : null;
  const offerOptions = [...approved.map((o) => ({ value: o.id, label: o.name }))];
  if (chosen && !offerOptions.some((o) => o.value === chosen.offer_id)) offerOptions.push({ value: chosen.offer_id, label: chosen.name ?? chosen.offer_id });

  // Tier: a tier set by hand stays until someone picks Scout's tier again (Decision 4).
  const manual = row.tier_set_by_name !== null || row.tier_set_at !== null;
  const live = statuses.filter((s) => !s.archived);
  const current = statuses.find((s) => s.key === row.review_status_key);

  function pickStatus(key: string) {
    const to = statuses.find((s) => s.key === key);
    if (!to || key === row.review_status_key) return;
    if (to.returns_to_source) onSendBack(row);
    else if (to.is_declined) setDialog({ kind: 'decline', status: to });
    else if (current?.is_declined) setDialog({ kind: 'reopen', status: to });
    else void run(async () => {
      await changeStatus(tenant, id, { to: key });
      await changed();
    }, `Review status changed to ${to.label}.`);
  }

  const declined = row.flags.declined_by_seller;
  const handoff = row.flags.handoff;
  const hasFlags = !!(declined || row.flags.new_from || row.warm_intro || handoff || row.conflict_count > 0 || row.enrichment_requested);

  return (
    <>
      <div className={styles.scores}>
        <div>
          <div className={styles.label}>Priority</div>
          <div className={styles.big}>{row.priority ?? 'None'}</div>
        </div>
        <div>
          <div className={styles.label}>Fit</div>
          <div className={styles.big}>{row.fit ?? 'None'}</div>
        </div>
        <div>
          <div className={styles.label}>Buying intent</div>
          <div className={styles.big}>{row.intent ?? 'None'}</div>
        </div>
      </div>

      <section className={styles.section} aria-labelledby="peek-details">
        <h3 id="peek-details" className={styles.label}>
          Details
        </h3>
        <div className={styles.detail}>
          <label htmlFor="peek-offer">Best offer</label>
          <div className={styles.detailValue}>
            <select
              id="peek-offer"
              className="input"
              disabled={busy || offers.isPending}
              value={chosen?.offer_id ?? ''}
              onChange={(e) => {
                const value = e.target.value || null;
                const label = value ? (offerOptions.find((o) => o.value === value)?.label ?? value) : `Scout's pick (${scoutOffer ?? 'none'})`;
                void run(async () => {
                  await setLeadOffer(tenant, id, value);
                  await changed();
                }, `Best offer changed to ${label}.`);
              }}
            >
              <option value="">{`Scout's pick (${scoutOffer ?? 'none'})`}</option>
              {offerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {chosen && <span className={styles.hint}>{`Changed from ${scoutOffer ?? 'none'}`}</span>}
          </div>
        </div>
        <div className={styles.detail}>
          <span>Practice</span>
          <span className={styles.plain}>{row.lead_offer?.practice_name ?? row.practice_name ?? 'None'}</span>
        </div>
        <div className={styles.detail}>
          <label htmlFor="peek-tier">Tier</label>
          <div className={styles.detailValue}>
            <select
              id="peek-tier"
              className="input"
              disabled={busy || row.scored_tier === null}
              value={manual ? (row.tier ?? '') : ''}
              onChange={(e) => {
                const value = e.target.value || null;
                const label = value ? tierName(value) : `Scout's tier (${tierName(row.scored_tier)})`;
                void run(async () => {
                  await setTier(tenant, id, value, tierNote.trim() || null);
                  setTierNote('');
                  await changed();
                }, `Tier changed to ${label}.`);
              }}
            >
              <option value="">{`Scout's tier (${tierName(row.scored_tier)})`}</option>
              {tiers.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {manual && <span className={styles.hint}>{`Scout scored this ${tierName(row.scored_tier)}. You changed it.`}</span>}
            {manual && row.tier_set_by_name && <span className={styles.muted}>{`Changed by ${row.tier_set_by_name}`}</span>}
            {manual && row.tier_note && <span className={styles.muted}>{row.tier_note}</span>}
            <label className="sr-only" htmlFor="peek-tier-note">
              Why change it?
            </label>
            <input
              id="peek-tier-note"
              className="input"
              placeholder="Why change it?"
              value={tierNote}
              maxLength={NOTE_MAX}
              onChange={(e) => setTierNote(e.target.value)}
            />
          </div>
        </div>
        <div className={styles.detail}>
          <label htmlFor="peek-status">Review status</label>
          <div className={styles.detailValue}>
            <select id="peek-status" className="input" disabled={busy} value={row.review_status_key ?? ''} onChange={(e) => pickStatus(e.target.value)}>
              {!current && <option value="">None</option>}
              {live.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            {row.status_changed_by_name && row.status_changed_at && (
              <span className={styles.muted}>{`Set by ${row.status_changed_by_name}, ${f.relative(row.status_changed_at)}`}</span>
            )}
          </div>
        </div>
        <div className={styles.detail}>
          <span>Source</span>
          <span className={styles.plain}>
            {row.source ? (
              <>
                {row.source.name}
                {row.source.via && <span className={styles.muted}>{` · ${row.source.via}`}</span>}
              </>
            ) : (
              'None'
            )}
          </span>
        </div>
        <div className={styles.detail}>
          <span>Flags</span>
          <div className={cx(styles.detailValue, styles.plain)}>
            {hasFlags ? <RowFlags row={row} date={f.date} /> : <span className={styles.muted}>None</span>}
            {declined && <span className={styles.muted}>{`Declined by ${declined.seller_name} on ${f.date(declined.at)}: ${declined.reason_label}`}</span>}
            {handoff?.state === 'failed' && hasScope(me, 'crm:push') && (
              <span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await retryPush(tenant, id);
                      await changed();
                    }, `Sending ${row.name} to HubSpot again.`)
                  }
                >
                  Retry sending
                </Button>
              </span>
            )}
          </div>
        </div>
      </section>

      <WhyNow tenant={tenant} id={id} />
      <Notes tenant={tenant} id={id} onAdded={changed} />
      <Changes tenant={tenant} id={id} />

      {dialog?.kind === 'decline' && (
        <DeclineDialog
          tenant={tenant}
          account={row}
          status={dialog.status}
          onClose={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            void run(changed, `Review status changed to ${statusName(to)}.`);
          }}
        />
      )}
      {dialog?.kind === 'reopen' && (
        <ReopenDialog
          tenant={tenant}
          account={row}
          status={dialog.status}
          onClose={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            void run(changed, `Review status changed to ${statusName(to)}.`);
          }}
        />
      )}
    </>
  );
}

function WhyNow({ tenant, id }: { tenant: string; id: string }) {
  const f = useFormat();
  const signals = useQuery(signalsQuery(tenant, id));
  const dated = (signals.data ?? []).filter((s) => s.occurred_at).slice(0, 2);
  return (
    <section className={styles.section} aria-labelledby="peek-why">
      <h3 id="peek-why" className={styles.label}>
        Why now
      </h3>
      {signals.isPending ? (
        <p className={styles.note}>Loading signals</p>
      ) : signals.isError ? (
        <p className={styles.error}>Signals didn&apos;t load. Close and open the account to try again.</p>
      ) : dated.length === 0 ? (
        <p className={styles.note}>No dated signals yet. Run Enrich to search procurement portals, news and job posts.</p>
      ) : (
        dated.map((s) => (
          <div key={s.id} className={styles.signal}>
            <span className={styles.when}>{f.date(s.occurred_at!)}</span>
            <span>{s.title}</span>
          </div>
        ))
      )}
    </section>
  );
}

function Notes({ tenant, id, onAdded }: { tenant: string; id: string; onAdded: () => Promise<void> }) {
  const f = useFormat();
  const notes = useQuery(notesQuery(tenant, id));
  const { run, busy } = useRun();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const total = notes.data?.total ?? 0;

  function add() {
    if (!draft.trim()) {
      setError('Write the note first, then add it.');
      return;
    }
    setError(null);
    void run(async () => {
      await addNote(tenant, id, draft.trim());
      setDraft('');
      await onAdded();
    }, 'Note added. Everyone reviewing this account can see it.');
  }

  return (
    <section className={styles.section} aria-labelledby="peek-notes">
      <div className={styles.sectionHead}>
        <h3 id="peek-notes" className={styles.label}>
          Notes
        </h3>
        {notes.data && <span className={styles.muted}>{total === 1 ? '1 note' : `${total} notes`}</span>}
      </div>
      {notes.isError && <p className={styles.error}>Notes didn&apos;t load. Close and open the account to try again.</p>}
      {(notes.data?.data ?? []).map((n) => (
        <div key={n.id} className={styles.noteItem}>
          <div className={styles.when}>
            <span className={styles.who}>{n.by_name ?? 'Someone'}</span> · {f.date(n.at)}
          </div>
          <div>{n.body}</div>
        </div>
      ))}
      <label className="sr-only" htmlFor="peek-note">
        Add a note
      </label>
      <textarea
        id="peek-note"
        className="input"
        placeholder="Add a note for the team. Relationships, timing, why you changed something."
        value={draft}
        maxLength={NOTE_MAX}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'peek-note-error' : undefined}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && (
        <p id="peek-note-error" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.right}>
        <Button size="sm" onClick={add} disabled={busy}>
          Add note
        </Button>
      </div>
    </section>
  );
}

/** One change log line in words. */
function changeText(c: Change): string {
  const from = c.from ?? 'none';
  const to = c.to ?? 'none';
  switch (c.kind) {
    case 'arrived':
      return `Arrived from ${c.to ?? 'a source'}`;
    case 'scored':
      return `Scored ${c.priority ?? 'again'} and placed in ${to}`;
    case 'status':
      return `Review status changed from ${from} to ${to}${c.reason ? `: ${c.reason}` : ''}`;
    case 'stage':
      return `Stage changed from ${from} to ${to}`;
    case 'tier':
      return `Tier changed from ${from} to ${to}`;
    case 'lead_offer':
      return `Best offer changed from ${from} to ${to}`;
    case 'assigned':
      return `Assigned to ${to}`;
    case 'accepted':
      return `${to} accepted`;
    case 'declined_by_seller':
      return `Declined by ${c.by_name ?? 'the AE'}${c.reason ? `: ${c.reason}` : ''}`;
    case 'withdrawn':
      return `Assignment to ${from} ended`;
  }
}

function Changes({ tenant, id }: { tenant: string; id: string }) {
  const f = useFormat();
  const changes = useQuery(changesQuery(tenant, id));
  return (
    <section className={styles.section} aria-labelledby="peek-changes">
      <h3 id="peek-changes" className={styles.label}>
        Changes
      </h3>
      {changes.isPending ? (
        <p className={styles.note}>Loading changes</p>
      ) : changes.isError ? (
        <p className={styles.error}>Changes didn&apos;t load. Close and open the account to try again.</p>
      ) : changes.data.data.length === 0 ? (
        <p className={styles.note}>No changes yet.</p>
      ) : (
        <ul className={styles.section}>
          {changes.data.data.map((c) => (
            <li key={c.id} className={styles.change}>
              <span className={cx(styles.changeDot, c.by_name && styles.byPerson)} aria-hidden="true" />
              <span>
                {changeText(c)}
                {c.note && c.kind !== 'scored' ? `. ${c.note}` : ''}
                <span className={styles.muted}>{` · ${c.by_name ?? 'Scout'}, ${f.relative(c.at)}`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
