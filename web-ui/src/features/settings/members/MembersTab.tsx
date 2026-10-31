import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { History } from 'lucide-react';
import { EmptyState } from '../../../ui/EmptyState';
import { Tabs } from '../../../ui/Tabs';
import type { TabProps } from '../SettingsScreen';
import { membersQuery } from './api';
import { MembersList } from './MembersList';
import { RolesMatrix } from './RolesMatrix';

/** §21a Members: inner tabs Members ({n}), Roles and permissions, Login history. */
export function MembersTab(props: TabProps) {
  const [view, setView] = useState('members');
  const { data } = useQuery(membersQuery(props.tenant));
  const tabs = [
    { id: 'members', label: data ? `Members (${data.length})` : 'Members' },
    { id: 'roles', label: 'Roles and permissions' },
    { id: 'logins', label: 'Login history' },
  ];
  return (
    <Tabs label="Members" tabs={tabs} value={view} onChange={setView}>
      {view === 'members' && <MembersList {...props} />}
      {view === 'roles' && <RolesMatrix tenant={props.tenant} />}
      {view === 'logins' && <LoginHistory />}
    </Tabs>
  );
}

/** Sign-in logging is its own plan (Decision 20), so this tab shows its empty state. */
function LoginHistory() {
  return (
    <EmptyState title="No sign-ins to show yet" icon={<History />}>
      Scout doesn't record sign-ins yet. They show here once sign-in history is turned on.
    </EmptyState>
  );
}
