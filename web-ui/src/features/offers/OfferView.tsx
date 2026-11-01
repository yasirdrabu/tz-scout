import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Pill } from '../../ui/Pill';
import { LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { deleteOffer, offerQuery, offerStatsQuery, practiceQuery, retireOffer, statusTone, type OfferDetail } from './api';
import styles from './Offers.module.css';

/** The sections in the order screens.md gives them, with the API field each one is (Decision 16). */
export const SECTIONS = [
  { field: 'promise', label: 'Summary' },
  { field: 'description', label: 'Ideal customer' },
  { field: 'key_offer', label: 'Key offer' },
  { field: 'why_us', label: 'Why us' },
  { field: 'why_now', label: 'Why now' },
] as const;

export type SectionField = (typeof SECTIONS)[number]['field'];

type Props = {
  tenant: string;
  offerId: string;
  canManage: boolean;
  /** Opens the form, at a section when one is given. */
  onEdit: (field?: SectionField) => void;
  onDuplicate: () => void;
};

/**
 * §19 Offer view: breadcrumb, title, status and "Updated", the actions, the price line, the current stats,
 * the sections and the proof points. Playbook by tier, the initial message and the seller guide are R2 and
 * not rendered.
 */
export function OfferView({ tenant, offerId, canManage, onEdit, onDuplicate }: Props) {
  const f = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const offer = useQuery(offerQuery(tenant, offerId));
  const practice = useQuery({ ...practiceQuery(tenant, offer.data?.practice_id ?? ''), enabled: !!offer.data });
  const stats = useQuery(offerStatsQuery(tenant));
  const [confirming, setConfirming] = useState(false);
  const act = useRun();

  if (offer.isPending) return <LoadingRows>Loading the offer</LoadingRows>;
  if (offer.isError) return <LoadFailed title="This offer didn't load" error={offer.error} onRetry={() => void offer.refetch()} />;
  const o: OfferDetail = offer.data;
  const stat = stats.data?.get(o.id);
  const retired = o.status === 'archived';
  const practiceName = practice.data?.name ?? '';

  async function retireOrDelete() {
    const deleting = o.can_delete;
    const ok = await act.run<unknown>(() => (deleting ? deleteOffer(tenant, o.id) : retireOffer(tenant, o.id)), deleting ? `${o.name} deleted.` : `${o.name} retired.`);
    setConfirming(false);
    if (!ok) return;
    if (deleting) {
      queryClient.removeQueries({ queryKey: ['offers', tenant, 'one', o.id] });
      void navigate({ to: '/t/$tenant/offers/$practiceId', params: { tenant, practiceId: o.practice_id } });
    }
    await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
  }

  const updated = [`Updated ${f.date(o.updated_at)}`, o.practice_lead_name ? `Practice lead ${o.practice_lead_name}` : null].filter(Boolean).join(' · ');
  const tile = (label: string, value: string) => (
    <li className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </li>
  );

  return (
    <section aria-labelledby="offer-name" className={styles.view}>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>
            <Link to="/t/$tenant/offers/$practiceId" params={{ tenant, practiceId: o.practice_id }}>
              {practiceName}
            </Link>
          </li>
          <li aria-current="page">Offer</li>
        </ol>
      </nav>
      <div className={styles.viewHead}>
        <div className={styles.grow}>
          <div className={styles.titleRow}>
            <h2 id="offer-name" className={styles.viewTitle}>
              {o.name}
            </h2>
            <Pill tone={statusTone(o.status)}>{o.status_label}</Pill>
          </div>
          <p className={styles.meta}>{updated}</p>
        </div>
        {canManage && (
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" onClick={onDuplicate}>
              Duplicate
            </Button>
            {!retired && (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                {o.can_delete ? 'Delete' : 'Retire'}
              </Button>
            )}
            {!retired && (
              <Button size="sm" variant="secondary" onClick={() => onEdit()}>
                Edit offer
              </Button>
            )}
          </div>
        )}
      </div>

      {o.price_label && (
        <div>
          <span className={styles.eyebrow}>Price</span>
          <p className={styles.price}>{o.price_label}</p>
        </div>
      )}

      <div>
        <ul className={styles.tiles} aria-label="Offer numbers">
          {tile('Accounts matched', stat ? f.number(stat.matched) : '')}
          {tile('Won', stat ? f.number(stat.won) : '')}
          {tile('Win rate', stat ? (stat.win_rate === null ? 'None yet' : `${stat.win_rate}%`) : '')}
        </ul>
        <p className={styles.note}>Current, not yet attributed to outcomes</p>
        <Link to="/t/$tenant/accounts" params={{ tenant }} search={{ offer: o.id }} className={styles.link}>
          See accounts for this offer
        </Link>
      </div>

      {SECTIONS.map((s) => {
        const text = o[s.field];
        return (
          <section key={s.field} className={styles.section} aria-label={s.label}>
            <h3 className={styles.sectionTitle}>{s.label}</h3>
            {text ? (
              <p className={styles.prose}>{text}</p>
            ) : canManage && !retired ? (
              <p className={styles.note}>
                Not written yet.{' '}
                <button type="button" className={styles.inlineLink} onClick={() => onEdit(s.field)}>
                  Add it
                </button>
              </p>
            ) : (
              <p className={styles.note}>Not written yet.</p>
            )}
          </section>
        );
      })}

      <section className={styles.section} aria-label="Proof points">
        <h3 className={styles.sectionTitle}>Proof points</h3>
        {o.proof_points.length ? (
          <ul className={styles.bullets}>
            {o.proof_points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>Not written yet.</p>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={o.can_delete ? `Delete ${o.name}?` : `Retire ${o.name}?`}
        description={
          o.can_delete ? 'It never matched an account, so nothing else changes.' : "Scout stops matching accounts to it. Accounts already matched keep it. You can't undo this."
        }
        confirmLabel={o.can_delete ? 'Delete offer' : 'Retire offer'}
        busy={act.busy}
        onConfirm={() => void retireOrDelete()}
      />
    </section>
  );
}
