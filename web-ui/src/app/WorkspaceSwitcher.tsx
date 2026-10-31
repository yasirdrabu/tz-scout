import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown } from 'lucide-react';
import { rememberWorkspaceOnServer, workspacesOf, type Me, type Workspace } from '../api/me';
import { rememberWorkspace } from '../lib/lastWorkspace';
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from '../ui/Menu';
import { useToast } from '../ui/Toast';
import styles from './WorkspaceSwitcher.module.css';

const initial = (name: string) => name.trim()[0]?.toUpperCase() ?? '?';
const members = (w: Workspace) => (w.member_count === null ? null : `${w.member_count} ${w.member_count === 1 ? 'member' : 'members'}`);

/** Top of the sidebar: the person's workspaces from `/me` with member counts. */
export function WorkspaceSwitcher({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const workspaces = workspacesOf(me);
  const current = workspaces.find((w) => w.slug === me.tenant.slug) ?? { ...me.tenant, role: null, member_count: null };
  const sub = members(current);

  function switchTo(w: Workspace) {
    if (w.slug === current.slug) return;
    // Each workspace has its own data: nothing cached for this one may show in the next.
    queryClient.clear();
    rememberWorkspace(w.slug);
    // The API records it for sign-in on other devices. If that fails this browser still remembers it,
    // so the switch goes ahead.
    rememberWorkspaceOnServer(w.slug).catch(() => undefined);
    toast.show(`Switched to ${w.name}`);
    void navigate({ to: '/t/$tenant', params: { tenant: w.slug } });
  }

  return (
    <Menu
      width={270}
      trigger={
        <button type="button" className={styles.trigger}>
          <span className={styles.tile} aria-hidden="true">
            {initial(current.name)}
          </span>
          <span className={styles.text}>
            <span className={styles.name}>{current.name}</span>
            <span className={styles.sub}>{sub ? `Scout · ${sub}` : 'Scout'}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className={styles.chevron} />
          <span className="sr-only">Switch workspace</span>
        </button>
      }
    >
      <MenuLabel>Your workspaces</MenuLabel>
      {workspaces.map((w) => {
        const isCurrent = w.slug === current.slug;
        return (
          <MenuItem key={w.slug} onSelect={() => switchTo(w)}>
            <span className={styles.itemTile} aria-hidden="true">
              {initial(w.name)}
            </span>
            <span className={styles.text}>
              <span className={styles.itemName}>{w.name}</span>
              {members(w) && <span className={styles.sub}>{members(w)}</span>}
            </span>
            {isCurrent && (
              <>
                <Check aria-hidden="true" className={styles.check} />
                <span className="sr-only">(current)</span>
              </>
            )}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuNote>Each workspace keeps its own accounts, sources and HubSpot connection.</MenuNote>
    </Menu>
  );
}
