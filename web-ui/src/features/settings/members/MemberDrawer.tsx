import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasScope, type Me } from '../../../api/me';
import { useFormat } from '../../../lib/useFormat';
import { Avatar } from '../../../ui/Avatar';
import { Drawer } from '../../../ui/Drawer';
import { Field } from '../../../ui/Field';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { membersQuery, rolesQuery, updateMember, type Member, type Practice } from './api';
import { HubSpotUser, PracticeAccess } from './MemberAccess';
import { MemberActions } from './MemberActions';
import { hasPracticeAccess, roleLabel, roleLockText, signInWith, STATUS_LABEL } from './words';

type Props = { member: Member; me: Me; tenant: string; practices: Practice[]; onClose: () => void };

/** §21a member drawer: role, practice access, HubSpot user, sign-in facts and the member actions. */
export function MemberDrawer({ member, me, tenant, practices, onClose }: Props) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery(tenant));
  const { run, busy } = useRun();
  const canManage = hasScope(me, 'members:manage');
  const lock = member.can_change_role ? null : roleLockText(member.lock_reasons.change_role);
  const roleKeys = roles.data?.roles.map((r) => r.role) ?? [member.role];
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQuery(tenant).queryKey });

  function changeRole(role: string) {
    void run(
      async () => {
        await updateMember(tenant, member.id, { role });
        await refresh();
      },
      `${member.name} is now ${roleLabel(role)}. It applies the next time they load a page.`,
    );
  }

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={member.name}
      subtitle={`${member.email} · ${STATUS_LABEL[member.status]}`}
      lead={<Avatar name={member.name} decorative />}
    >
      {canManage ? (
        <Field label="Role" hint={lock}>
          {(control) => (
            <select {...control} className="input" value={member.role} disabled={!!lock || busy} onChange={(e) => changeRole(e.target.value)}>
              {roleKeys.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <dl className={styles.facts}>
          <dt>Role</dt>
          <dd>{roleLabel(member.role)}</dd>
        </dl>
      )}
      {hasPracticeAccess(member.role) && (
        <PracticeAccess key={`p-${member.id}`} member={member} tenant={tenant} practices={practices} canManage={canManage} onSaved={refresh} />
      )}
      <HubSpotUser key={`h-${member.id}`} member={member} tenant={tenant} canManage={canManage} onSaved={refresh} />
      <section className={styles.section} aria-labelledby="member-sign-in">
        <h3 id="member-sign-in" className={styles.sectionTitle}>
          Sign-in
        </h3>
        <dl className={styles.facts}>
          <dt>Signs in with</dt>
          <dd>{signInWith(member)}</dd>
          <dt>Last active</dt>
          <dd>{member.last_active_at ? f.dateTime(member.last_active_at) : 'Not signed in yet'}</dd>
          <dt>Open accounts</dt>
          <dd>{f.number(member.open_account_count)}</dd>
        </dl>
      </section>
      {canManage && <MemberActions member={member} tenant={tenant} onChanged={refresh} onRemoved={onClose} />}
    </Drawer>
  );
}
