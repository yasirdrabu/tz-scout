import { Link, useRouterState } from '@tanstack/react-router';
import type { Me } from '../api/me';
import { cx } from '../lib/cx';
import { allows, SETTINGS_RULE, visibleNav, visibleSettingsTabs, type NavItem } from './nav';
import { ProfileMenu } from './ProfileMenu';
import styles from './Sidebar.module.css';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export function Sidebar({ me }: { me: Me }) {
  const tenant = me.tenant.slug;
  return (
    <aside className={styles.sidebar}>
      <WorkspaceSwitcher me={me} />
      <nav aria-label="Main" className={styles.nav}>
        {visibleNav(me).map((g) => (
          <div key={g.group} className={styles.group}>
            <h2 id={`nav-${g.group}`} className={styles.groupLabel}>
              {g.group}
            </h2>
            <ul aria-labelledby={`nav-${g.group}`} className={styles.items}>
              {g.items.map((item) => (
                <li key={item.to}>
                  <NavLink item={item} tenant={tenant} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className={styles.footer}>
        {allows(me, SETTINGS_RULE) && <SettingsLink me={me} />}
        <ProfileMenu me={me} />
      </div>
    </aside>
  );
}

function NavLink({ item, tenant }: { item: NavItem; tenant: string }) {
  if (item.kind === 'admin') {
    return (
      <Link to={item.to} className={styles.link}>
        {item.label}
      </Link>
    );
  }
  return (
    <Link to={item.to} params={{ tenant }} className={styles.link}>
      {item.label}
    </Link>
  );
}

function SettingsLink({ me }: { me: Me }) {
  const tenant = me.tenant.slug;
  const onSettings = useRouterState({ select: (s) => s.location.pathname.startsWith(`/t/${tenant}/settings/`) });
  const tab = visibleSettingsTabs(me)[0]?.tab ?? 'members';
  return (
    <Link
      to="/t/$tenant/settings/$tab"
      params={{ tenant, tab }}
      className={cx(styles.link, onSettings && styles.active)}
      activeProps={{}}
    >
      Settings
    </Link>
  );
}
