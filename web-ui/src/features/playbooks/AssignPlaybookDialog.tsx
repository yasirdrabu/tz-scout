import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { offerPlaybooksQuery, offersQuery, practicesQuery, setOfferPlaybook, type OfferPlaybook } from '../offers/api';
import { errorText, LoadingRows, LoadFailed } from '../settings/shared';
import { TIER_WORD, type Tier } from './api';
import styles from './Playbooks.module.css';

const TIERS: Tier[] = ['act_now', 'good_fit', 'watch'];

type Props = {
  tenant: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playbook: { id: string; name: string };
};

/** §20 "Assign {playbook}": pick an active offer, then the tiers that should run this playbook. */
export function AssignPlaybookDialog({ tenant, open, onOpenChange, playbook }: Props) {
  const offers = useQuery({ ...offersQuery(tenant), enabled: open });
  const practices = useQuery({ ...practicesQuery(tenant), enabled: open });
  const active = (offers.data ?? []).filter((o) => o.status === 'approved');
  const [chosen, setChosen] = useState<string | null>(null);
  const offerId = chosen && active.some((o) => o.id === chosen) ? chosen : (active[0]?.id ?? null);
  const label = (o: { name: string; practice_id: string }) => {
    const practice = practices.data?.find((p) => p.id === o.practice_id);
    return practice ? `${o.name} · ${practice.name}` : o.name;
  };
  const offer = active.find((o) => o.id === offerId);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Assign ${playbook.name}`}
      description="Accounts matched to this offer and tier will start this playbook when an AE accepts them."
    >
      {offers.isPending ? (
        <LoadingRows rows={2}>Loading offers</LoadingRows>
      ) : offers.isError ? (
        <LoadFailed title="Offers didn't load" error={offers.error} onRetry={() => void offers.refetch()} />
      ) : !offer ? (
        <>
          <p className={styles.note}>No active offers yet. Make an offer active, then assign this playbook to it.</p>
          <div className={styles.formFooter}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.form}>
          <Field label="Offer">
            {(c) => (
              <select {...c} className="input" value={offer.id} onChange={(e) => setChosen(e.target.value)}>
                {active.map((o) => (
                  <option key={o.id} value={o.id}>
                    {label(o)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Tiers key={offer.id} tenant={tenant} offerId={offer.id} offerLabel={label(offer)} playbook={playbook} onDone={() => onOpenChange(false)} />
        </div>
      )}
    </Dialog>
  );
}

function Tiers({ tenant, offerId, offerLabel, playbook, onDone }: { tenant: string; offerId: string; offerLabel: string; playbook: Props['playbook']; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const current = useQuery(offerPlaybooksQuery(tenant, offerId));
  const [picked, setPicked] = useState<Partial<Record<Tier, boolean>>>({});
  const [busy, setBusy] = useState(false);

  if (current.isPending) return <LoadingRows rows={2}>Loading the tiers</LoadingRows>;
  if (current.isError) return <LoadFailed title="The tiers didn't load" error={current.error} onRetry={() => void current.refetch()} />;
  const entry = (t: Tier): OfferPlaybook | undefined => current.data.find((x) => x.tier === t);
  const uses = (t: Tier) => entry(t)?.playbook?.id === playbook.id;
  const checked = (t: Tier) => picked[t] ?? uses(t);
  const note = (t: Tier) => {
    const now = entry(t)?.playbook;
    return uses(t) ? 'Already uses this playbook' : now ? `Replaces ${now.name}` : 'No playbook now';
  };
  const added = TIERS.filter((t) => checked(t) && !uses(t));
  const removed = TIERS.filter((t) => !checked(t) && uses(t));
  const words = (ts: Tier[]) => ts.map((t) => TIER_WORD[t]).join(', ');

  async function assign() {
    if (!added.length && !removed.length) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      for (const t of added) await setOfferPlaybook(tenant, offerId, t, playbook.id);
      for (const t of removed) await setOfferPlaybook(tenant, offerId, t, null);
      toast.show(
        added.length
          ? `${playbook.name} now runs on ${offerLabel} · ${words(added)}.`
          : `${playbook.name} no longer runs on ${offerLabel} · ${words(removed)}.`,
      );
      onDone();
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['playbooks', tenant] }), queryClient.invalidateQueries({ queryKey: ['offers', tenant] })]);
    }
  }

  return (
    <>
      <fieldset className={styles.radios}>
        <legend className={styles.legendTitle}>Tiers</legend>
        {TIERS.map((t) => (
          <label key={t} className={styles.radio}>
            <input type="checkbox" checked={checked(t)} onChange={(e) => setPicked((p) => ({ ...p, [t]: e.target.checked }))} />
            <span>
              {TIER_WORD[t]}
              <span className={styles.note}> {note(t)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.formFooter}>
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void assign()} disabled={busy}>
          Assign
        </Button>
      </div>
    </>
  );
}
