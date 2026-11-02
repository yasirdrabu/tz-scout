import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, meQuery, type Me } from '../../api/me';
import type { AccountSearch } from '../../routes/workspace';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { LoadingLine } from '../../ui/LoadingLine';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { facetsQuery, queueQuery, retryPush, reviewQuery, statusesQuery, type AccountReview, type DialogAccount, type QueueFilters, type ReviewStatus } from '../review/api';
import { AssignDialog } from '../review/AssignDialog';
import { SendBackDialog } from '../review/SendBackDialog';
import { errorText } from '../settings/shared';
import { accountQuery, BUSY_REFRESH_MS, handoffsQuery, PAGE_REFRESH_MS } from './api';
import styles from './Account.module.css';
import { AccountHeader, ConflictNotice, type Stepper } from './AccountHeader';
import { AssignedView } from './AssignedView';
import { ReviewView } from './ReviewView';
import { StageTracker } from './StageTracker';

const route = getRouteApi('/t/$tenant/accounts/$id');

/** §4 Account page. One page per account id, so moving to the next account starts fresh. */
export function AccountPage() {
  const { tenant, id } = route.useParams();
  const { data: me } = useQuery(meQuery(tenant));
  if (!me) return null;
  return <Account key={id} tenant={tenant} id={id} me={me} />;
}

const filtersOf = ({ from: _from, ...filters }: AccountSearch): QueueFilters => filters;

/** What a refetch compares with, to tell that someone else decided the account (C14). */
type Snapshot = { assignmentId: string | null; statusKey: string | null };
const snapshotOf = (r: AccountReview): Snapshot => ({ assignmentId: r.current_assignment?.id ?? null, statusKey: r.status?.key ?? null });

/** `own` is set by the person's own change, so the next review becomes the base instead of a swap. */
type Watch = { seen: AccountReview | undefined; base: Snapshot | null; own: boolean; decided: string | null };

function nextWatch(w: Watch, r: AccountReview, statuses: ReviewStatus[]): Watch {
  const now = snapshotOf(r);
  if (!w.base || w.own) return { seen: r, base: now, own: false, decided: w.decided };
  if (now.assignmentId && now.assignmentId !== w.base.assignmentId) {
    return { ...w, seen: r, decided: `Assigned by ${r.current_assignment?.assigned_by_name ?? 'someone'} a moment ago` };
  }
  if (now.statusKey !== w.base.statusKey) {
    const s = statuses.find((x) => x.key === now.statusKey);
    const who = r.status?.changed_by_name ?? 'someone';
    if (s?.returns_to_source) return { ...w, seen: r, decided: `Sent back by ${who} a moment ago` };
    if (s?.is_declined) return { ...w, seen: r, decided: `Declined by ${who} a moment ago` };
  }
  return { ...w, seen: r };
}

