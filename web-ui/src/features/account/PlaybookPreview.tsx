import { useQuery } from '@tanstack/react-query';
import { hasScope, type Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { Card } from '../../ui/Card';
import { OWNER_WORD, playbookQuery, span } from '../playbooks/api';
import { playbookSuggestionQuery } from '../review/api';
import { planQuery } from './api';
import { errorText } from '../settings/shared';
import styles from './Account.module.css';

/** §4a: the playbook Scout would start on assignment and its steps, none started yet (Ruling 11). */
export function PlaybookPreview({ tenant, accountId, me }: { tenant: string; accountId: string; me: Me }) {
  const allowed = hasScope(me, 'assign:act') && hasScope(me, 'playbooks:read');
  const plan = useQuery({ ...planQuery(tenant, accountId), enabled: allowed });
  const hasOpenPlan = plan.data?.status === 'active' || plan.data?.status === 'paused';
  const suggestion = useQuery({ ...playbookSuggestionQuery(tenant, accountId), enabled: allowed });
  const pick = suggestion.data?.playbook ?? null;
  const detail = useQuery({ ...playbookQuery(tenant, pick?.id ?? ''), enabled: allowed && !!pick });
  // An open plan resumes on accept, so there is nothing new to preview; wait for the plan answer before showing one.
  if (!allowed || !pick || plan.isPending || hasOpenPlan) return null;
  const steps = detail.data?.steps ?? [];
  return (
    <Card title="Playbook">
      {detail.isPending ? (
        <p className={styles.note}>Loading playbook</p>
      ) : detail.isError ? (
        <p className={styles.error} role="alert">{`Playbook didn't load. ${errorText(detail.error)}`}</p>
      ) : (
        <>
          <p className={cx(styles.muted, styles.small)}>{`${pick.name} · ${span(pick.steps, pick.days)} · starts when accepted`}</p>
          <ul className={styles.rows}>
            {steps.map((s) => (
              <li key={s.id}>
                <span className={styles.when}>{`Day ${s.day + 1}`}</span>
                <span className={styles.grow}>{s.title}</span>
                <span>{OWNER_WORD[s.owner_role]}</span>
                <span className={styles.muted}>Not started</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
