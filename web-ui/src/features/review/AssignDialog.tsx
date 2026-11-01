import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, type Me } from '../../api/me';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { assign, bulk, previewAssign, sellersQuery, type BulkResult, type QueueRow, type Seller } from './api';
import { NOTE_MAX } from './ReasonPicker';
import styles from './Review.module.css';

export type AssignProps = {
  tenant: string;
  me: Me;
  /** One account (peek) or up to 50 (the bulk bar). */
  accounts: QueueRow[];
  onClose: () => void;
  /** After the API answered (202): the accounts assigned and the ones it refused, with its words. */
  onDone: (assigned: string[], refused: { account_id: string; message: string }[]) => void;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function focusOf(s: Seller): string {
  if (s.all_practices) return 'All practices';
  return s.practices.length > 0 ? s.practices.map((p) => p.name).join(', ') : 'No practice access yet';
}

/**
 * §6 Assign dialog: AE cards with the API's Best match, the ownership preflight for the picked AE,
 * a note, and the assign. The HubSpot send runs after it returns (202), so the toast says "Sending".
 */
export function AssignDialog({ tenant, me, accounts, onClose, onDone }: AssignProps) {
  const toast = useToast();
  const radios = useId();
  const ids = accounts.map((a) => a.account_id);
  const single = accounts.length === 1 ? accounts[0]! : null;
  const sellers = useQuery(sellersQuery(tenant, ids));
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = sellers.data?.data ?? [];
  const best = sellers.data?.best_match ?? null;
  const bestPickable = best && list.some((s) => s.user_id === best.user_id && s.crm_owner_linked) ? best.user_id : null;
  const sellerId = picked ?? bestPickable;
  const seller = list.find((s) => s.user_id === sellerId) ?? null;

  const previews = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['assign-preview', tenant, a.account_id, sellerId],
      queryFn: () => previewAssign(tenant, a.account_id, sellerId!),
      enabled: sellerId !== null,
      retry: false,
      gcTime: 0,
    })),
  });
  const failed = previews.find((p) => p.isError)?.error ?? null;
  const unavailable = failed instanceof ApiError && failed.status === 503;
  const checking = sellerId !== null && previews.some((p) => p.isPending);
  const stops = accounts.flatMap((a, i) => {
    const p = previews[i]?.data?.preflight;
    return p?.result === 'stop' ? [{ name: a.name, message: p.message }] : [];
  });
  const blocked = previews.some((p) => p.data?.preflight.result === 'blocked');

  const what = single ? single.name : `${accounts.length} accounts`;
  const title = single ? `Assign ${single.name}` : `Assign ${accounts.length} accounts`;
  const offer = single?.lead_offer;
  const sub = single ? [offer?.name, offer?.practice_name].filter(Boolean).join(' · ') : accounts.map((a) => a.name).join(', ');
  const sentence = !seller
    ? null
    : stops.length > 0
      ? `Scout sends ${what} to HubSpot and leaves the current HubSpot owner as owner.`
      : `Scout sends ${what} to HubSpot with ${seller.name} as owner and logs the brief.`;
  const ready = !!seller && seller.crm_owner_linked && !checking && !failed && !blocked && !busy;

  async function submit() {
    if (!seller) return;
    setBusy(true);
    setError(null);
    const body = {
      seller_user_id: seller.user_id,
      ...(note.trim() ? { notes: note.trim() } : {}),
      ...(stops.length > 0 ? { ownership_decision: 'keep' as const } : {}),
    };
    try {
      if (single) {
        await assign(tenant, single.account_id, body);
        toast.show(`Assigned to ${seller.name}. Sending ${single.name} to HubSpot.`);
        onDone([single.account_id], []);
      } else {
        const { results } = await bulk(tenant, ids, { action: 'assign', ...body });
        const done = results.filter((r) => r.ok).map((r) => r.account_id);
        const refused = results.filter((r): r is Extract<BulkResult, { ok: false }> => !r.ok).map((r) => ({ account_id: r.account_id, message: r.message }));
        if (done.length > 0) {
          toast.show(
            done.length === 1
              ? `Assigned 1 account to ${seller.name}. Sending it to HubSpot.`
              : `Assigned ${done.length} accounts to ${seller.name}. Sending them to HubSpot.`,
          );
        }
        onDone(done, refused);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      {...(sub ? { description: sub } : {})}
      width={620}
      footer={
        <div className={styles.dialogFoot}>
          <span className={styles.footSentence}>{sentence}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready}>
            {seller ? `Assign to ${seller.name}` : 'Assign'}
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        {sellers.isPending ? (
          <p className={styles.note}>Loading account executives</p>
        ) : sellers.isError ? (
          <p role="alert" className={styles.error}>
            {errorText(sellers.error)}
          </p>
        ) : list.length === 0 ? (
          <p className={styles.note}>No one can take assignments yet. Add an account executive in Settings &gt; Members.</p>
        ) : (
          <fieldset className={styles.cards}>
            <legend className={styles.label}>Account executive</legend>
            {list.map((s) => {
              const isBest = best?.user_id === s.user_id;
              return (
                <label key={s.user_id} className={styles.aeCard}>
                  <input
                    type="radio"
                    name={radios}
                    checked={s.user_id === sellerId}
                    disabled={!s.crm_owner_linked}
                    onChange={() => setPicked(s.user_id)}
                  />
                  <Avatar name={s.name} decorative />
                  <span className={styles.aeText}>
                    <span className={styles.aeName}>
                      {s.name}
                      {isBest && <span className={styles.best}>Best match</span>}
                    </span>
                    <span className={styles.muted}>{focusOf(s)}</span>
                    {isBest && best && <span className={styles.muted}>{best.reason}</span>}
                    {!s.crm_owner_linked && (
                      <span className={styles.muted}>
                        No HubSpot user linked
                        {hasScope(me, 'members:manage') && (
                          <>
                            {' · '}
                            <Link to="/t/$tenant/settings/$tab" params={{ tenant, tab: 'members' }}>
                              Link in Members
                            </Link>
                          </>
                        )}
                      </span>
                    )}
                  </span>
                  <span className={styles.load}>
                    <strong>{s.active_accounts}</strong>
                    active accounts
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {seller && unavailable && (
          <div role="alert" className={styles.blocked}>
            HubSpot isn&apos;t answering, so Scout can&apos;t check who owns this company. Try again in a moment.{' '}
            <Button size="sm" variant="secondary" onClick={() => previews.forEach((p) => p.isError && void p.refetch())}>
              Try again
            </Button>
          </div>
        )}
        {seller && failed && !unavailable && (
          <p role="alert" className={styles.blocked}>
            {errorText(failed)}
          </p>
        )}
        {seller && blocked && (
          <p role="alert" className={styles.blocked}>
            {`${seller.name} has no HubSpot user linked, so Scout can't make them the owner. Link their HubSpot user in Settings > Members, or pick another AE.`}
          </p>
        )}
        {seller && stops.length > 0 && (
          <div role="alert" className={styles.warn}>
            <span>
              <strong>Scout can&apos;t take over the HubSpot owner</strong>
              {single ? (
                <span>{`${stops[0]!.message}. Scout will send the account and leave the current owner. Ask them to hand it over if ${firstName(seller.name)} should lead.`}</span>
              ) : (
                <ul>
                  {stops.map((s) => (
                    <li key={s.name}>{`${s.name}: ${s.message}`}</li>
                  ))}
                </ul>
              )}
            </span>
          </div>
        )}
        {checking && <p className={styles.note}>Checking who owns this in HubSpot</p>}

        {seller && (
          <Field label={`Note for ${firstName(seller.name)}`}>
            {(c) => (
              <textarea
                {...c}
                className="input"
                placeholder="What should they know first?"
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
