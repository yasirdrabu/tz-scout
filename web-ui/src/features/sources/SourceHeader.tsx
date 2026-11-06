import { Link } from '@tanstack/react-router';
import { useFormat } from '../../lib/useFormat';
import { initialsOf } from '../../ui/Avatar';
import { Button, buttonClass } from '../../ui/Button';
import { Pill } from '../../ui/Pill';
import type { SourceDetail } from './api';
import styles from './Sources.module.css';

type Props = {
  tenant: string;
  source: SourceDetail;
  /** Pause, Resume and Sync now are for people with sources:manage; an archived source is read only. */
  canAct: boolean;
  busy: boolean;
  onPause: () => void;
  onSync: () => void;
};

/** "Owned by {owner} · {method} · Part of {parent} · Last sent {when}", leaving out what is missing ("No owner" when none). */
export function ownerLine(s: SourceDetail, lastSent: (at: string) => string): string {
  return [
    s.owner ? `Owned by ${s.owner.name}` : 'No owner',
    s.method_label,
    s.parent ? `Part of ${s.parent.name}` : null,
    s.last_sent_at ? `Last sent ${lastSent(s.last_sent_at)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** §11 header: the breadcrumb, initials tile, name, kind and status, the owner line, and the actions. */
export function SourceHeader({ tenant, source: s, canAct, busy, onPause, onSync }: Props) {
  const f = useFormat();
  const archived = s.status === 'archived';
  const crumbs = s.breadcrumb.slice(0, -1);
  const tone = s.status === 'active' ? 'good' : s.status === 'paused' ? 'near' : 'neutral';
  return (
    <>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>
            <Link to="/t/$tenant/sources" params={{ tenant }}>
              Sources
            </Link>
          </li>
          {crumbs.map((c) => (
            <li key={c.id}>
              <Link to="/t/$tenant/sources/$id" params={{ tenant, id: c.id }}>
                {c.name}
              </Link>
            </li>
          ))}
          <li aria-current="page">{s.name}</li>
        </ol>
      </nav>
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.tile} aria-hidden="true">
            {initialsOf(s.name)}
          </span>
          <div className={styles.grow}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{s.name}</h1>
              <span className={styles.sub}>{s.kind_label}</span>
              <Pill tone={tone}>{s.status === 'active' && s.is_new ? 'New' : s.status_label}</Pill>
            </div>
            <p className={styles.meta}>{ownerLine(s, (at) => f.relative(at))}</p>
          </div>
          <div className={styles.actions}>
            <Link to="/t/$tenant/funnel/$sourceId" params={{ tenant, sourceId: s.id }} className={buttonClass('secondary', 'sm')}>
              See in funnel
            </Link>
          </div>
          {canAct && !archived && (
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" disabled={busy} onClick={onPause}>
                {s.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
              {s.kind === 'list' && (
                <Link to="/t/$tenant/batches/import" params={{ tenant }} search={{ source: s.id }} className={buttonClass('primary', 'sm')}>
                  Import a list
                </Link>
              )}
              {s.kind === 'crm' && (
                <Button size="sm" disabled={busy} onClick={onSync}>
                  Sync now
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