function Account({ tenant, id, me }: { tenant: string; id: string; me: Me }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const filters = filtersOf(search);

  const account = useQuery(accountQuery(tenant, id));
  const review = useQuery({
    ...reviewQuery(tenant, id),
    refetchInterval: (q) => (q.state.data?.flags?.handoff?.state === 'sending' ? BUSY_REFRESH_MS : PAGE_REFRESH_MS),
  });
  const statuses = useQuery({ ...statusesQuery(tenant), enabled: hasScope(me, 'review:act') || hasScope(me, 'assignments:respond') });
  const assigned = !!review.data?.current_assignment;
  const handoffs = useQuery({ ...handoffsQuery(tenant, id), enabled: assigned });

  // The queue as the person last saw it, only from the cache: a direct link has no "{i} of {n}".
  const queue = useInfiniteQuery({ ...queueQuery(tenant, filters), enabled: false });
  const facets = useQuery({ ...facetsQuery(tenant, filters), enabled: false });
  const rows = search.from === 'queue' ? (queue.data?.pages.flatMap((p) => p.data) ?? []) : [];
  const index = rows.findIndex((r) => r.account_id === id);
  const others = rows.filter((r) => r.account_id !== id);
  const nextId = index >= 0 ? rows[index + 1]?.account_id : others[0]?.account_id;
  const open = (to: string) => void navigate({ to: '/t/$tenant/accounts/$id', params: { tenant, id: to }, search });
  const stepper: Stepper | null =
    index >= 0
      ? {
          index: index + 1,
          total: facets.data?.total ?? rows.length,
          onPrev: index > 0 ? () => open(rows[index - 1]!.account_id) : undefined,
          onNext: index < rows.length - 1 ? () => open(rows[index + 1]!.account_id) : undefined,
        }
      : null;

  const [sendBack, setSendBack] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);

  // C14: a refetch that shows someone else's assignment, send back or decline swaps the actions for who did it.
  // Adjusted while rendering when a new review arrives, so nothing waits for an effect.
  const [watch, setWatch] = useState<Watch>({ seen: undefined, base: null, own: false, decided: null });
  if (review.data && review.data !== watch.seen) setWatch(nextWatch(watch, review.data, statuses.data?.data ?? []));
  const decided = watch.decided;

  async function changed() {
    setWatch((w) => ({ ...w, own: true }));
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['account', tenant, id] }),
      queryClient.invalidateQueries({ queryKey: ['review-queue', tenant] }),
      queryClient.invalidateQueries({ queryKey: ['me-counts', tenant] }),
    ]);
  }

  if (account.isPending || (review.isPending && !review.isError)) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={i === 0 ? 28 : 14} soft={i % 2 === 1} />
          ))}
          <LoadingLine>Loading the brief, signals and buying committee</LoadingLine>
        </div>
      </div>
    );
  }

  const failed = account.error ?? review.error;
  if (failed || !account.data || !review.data) {
    if (failed instanceof ApiError && failed.status === 404) {
      return (
        <div className={styles.page}>
          <EmptyState
            title="This account isn't in your workspace, or you don't have access to it."
            icon={<Compass />}
            actions={
              search.from === 'queue' ? (
                <Link to="/t/$tenant/queue" params={{ tenant }} search={filters}>
                  Back to the review queue
                </Link>
              ) : search.from === 'my' ? (
                <Link to="/t/$tenant/my" params={{ tenant }}>
                  Back to My accounts
                </Link>
              ) : (
                <Link to="/t/$tenant/accounts" params={{ tenant }}>
                  Back to All accounts
                </Link>
              )
            }
          />
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <ErrorState
          title="This account didn't open"
          onRetry={() => {
            void account.refetch();
            void review.refetch();
          }}
          subject={id}
          {...(failed instanceof ApiError ? { errorRef: failed.ref } : {})}
          {...(nextId
            ? {
                actions: (
                  <Button size="sm" variant="secondary" onClick={() => open(nextId)}>
                    Open next account
                  </Button>
                ),
              }
            : {})}
        >
          {errorText(failed)}
        </ErrorState>
      </div>
    );
  }

  const a = account.data;
  const r = review.data;
  const source = r.sources[0];
  const dialogAccount: DialogAccount = {
    account_id: a.id,
    name: a.name,
    lead_offer: r.lead_offer ?? null,
    source: source ? { source_id: source.source_id, name: source.name, kind: source.kind, via: source.via } : null,
  };
  const latest = handoffs.data?.handoffs[0];

  async function retry() {
    setBusy(true);
    try {
      await retryPush(tenant, id);
      toast.show(`Sending ${a.name} to HubSpot again.`);
      await changed();
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <AccountHeader
        tenant={tenant}
        me={me}
        account={a}
        review={r}
        search={search}
        stepper={stepper}
        decided={decided}
        crmUrl={latest?.crm_url ?? null}
        busy={busy}
        onSendBack={() => setSendBack(true)}
        onAssign={() => setAssigning(true)}
        onRetry={() => void retry()}
        onMoved={() => void changed()}
      />
      {handoffs.data?.conflict && <ConflictNotice />}
      <StageTracker tenant={tenant} review={r} reviewer={hasScope(me, 'review:act')} />
      {r.current_assignment ? <AssignedView tenant={tenant} me={me} account={a} review={r} /> : <ReviewView tenant={tenant} me={me} account={a} review={r} />}

      {sendBack && (
        <SendBackDialog
          tenant={tenant}
          accounts={[dialogAccount]}
          onClose={() => setSendBack(false)}
          onDone={(sent) => {
            setSendBack(false);
            if (sent.length === 0) return;
            void changed();
            // The next account in the queue opens, or the queue when there is none.
            if (nextId) open(nextId);
            else void navigate({ to: '/t/$tenant/queue', params: { tenant }, search: filters });
          }}
        />
      )}
      {assigning && (
        <AssignDialog
          tenant={tenant}
          me={me}
          accounts={[dialogAccount]}
          onClose={() => setAssigning(false)}
          onDone={(done) => {
            setAssigning(false);
            if (done.length > 0) void changed();
          }}
        />
      )}
    </div>
  );
}
