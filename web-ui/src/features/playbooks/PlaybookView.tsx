import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, meQuery } from '../../api/me';
import page from '../../routes/Page.module.css';
import { useFormat } from '../../lib/useFormat';
import { Button, buttonClass } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Pill } from '../../ui/Pill';
import { useToast } from '../../ui/Toast';
import { offersQuery, practicesQuery, setOfferPlaybook } from '../offers/api';
import { errorText, LoadFailed, LoadingRows, useRun } from '../settings/shared';
import {
  archivePlaybook,
  CHANNEL_WORD,
  deletePlaybook,
  duplicatePlaybook,
  OWNER_WORD,
  pct,
  playbookQuery,
  rate,
  span,
  STATUS_WORD,
  statusTone,
  STOP_WORD,
  TIER_TONE,
  TIER_WORD,
  type PlaybookDetail,
  type Tier,
} from './api';
import { AssignPlaybookDialog } from './AssignPlaybookDialog';
import { PlaybookForm } from './PlaybookForm';
import styles from './Playbooks.module.css';
import { WhatWorked } from './WhatWorked';
import type { PlaybooksSearch } from '../../routes/workspace';

type Props = { tenant: string; id: string; canManage: boolean };

/** §20 detail: tiles, what worked, steps, where it runs and the rules. */
export function PlaybookView({ tenant, id, canManage }: Props) {
  const f = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const playbook = useQuery(playbookQuery(tenant, id));
  const offers = useQuery(offersQuery(tenant));
  const me = useQuery(meQuery(tenant));
  const practices = useQuery(practicesQuery(tenant));
  const [confirm, setConfirm] = useState<'retire' | 'delete' | null>(null);
  /** The API's words when a delete is refused, so the dialog can offer Retire. */
  const [blocked, setBlocked] = useState<string | null>(null);
  const act = useRun();
  const search = useSearch({ strict: false }) as PlaybooksSearch;
  const [deleting, setDeleting] = useState(false);

  if (playbook.isPending) return <LoadingRows>Loading the playbook</LoadingRows>;
  if (playbook.isError) return <LoadFailed title="This playbook didn't load" error={playbook.error} onRetry={() => void playbook.refetch()} />;
  const p: PlaybookDetail = playbook.data;
  const r = p.results;
  const accounts = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);
  const canSeeWorked = !!me.data && hasScope(me.data, 'analytics:read');
  const retired = p.status === 'archived';
  const canDelete = p.running === 0 && p.runs_on.length === 0 && !retired;
  const tiers = p.runs_on.length;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['playbooks', tenant] });

  const closeForm = () => void navigate({ to: '.', search: {}, replace: true });
  const close = (open: boolean) => {
    if (open) return;
    setConfirm(null);
    setBlocked(null);
  };

  async function duplicate() {
    let copy: PlaybookDetail | undefined;
    const ok = await act.run(async () => (copy = await duplicatePlaybook(tenant, p.id)), (c) => `${c.name} created as a draft.`);
    if (!ok || !copy) return;
    await refresh();
    void navigate({ to: '/t/$tenant/playbooks/$id', params: { tenant, id: copy.id } });
  }

  async function retire() {
    const ok = await act.run(() => archivePlaybook(tenant, p.id), `${p.name} retired.`);
    close(false);
    if (!ok) return;
    await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['offers', tenant] })]);
  }

  async function remove() {
    setDeleting(true);
    try {
      await deletePlaybook(tenant, p.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setBlocked(errorText(e));
      else {
        toast.show(errorText(e));
        close(false);
      }
      return;
    } finally {
      setDeleting(false);
    }
    toast.show(`${p.name} deleted.`);
    close(false);
    queryClient.removeQueries({ queryKey: ['playbooks', tenant, 'one', p.id] });
    await refresh();
    void navigate({ to: '/t/$tenant/playbooks', params: { tenant } });
  }

  const retireText = tiers
    ? `It will be removed from ${tiers} offer ${tiers === 1 ? 'tier' : 'tiers'}. Accounts already running it keep going.`
    : 'No offer tier uses it. Accounts already running it keep going.';
  const tile = (label: string, value: ReactNode, note?: string) => (
    <li className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {note && <span className={styles.note}>{note}</span>}
    </li>
  );
  const offerOf = (offerId: string) => offers.data?.find((o) => o.id === offerId);
  const unassign = (offerId: string, tier: Tier, offerName: string) =>
    act
      .run(() => setOfferPlaybook(tenant, offerId, tier, null), `${p.name} removed from ${offerName} · ${TIER_WORD[tier]}.`)
      .then(async (ok) => {
        if (ok) await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['offers', tenant] })]);
      });

  return (
    <section aria-labelledby="playbook-name" className={styles.view}>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>
            <Link to="/t/$tenant/playbooks" params={{ tenant }}>
              Playbooks
            </Link>
          </li>
          <li aria-current="page">{p.name}</li>
        </ol>
      </nav>
      <div className={styles.head}>
        <div className={styles.grow}>
          <div className={styles.titleRow}>
            <h1 id="playbook-name" className={page.title}>
              {p.name}
            </h1>
            <Pill tone={statusTone(p.status)}>{STATUS_WORD[p.status]}</Pill>
          </div>
          {p.description && <p className={styles.meta}>{p.description}</p>}
          <p className={styles.meta}>Updated {f.date(p.updated_at)}</p>
        </div>
        {canManage && (
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" onClick={() => void duplicate()} disabled={act.busy}>
              Duplicate
            </Button>
            {canDelete ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirm('delete')}>
                Delete
              </Button>
            ) : (
              !retired && (
                <Button size="sm" variant="ghost" onClick={() => setConfirm('retire')}>
                  Retire
                </Button>
              )
            )}
            <Link to="/t/$tenant/playbooks/$id" params={{ tenant, id: p.id }} search={{ edit: 'playbook' }} className={buttonClass('secondary', 'sm')}>
              Edit playbook
            </Link>
          </div>
        )}
      </div>

      <div>
        <ul className={styles.tiles} aria-label="Playbook numbers">
          {tile('Running now', p.running, 'Accounts mid-playbook')}
          {tile('Finished', r.finished, 'Last 90 days')}
          {tile('Replied', pct(rate(r.replied, r.finished)), r.finished ? accounts(r.replied) : undefined)}
          {tile('Booked a meeting', pct(rate(r.meetings, r.finished)), r.finished ? accounts(r.meetings) : undefined)}
          {tile('Won', r.won, r.finished ? `${rate(r.won, r.finished)}% of finished` : 'None yet')}
        </ul>
      </div>

      {canSeeWorked && <WhatWorked tenant={tenant} templateId={p.id} />}

      <section aria-labelledby="steps-title">
        <h2 id="steps-title" className={styles.sectionTitle}>
          Steps
        </h2>
        <p className={styles.note}>{span(p.step_count, p.days)}</p>
        <ol className={styles.steps}>
          {p.steps.map((s) => (
            <li key={s.id} className={styles.step}>
              <span className={styles.day}>Day {s.day + 1}</span>
              <div>
                <div className={styles.stepTitle}>{s.title}</div>
                <p className={styles.meta}>{s.detail || 'No detail yet.'}</p>
                <p className={styles.meta}>
                  {CHANNEL_WORD[s.channel]} · {OWNER_WORD[s.owner_role]}
                </p>
              </div>
              {(s.channel === 'email' || s.crm_task) && (
                <span className={styles.tags}>
                  {s.channel === 'email' && <span className={styles.tag}>Draft ready for AE</span>}
                  {s.crm_task && <span className={styles.tag}>HubSpot task</span>}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <Card
        title="Runs on"
        actions={
          canManage && p.status === 'active' ? (
            <Link to="/t/$tenant/playbooks/$id" params={{ tenant, id: p.id }} search={{ assign: 'offer' }} className={buttonClass('secondary', 'sm')}>
              Assign
            </Link>
          ) : undefined
        }
      >
        {p.runs_on.length ? (
          <ul className={styles.rows}>
            {p.runs_on.map((r) => {
              const offer = offerOf(r.offer_id);
              const practice = practices.data?.find((x) => x.id === offer?.practice_id);
              return (
                <li key={`${r.offer_id}:${r.tier}`}>
                  <strong>{offers.isPending ? null : (offer?.name ?? 'Unknown offer')}</strong>
                  {practice && <span className={styles.meta}>{practice.name}</span>}
                  <Pill tone={TIER_TONE[r.tier]}>{TIER_WORD[r.tier]}</Pill>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={act.busy}
                      aria-label={`Remove from ${offer?.name ?? 'offer'} ${TIER_WORD[r.tier]}`}
                      onClick={() => void unassign(r.offer_id, r.tier, offer?.name ?? 'the offer')}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.note}>
            {p.status === 'draft'
              ? 'Make it active to assign it to an offer and tier.'
              : 'Not assigned to any offer yet, so no accounts will start it. Assign it to an offer and tier.'}
          </p>
        )}
      </Card>

      <Card title="Rules">
        <dl className={styles.rules}>
          <dt>Starts when</dt>
          <dd>When an AE accepts an account matched to its offer and tier.</dd>
          <dt>Stops when</dt>
          <dd>{STOP_WORD[p.stop_when]}</dd>
          <dt>Pauses when</dt>
          <dd>When the assignment is withdrawn, or someone pauses it.</dd>
          <dt>Drafts</dt>
          <dd>Scout drafts each email for the AE to review and send.</dd>
        </dl>
      </Card>

      <ConfirmDialog
        open={confirm === 'retire' || (confirm === 'delete' && blocked !== null)}
        onOpenChange={close}
        title={`Retire ${p.name}?`}
        description={blocked ? `${blocked} ${retireText}` : retireText}
        confirmLabel="Retire playbook"
        busy={act.busy}
        onConfirm={() => void retire()}
      />
      <ConfirmDialog
        open={confirm === 'delete' && blocked === null}
        onOpenChange={close}
        title={`Delete ${p.name}?`}
        description="It never ran on an account and no offer uses it. You can't undo this."
        confirmLabel="Delete playbook"
        busy={deleting}
        onConfirm={() => void remove()}
      />
      {canManage && (
        <>
          <PlaybookForm tenant={tenant} open={search.edit === 'playbook'} mode="edit" id={p.id} onClose={closeForm} />
          <AssignPlaybookDialog tenant={tenant} open={search.assign === 'offer' && p.status === 'active'} onOpenChange={(o) => !o && closeForm()} playbook={p} />
        </>
      )}
    </section>
  );
}
