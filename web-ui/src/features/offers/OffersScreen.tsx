import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { hasScope, meQuery } from '../../api/me';
import page from '../../routes/Page.module.css';
import type { OffersSearch } from '../../routes/workspace';
import { EmptyState } from '../../ui/EmptyState';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { offersQuery, practicesQuery } from './api';
import { OfferForm } from './OfferForm';
import { OfferView } from './OfferView';
import { PracticeForm } from './PracticeForm';
import { PracticeTree } from './PracticeTree';
import { PracticeView } from './PracticeView';
import styles from './Offers.module.css';

/**
 * §19 Offers and practices: the tree on the left, a practice or an offer on the right, and the forms in a
 * drawer. The URL carries what is open and which form (`edit`), so a link or a reload keeps the place (C10).
 */
export function OffersScreen() {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as OffersSearch;
  const navigate = useNavigate();
  const tenant = params.tenant!;
  const { data: me } = useQuery(meQuery(tenant));
  const practices = useQuery(practicesQuery(tenant));
  const offers = useQuery(offersQuery(tenant));
  const canManage = !!me && hasScope(me, 'offers:manage');
  const canPick = canManage || (!!me && hasScope(me, 'playbooks:manage'));
  const canOpenPlaybooks = !!me && hasScope(me, 'playbooks:read');

  const list = practices.data ?? [];
  const practiceId = params.practiceId ?? list[0]?.id;
  const offerId = params.offerId;

  /** Opens or closes a form, keeping what is open. */
  const edit = (next: OffersSearch) => void navigate({ to: '.', search: next, replace: !next.edit });
  const close = () => edit({});

  return (
    <div className={page.page}>
      <h1 className={page.title}>Offers and practices</h1>
      {practices.isPending || offers.isPending ? (
        <LoadingRows>Loading offers</LoadingRows>
      ) : practices.isError || offers.isError ? (
        <LoadFailed
          title="Offers didn't load"
          error={practices.error ?? offers.error}
          onRetry={() => {
            void practices.refetch();
            void offers.refetch();
          }}
        />
      ) : (
        <div className={styles.layout}>
          <PracticeTree
            tenant={tenant}
            practices={list}
            offers={offers.data}
            practiceId={practiceId}
            offerId={offerId}
            canManage={canManage}
            onNewPractice={() => edit({ edit: 'new-practice' })}
            onAddOffer={(id) => void navigate({ to: '/t/$tenant/offers/$practiceId', params: { tenant, practiceId: id }, search: { edit: 'new-offer' } })}
          />
          <div className={styles.content}>
            {offerId && practiceId ? (
              <OfferView tenant={tenant} offerId={offerId} canManage={canManage} canPick={canPick} canOpenPlaybooks={canOpenPlaybooks} onEdit={(field) => edit({ edit: 'offer', ...(field ? { field } : {}) })} onDuplicate={() => edit({ edit: 'new-offer', copy: offerId })} />
            ) : practiceId ? (
              <PracticeView
                tenant={tenant}
                practiceId={practiceId}
                listed={list.find((p) => p.id === practiceId)}
                offers={offers.data.filter((o) => o.practice_id === practiceId)}
                canManage={canManage}
                onEdit={() => edit({ edit: 'practice' })}
                onAddOffer={() => edit({ edit: 'new-offer' })}
              />
            ) : (
              <EmptyState title="No practices yet">{canManage ? 'Add a practice, then the offers it sells.' : 'Practices show here once someone adds them.'}</EmptyState>
            )}
          </div>
        </div>
      )}
      {canManage && (
        <>
          <OfferForm
            tenant={tenant}
            open={search.edit === 'offer' || search.edit === 'new-offer'}
            mode={search.edit === 'offer' ? 'edit' : 'new'}
            offerId={search.edit === 'offer' ? offerId : search.copy}
            practiceId={practiceId}
            practices={list}
            field={search.field}
            onClose={close}
          />
          <PracticeForm
            tenant={tenant}
            open={search.edit === 'practice' || search.edit === 'new-practice'}
            practice={search.edit === 'practice' ? list.find((p) => p.id === practiceId) : undefined}
            onClose={close}
          />
        </>
      )}
    </div>
  );
}
