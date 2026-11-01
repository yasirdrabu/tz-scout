import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { hasScope, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { briefQuery, draftBrief, saveSection, type Brief, type BriefSection, type WrittenBy } from './api';
import styles from './Account.module.css';

/** The API's "Written by Claude", "Assembled from rules", "Edited by {name}" or "Sample output". */
export function WrittenTag({ by, label }: { by: WrittenBy | null; label: string | null }) {
  if (!label) return null;
  return <span className={cx(styles.tag, by && styles[`tag_${by}`])}>{label}</span>;
}

/** True before Scout's first draft: no section has text yet. */
export const notDrafted = (b: Brief) => b.state === 'not_drafted' && b.sections.every((s) => s.body === null);

/** §4a 1. Scout's recommendation (sparkle); nothing while the brief has none. */
export function Recommendation({ tenant, id }: { tenant: string; id: string }) {
  const brief = useQuery(briefQuery(tenant, id));
  const r = brief.data?.recommendation;
  if (!r) return null;
  return (
    <section className={cx(styles.card, styles.recommend, styles.section)} aria-labelledby="acct-rec">
      <div className={styles.sectionHead}>
        <Sparkles className={styles.sparkle} aria-hidden="true" />
        <h2 id="acct-rec" className={styles.sectionTitle}>
          Scout&apos;s recommendation
        </h2>
        <span className={styles.grow} />
        <WrittenTag by={r.written_by} label={r.label} />
      </div>
      <p className={styles.headline}>{r.headline}</p>
      <p className={styles.text}>{r.detail}</p>
    </section>
  );
}

/** §4a 6. The brief's four sections, each with who wrote it; `Edit` for people with `playbooks:write`. */
export function BriefCard({ tenant, me, id, readOnly = false }: { tenant: string; me: Me; id: string; readOnly?: boolean }) {
  const f = useFormat();
  const brief = useQuery(briefQuery(tenant, id));
  const b = brief.data;
  return (
    <Card title="Brief" actions={b?.last_drafted_at ? <span className={cx(styles.muted, styles.small)}>{`Last drafted ${f.dateTime(b.last_drafted_at)}`}</span> : undefined}>
      {brief.isPending ? (
        <p className={styles.note}>Loading the brief</p>
      ) : brief.isError ? (
        <p className={styles.error} role="alert">
          {`The brief didn't load. ${errorText(brief.error)}`}{' '}
          <button type="button" className={styles.textButton} onClick={() => void brief.refetch()}>
            Try again
          </button>
        </p>
      ) : notDrafted(b!) ? (
        <p className={styles.note}>Overview, approach, value angle and risks get drafted once Scout has at least two signals.</p>
      ) : (
        <>
          {b!.state === 'drafting' && (
            <p className={styles.note} role="status">
              Scout is redrafting this brief
            </p>
          )}
          {b!.sections.map((s) => (
            <SectionView key={s.key} tenant={tenant} id={id} brief={b!} section={s} canEdit={!readOnly && hasScope(me, 'playbooks:write')} />
          ))}
        </>
      )}
    </Card>
  );
}

function SectionView({ tenant, id, brief, section, canEdit }: { tenant: string; id: string; brief: Brief; section: BriefSection; canEdit: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const key = briefQuery(tenant, id).queryKey;
  const textId = `brief-${section.key}`;

  async function save() {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveSection(tenant, id, section.key, draft, section.version);
      queryClient.setQueryData(key, (old) => (old ? { ...old, sections: old.sections.map((s) => (s.key === saved.key ? saved : s)) } : old));
      setDraft(null);
      toast.show(`${section.title} saved`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function redraft() {
    setBusy(true);
    try {
      await draftBrief(tenant, id, [section.key]);
      setConfirm(false);
      queryClient.setQueryData(key, (old) => (old ? { ...old, state: 'drafting' as const } : old));
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.briefSection} aria-labelledby={`${textId}-title`}>
      <div className={styles.briefHead}>
        <h3 id={`${textId}-title`} className={styles.briefTitle}>
          {section.title}
        </h3>
        <WrittenTag by={section.written_by} label={section.label} />
        {section.written_for_offer_name && (
          <span className={cx(styles.muted, styles.small)}>
            {`Written for ${section.written_for_offer_name}`}
            {canEdit && (
              <>
                {' · '}
                <button type="button" className={styles.textButton} onClick={() => setConfirm(true)} aria-label={`Redraft ${section.title}`}>
                  Redraft
                </button>
              </>
            )}
          </span>
        )}
        <span className={styles.grow} />
        {canEdit && draft === null && (
          <Button size="sm" variant="ghost" aria-label={`Edit ${section.title}`} onClick={() => setDraft(section.body ?? '')}>
            Edit
          </Button>
        )}
      </div>
      {draft === null ? (
        <p className={styles.text}>{section.body ?? 'Not drafted yet.'}</p>
      ) : (
        <div className={styles.form}>
          <label htmlFor={textId} className="sr-only">
            {section.title}
          </label>
          <textarea
            id={textId}
            className={cx('input', styles.textarea)}
            value={draft}
            maxLength={4000}
            aria-describedby={`${textId}-hint${error ? ` ${textId}-error` : ''}`}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p id={`${textId}-hint`} className={styles.note}>
            Saving marks this section as edited by you.
          </p>
          {error && (
            <p id={`${textId}-error`} className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Redraft ${section.title}?`}
        description={`Scout rewrites this section for ${brief.offer_name ?? 'the current offer'}. Your edited version stays in the history.`}
        confirmLabel="Redraft"
        onConfirm={() => void redraft()}
        busy={busy}
      />
    </section>
  );
}
