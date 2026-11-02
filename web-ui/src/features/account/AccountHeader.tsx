import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { hasScope, type Me } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import type { AccountSearch } from '../../routes/workspace';
import { initialsOf } from '../../ui/Avatar';
import { Button, buttonClass } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import type { AccountReview } from '../review/api';
import { Flag, HANDOFF, HandoffChip, kindAndPlace, StatusDot } from '../review/parts';
import type { AccountDetail } from './api';
import { MoveToStage } from './MoveToStage';
import styles from './Account.module.css';

export type Stepper = { index: number; total: number; onPrev: (() => void) | undefined; onNext: (() => void) | undefined };

export type HeaderProps = {
  tenant: string;
  me: Me;
  account: AccountDetail;
  review: AccountReview;
  search: AccountSearch;
  /** "{i} of {n}" through the queue; null on a direct link. */
  stepper: Stepper | null;
  /** "{Assigned | Sent back | Declined} by {name} a moment ago" in place of the actions (C14). */
  decided: string | null;
  crmUrl: string | null;
  busy: boolean;
  onSendBack: () => void;
  onAssign: () => void;
  onRetry: () => void;
  /** After the account was moved to a stage by hand. */
  onMoved: () => void;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function Breadcrumb({ tenant, name, search }: { tenant: string; name: string; search: AccountSearch }) {
  const { from, ...filters } = search;
  const back =
    from === 'queue' ? (
      <Link to="/t/$tenant/queue" params={{ tenant }} search={filters}>
        Review queue
      </Link>
    ) : from === 'my' ? (
      <Link to="/t/$tenant/my" params={{ tenant }}>
        My accounts
      </Link>
    ) : (
      <Link to="/t/$tenant/accounts" params={{ tenant }}>
        All accounts
      </Link>
    );
  return (
    <nav aria-label="Breadcrumb">
      <ol>
        <li>{back}</li>
        <li aria-current="page">{name}</li>
      </ol>
    </nav>
  );
}

/** §4 header: breadcrumb, the account card with its status, origin and actions, and the notices under it. */
export function AccountHeader(props: HeaderProps) {
  const { tenant, me, account, review, stepper, decided } = props;
  const f = useFormat();
  const assignment = review.current_assignment ?? null;
  const handoff = review.flags?.handoff;
  const declined = review.flags?.declined_by_seller;
  const offer = review.lead_offer ?? null;
  const source = review.sources[0];

  const status = assignment ? (
    handoff?.state === 'in_crm' && assignment.seller_name ? (
      <Flag tone={HANDOFF.in_crm.tone}>{`${HANDOFF.in_crm.label} · ${assignment.seller_name}`}</Flag>
    ) : handoff ? (
      <HandoffChip state={handoff.state} />
    ) : null
  ) : review.status ? (
    <StatusDot color={review.status.color}>
      {review.status.changed_by_name && review.status.set_by !== 'scout' ? `${review.status.label} by ${firstName(review.status.changed_by_name)}` : review.status.label}
    </StatusDot>
  ) : null;

  const origin = assignment
    ? `Assigned to ${assignment.seller_name ?? 'an AE'}${assignment.assigned_by_name ? ` by ${assignment.assigned_by_name}` : ''} on ${f.date(assignment.assigned_at)}`
    : source
      ? [
          `From ${source.name}${source.via ? ` (${source.via})` : ''}`,
          source.batch_id ? `Batch ${source.batch_id}` : null,
          source.arrived_at ? `Arrived ${f.date(source.arrived_at)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  const actions = decided ? (
    <span className={styles.decided} role="status">
      {decided}
    </span>
  ) : assignment ? (
    <>
      {handoff?.state === 'failed' && hasScope(me, 'crm:push') && (
        <Button size="sm" variant="secondary" disabled={props.busy} onClick={props.onRetry}>
          Retry sending
        </Button>
      )}
      {props.crmUrl && (
        <a className={buttonClass('secondary', 'sm')} href={props.crmUrl} target="_blank" rel="noreferrer">
          Open in HubSpot
        </a>
      )}
      {hasScope(me, 'assign:act') && (
        <Button size="sm" variant="secondary" onClick={props.onAssign}>
          Reassign
        </Button>
      )}
    </>
  ) : (
    <>
      {hasScope(me, 'review:act') && (
        <Button size="sm" variant="secondary" onClick={props.onSendBack}>
          Send back
        </Button>
      )}
      {hasScope(me, 'assign:act') && (
        <Button size="sm" onClick={props.onAssign}>
          Approve and assign
        </Button>
      )}
    </>
  );

  return (
    <>
      <div className={styles.crumbs}>
        <Breadcrumb tenant={tenant} name={account.name} search={props.search} />
        <span className={styles.grow} />
        {stepper && (
          <div className={styles.stepper}>
            <span className={styles.position}>{`${stepper.index} of ${stepper.total}`}</span>
            <IconButton label="Previous" variant="secondary" disabled={!stepper.onPrev} onClick={stepper.onPrev}>
              <ChevronLeft />
            </IconButton>
            <IconButton label="Next" variant="secondary" disabled={!stepper.onNext} onClick={stepper.onNext}>
              <ChevronRight />
            </IconButton>
          </div>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.tile} aria-hidden="true">
            {initialsOf(account.name)}
          </span>
          <div className={styles.grow}>
            <div className={styles.nameRow}>
              <h1 className={styles.name}>{account.name}</h1>
              {status}
            </div>
            <div className={styles.meta}>
              <span>{[kindAndPlace(account), account.domain].filter(Boolean).join(' · ')}</span>
              {offer && (
                <span className={styles.pills}>
                  {offer.practice_name && (
                    <span className={styles.pill}>
                      <b>Practice</b>
                      {offer.practice_name}
                    </span>
                  )}
                  {offer.name && (
                    <span className={styles.pill}>
                      <b>Best offer</b>
                      {offer.name}
                    </span>
                  )}
                </span>
              )}
              {origin && <span>{origin}</span>}
            </div>
          </div>
          <div className={styles.actions}>
            {actions}
            {hasScope(me, 'review:act') && <MoveToStage tenant={tenant} account={account} current={review.stage} onMoved={props.onMoved} />}
          </div>
        </div>
      </div>

      {declined && !assignment && (
        <p className={styles.notice} role="note">
          {`Declined by ${declined.seller_name} on ${f.date(declined.at)}: ${declined.reason_label}. Assign someone else or send it back.`}
        </p>
      )}
      {handoff?.state === 'needs_decision' && (
        <div className={styles.notice} role="note">
          <strong>HubSpot needs a decision</strong>
          {handoff.reason}
        </div>
      )}
    </>
  );
}

/** The two-companies notice, from `/handoffs` (after assignment). */
export function ConflictNotice() {
  return (
    <p className={styles.notice} role="note">
      This account is linked to two HubSpot companies. Merge them in HubSpot so Scout knows which one to update.
    </p>
  );
}
