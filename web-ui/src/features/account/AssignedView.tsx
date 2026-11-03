import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoney } from '../../lib/format';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { HandoffChip } from '../review/parts';
import { errorText } from '../settings/shared';
import { activityQuery, briefQuery, handoffsQuery, scoreQuery, type Handoffs } from './api';
import { BriefCard } from './BriefCard';
import styles from './Account.module.css';
import { AccountFacts, WhyNow, type ViewProps } from './ReviewView';
import { BuyingCommittee } from './RightRail';
import { ScoreStrip, ScoreTile } from './ScoreStrip';

/** §4b 1. Outcome tiles in R1: Replies and Opportunity (Meetings held and Buyers engaged are R2). */
function Outcomes({ handoffs }: { handoffs: Handoffs | undefined }) {
  const f = useFormat();
  const ft = handoffs?.follow_through ?? null;
  const done = handoffs?.handoffs.find((h) => h.status === 'completed');
  const deal = handoffs?.deals.find((d) => d.status === 'open') ?? handoffs?.deals.find((d) => d.status === 'won') ?? null;
  return (
    <section className={cx(styles.tiles, styles.tiles4)} aria-label="Outcomes">
      <div className={styles.scoreTile}>
        <span className={styles.label}>Replies</span>
        {ft ? (
          <>
            <span className={styles.big}>{`${f.number(ft.counts.replies)} of ${f.number(ft.counts.emails)}`}</span>
            {done?.completed_at && <span className={styles.note}>{`Emails sent since ${f.date(done.completed_at)}`}</span>}
          </>
        ) : (
          <>
            <span className={styles.big}>Not yet</span>
            <span className={styles.note}>Counts show once the account is in HubSpot and Scout reads its activity.</span>
          </>
        )}
      </div>
      <div className={styles.scoreTile}>
        <span className={styles.label}>Opportunity</span>
        {deal ? (
          <>
            <span className={styles.big}>{deal.name}</span>
            {deal.amount_cents !== null && <span className={styles.note}>{deal.currency ? formatMoney(deal.amount_cents, deal.currency) : f.money(deal.amount_cents)}</span>}
          </>
        ) : (
          <span className={styles.big}>Not yet</span>
        )}
      </div>
    </section>
  );
}

/** §4b 3. HubSpot activity, newest first, `Show more` by cursor. */
function Activity({ tenant, id }: { tenant: string; id: string }) {
  const f = useFormat();
  const activity = useInfiniteQuery(activityQuery(tenant, id));
  const rows = activity.data?.pages.flatMap((p) => p.data) ?? [];
  const synced = activity.data?.pages[0]?.synced_at;
  return (
    <Card title="HubSpot activity" actions={synced ? <span className={cx(styles.muted, styles.small)}>{`Synced ${f.relative(synced)}`}</span> : undefined}>
      {activity.isPending ? (
        <p className={styles.note}>Loading HubSpot activity</p>
      ) : activity.isError ? (
        <p className={styles.error} role="alert">
          {`HubSpot activity didn't load. ${errorText(activity.error)}`}{' '}
          <button type="button" className={styles.textButton} onClick={() => void activity.refetch()}>
            Try again
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.note}>No HubSpot activity yet. Replies, emails and meetings show here as HubSpot records them.</p>
      ) : (
        <>
          <ul className={styles.rows}>
            {rows.map((r) => (
              <li key={r.id}>
                <span className={styles.when}>{f.date(r.at)}</span>
                <span>{r.summary}</span>
              </li>
            ))}
          </ul>
          {activity.hasNextPage && (
            <div>
              <Button size="sm" variant="secondary" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** The first sentence of a section, for the review record. */
const firstSentence = (text: string) => text.split(/(?<=[.!?])\s+/)[0] ?? text;

/** §4b 4. Review record: who approved it, the scores, each brief section shortened, and the full review read only. */
function ReviewRecord({ tenant, me, account, review }: ViewProps) {
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const score = useQuery(scoreQuery(tenant, account.id));
  const brief = useQuery(briefQuery(tenant, account.id));
  const approved = review.approved;
  return (
    <Card title="Review record" actions={approved ? <span className={cx(styles.muted, styles.small)}>{`Approved by ${approved.by_name ?? 'someone'} on ${f.date(approved.at)}`}</span> : undefined}>
      <div className={styles.section}>
        {open ? (
          <>
            <ScoreStrip tenant={tenant} id={account.id} />
            <WhyNow account={account} />
            <AccountFacts tenant={tenant} id={account.id} readOnly />
            <BriefCard tenant={tenant} me={me} id={account.id} readOnly />
          </>
        ) : (
          <>
            {score.data && (
              <div className={styles.tiles}>
                {score.data.tiles.map((t) => (
                  <ScoreTile key={t.key} tile={t} />
                ))}
              </div>
            )}
            {(brief.data?.sections ?? [])
              .filter((s) => s.body)
              .map((s) => (
                <p key={s.key} className={styles.small}>
                  <strong>{`${s.title}: `}</strong>
                  {firstSentence(s.body!)}
                </p>
              ))}
          </>
        )}
        <div>
          <button type="button" className={styles.textButton} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show the full brief, signals and facts'}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** §4b 5. Assignment: the AE, whether they accepted, the assigner's note and the handoff state. */
function AssignmentCard({ review }: { review: ViewProps['review'] }) {
  const f = useFormat();
  const a = review.current_assignment!;
  const ae = a.seller_name ?? 'The AE';
  const answer =
    a.status === 'accepted' && a.responded_at
      ? a.accepted_how === 'crm_activity' || a.accepted_how === 'auto_timeout'
        ? `Accepted automatically ${f.dateTime(a.responded_at)}`
        : `Accepted ${f.dateTime(a.responded_at)}`
      : `Waiting for ${ae} to accept`;
  const handoff = review.flags?.handoff;
  return (
    <Card title="Assignment">
      <div className={styles.form}>
        <div className={styles.person}>
          <Avatar name={ae} size="sm" decorative />
          <span className={styles.stack}>
            <strong>{ae}</strong>
            <span className={styles.muted}>{answer}</span>
          </span>
        </div>
        {a.notes && (
          <figure className={styles.stack}>
            <blockquote className={styles.quote}>{`"${a.notes}"`}</blockquote>
            {a.assigned_by_name && <figcaption className={cx(styles.muted, styles.small)}>{a.assigned_by_name}</figcaption>}
          </figure>
        )}
        {handoff && (
          <div>
            <HandoffChip state={handoff.state} />
          </div>
        )}
      </div>
    </Card>
  );
}

/** §4b: outcomes, HubSpot activity and the review record; the assignment and committee on the right. */
export function AssignedView(props: ViewProps) {
  const { tenant, me, account, review } = props;
  const handoffs = useQuery(handoffsQuery(tenant, account.id));
  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Outcomes handoffs={handoffs.data} />
        <Activity tenant={tenant} id={account.id} />
        <ReviewRecord {...props} />
      </div>
      <aside className={styles.rail} aria-label="Account details">
        <AssignmentCard review={review} />
        <BuyingCommittee tenant={tenant} me={me} account={account} />
      </aside>
    </div>
  );
}
