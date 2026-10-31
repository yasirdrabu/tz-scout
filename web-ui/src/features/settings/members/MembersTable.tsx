import { useFormat } from '../../../lib/useFormat';
import { Avatar } from '../../../ui/Avatar';
import { Pill, type PillTone } from '../../../ui/Pill';
import table from '../../../ui/Table.module.css';
import styles from '../Settings.module.css';
import type { Member, MemberStatus, Practice } from './api';
import { hasPracticeAccess, practiceText, roleLabel, signInWith, STATUS_LABEL } from './words';

const TONE: Record<MemberStatus, PillTone> = { active: 'good', invited: 'accent', suspended: 'bad' };

type Props = { members: Member[]; total: number; youId: string | null; practices: Practice[]; onOpen: (id: string) => void };

export function MembersTable({ members, total, youId, practices, onOpen }: Props) {
  const f = useFormat();
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Role</th>
            <th scope="col">Signs in with</th>
            <th scope="col">Status</th>
            <th scope="col">Last active</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                <div className={styles.person}>
                  <Avatar name={m.name} size="sm" decorative />
                  <div className={styles.personText}>
                    <span>
                      <button type="button" className={table.open} onClick={() => onOpen(m.id)}>
                        {m.name}
                      </button>
                      {m.user_id === youId && <span className={table.muted}> You</span>}
                    </span>
                    <span className={table.muted}>{m.email}</span>
                  </div>
                </div>
              </td>
              <td>
                <div className={styles.personText}>
                  <span>{roleLabel(m.role)}</span>
                  {hasPracticeAccess(m.role) && <span className={table.muted}>{practiceText(m.data_limit, practices)}</span>}
                </div>
              </td>
              <td>{signInWith(m)}</td>
              <td>
                <Pill tone={TONE[m.status]}>{STATUS_LABEL[m.status]}</Pill>
              </td>
              <td className={table.muted}>{m.last_active_at ? f.relative(m.last_active_at) : 'Not signed in yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={table.foot}>
        <span>
          Showing {members.length} of {total}
        </span>
        <span>Sorted by name</span>
      </div>
    </div>
  );
}
