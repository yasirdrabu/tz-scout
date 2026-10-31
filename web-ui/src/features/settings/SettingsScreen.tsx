import { Link } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Me } from '../../api/me';
import { visibleSettingsTabs, type SettingsTab } from '../../app/nav';
import page from '../../routes/Page.module.css';
import { EmptyState } from '../../ui/EmptyState';
import { ApiKeysTab } from './keys/ApiKeysTab';
import { AuditTab } from './audit/AuditTab';
import { IntegrationsTab } from './integrations/IntegrationsTab';
import { MembersTab } from './members/MembersTab';
import styles from './Settings.module.css';

/** What every tab gets: the person, the workspace, and the item open in a drawer (from the URL). */
export type TabProps = { me: Me; tenant: string; open: string | undefined; setOpen: (id: string | undefined) => void };

const SCREENS: Record<string, (props: TabProps) => ReactNode> = {
  members: (p) => <MembersTab {...p} />,
  integrations: (p) => <IntegrationsTab {...p} />,
  'api-keys': (p) => <ApiKeysTab {...p} />,
  'audit-log': (p) => <AuditTab {...p} />,
};

/** `/t/:tenant/settings/:tab`: the tab bar (tabs by permission) and the tab (screens.md §21). */
export function SettingsScreen({ tab, ...props }: TabProps & { tab: string }) {
  const tabs = visibleSettingsTabs(props.me);
  const current = tabs.find((t) => t.tab === tab);
  return (
    <div className={page.page}>
      <h1 className={page.title}>Settings</h1>
      <nav aria-label="Settings" className={styles.tabs}>
        {tabs.map((t) => (
          <Link key={t.tab} to="/t/$tenant/settings/$tab" params={{ tenant: props.tenant, tab: t.tab }} className={styles.tab}>
            {t.label}
          </Link>
        ))}
      </nav>
      {current ? <Body tab={current} {...props} /> : <NotOpen />}
    </div>
  );
}

function Body({ tab, ...props }: TabProps & { tab: SettingsTab }) {
  const screen = SCREENS[tab.tab];
  if (screen) return screen(props);
  return <p className={styles.note}>{tab.label}. This tab is not built yet.</p>;
}

function NotOpen() {
  return (
    <EmptyState title="This tab isn't open to you" icon={<Lock />}>
      Your role doesn't include it. Ask your owner if you need it.
    </EmptyState>
  );
}
