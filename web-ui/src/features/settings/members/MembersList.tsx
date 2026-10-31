import { useQuery } from '@tanstack/react-query';
import { UserPlus, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { hasScope, userIdOf } from '../../../api/me';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { EmptyState } from '../../../ui/EmptyState';
import { Tabs } from '../../../ui/Tabs';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { membersQuery, practicesQuery, type Member } from './api';
import { InviteDialog } from './InviteDialog';
import { MemberDrawer } from './MemberDrawer';
import { MembersTable } from './MembersTable';
import { STATUS_LABEL } from './words';

const STATUSES = ['all', 'active', 'invited', 'suspended'] as const;
type StatusFilter = (typeof STATUSES)[number];

const matches = (m: Member, q: string) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);

export function MembersList({ me, tenant, open, setOpen }: TabProps) {
  const searchId = useId();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [inviting, setInviting] = useState(false);
  const members = useQuery(membersQuery(tenant));
  // Practice names for "Role and practice access"; a person without offers:read sees counts instead.
  const practices = useQuery({ ...practicesQuery(tenant), enabled: hasScope(me, 'offers:read') });
  const canManage = hasScope(me, 'members:manage');

  if (members.isPending) return <LoadingRows>Loading members</LoadingRows>;
  if (members.isError) return <LoadFailed title="Members didn't load" error={members.error} onRetry={() => void members.refetch()} />;

  const all = members.data;
  const needle = q.trim().toLowerCase();
  const count = (s: StatusFilter) => all.filter((m) => s === 'all' || m.status === s).length;
  const shown = all.filter((m) => (status === 'all' || m.status === status) && matches(m, needle));
  const microsoft = all.filter((m) => m.status === 'active' && m.sign_in_method === 'microsoft').length;
  const selected = open ? all.find((m) => m.id === open) : undefined;
  const invite = canManage && (
    <Button icon={<UserPlus />} onClick={() => setInviting(true)}>
      Invite people
    </Button>
  );

  return (
    <>
      <Card title="How people sign in">
        <p className={styles.note}>Members use their work account. Scout never stores a password.</p>
        <dl className={styles.facts}>
          <dt>Microsoft 365</dt>
          <dd>{microsoft === 1 ? '1 active member uses this' : `${microsoft} active members use this`}</dd>
        </dl>
      </Card>
      <div className={styles.toolbar}>
        <label htmlFor={searchId} className="sr-only">
          Search by name or email
        </label>
        <input
          id={searchId}
          type="search"
          className={`input ${styles.search}`}
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Tabs
          label="Member status"
          size="sm"
          tabs={STATUSES.map((s) => ({ id: s, label: `${s === 'all' ? 'All' : STATUS_LABEL[s]} ${count(s)}` }))}
          value={status}
          onChange={(s) => setStatus(s as StatusFilter)}
        />
        <span className={styles.grow} />
        {invite}
      </div>
      {all.length === 0 ? (
        <EmptyState title="No members yet" icon={<Users />} actions={invite || undefined}>
          Invite the people who will review and work accounts.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No members match">Try another name or email, or another status.</EmptyState>
      ) : (
        <MembersTable members={shown} total={all.length} youId={userIdOf(me)} practices={practices.data ?? []} onOpen={setOpen} />
      )}
      {selected && (
        <MemberDrawer
          member={selected}
          everyone={all}
          me={me}
          tenant={tenant}
          practices={practices.data ?? []}
          onClose={() => setOpen(undefined)}
        />
      )}
      {canManage && <InviteDialog open={inviting} onOpenChange={setInviting} tenant={tenant} practices={practices.data ?? []} />}
    </>
  );
}
