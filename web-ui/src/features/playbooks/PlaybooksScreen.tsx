import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { hasScope, meQuery } from '../../api/me';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { PlaybookList } from './PlaybookList';
import { PlaybookView } from './PlaybookView';
import styles from './Playbooks.module.css';

const STEPS = [
  ['Offer and tier pick it', 'Each offer names a playbook for Act now, Good fit and Watch.'],
  ['Starts on acceptance', 'When an AE accepts an account, Scout starts the matching playbook.'],
  ['Scout prepares each step', 'Emails arrive as drafts for the AE. Calls and tasks go to HubSpot with due dates.'],
  ['Stops on a result', 'A reply or meeting ends it. Results roll up here by playbook.'],
];

function useCanManage(tenant: string) {
  const { data: me } = useQuery(meQuery(tenant));
  return !!me && hasScope(me, 'playbooks:manage');
}

/** §20 Playbooks: the steps an AE follows after accepting an account. */
export function PlaybooksScreen() {
  const tenant = useParams({ strict: false }).tenant!;
  const canManage = useCanManage(tenant);
  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div className={styles.grow}>
          <h1 className={page.title}>Playbooks</h1>
          <p className={page.sub}>The steps an AE follows after accepting an account. Each offer picks a playbook for each tier.</p>
        </div>
        {canManage && (
          <Link to="/t/$tenant/playbooks" params={{ tenant }} search={{ edit: 'new' }}>
            <Button>New playbook</Button>
          </Link>
        )}
      </div>
      <ol className={styles.explainer} aria-label="How playbooks work">
        {STEPS.map(([title, text]) => (
          <li key={title}>
            <strong>{title}</strong>
            <span className={styles.note}>{text}</span>
          </li>
        ))}
      </ol>
      <PlaybookList tenant={tenant} canManage={canManage} />
    </div>
  );
}

/** One playbook (§20 detail). */
export function PlaybookScreen() {
  const { tenant, id } = useParams({ strict: false }) as { tenant: string; id: string };
  const canManage = useCanManage(tenant);
  return (
    <div className={page.page}>
      <PlaybookView tenant={tenant} id={id} canManage={canManage} />
    </div>
  );
}
