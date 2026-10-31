import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { signOut } from '../api/auth';
import { personOf, type Me } from '../api/me';
import { Avatar } from '../ui/Avatar';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { useToast } from '../ui/Toast';
import styles from './ProfileMenu.module.css';

/** Bottom of the sidebar. `/me` has no name or email yet, so it falls back to "Your account". */
export function ProfileMenu({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { name, email } = personOf(me);
  const display = name ?? email ?? 'Your account';
  const detail = name && email ? email : me.tenant.name;

  async function leave() {
    try {
      await signOut();
    } catch {
      toast.show("Sign-out didn't work. Try again.");
      return;
    }
    queryClient.clear();
    await navigate({ to: '/signin', search: {} });
  }

  return (
    <Menu
      side="top"
      trigger={
        <button type="button" className={styles.trigger}>
          <Avatar name={name ?? email ?? ''} decorative />
          <span className={styles.text}>
            <span className={styles.name}>{display}</span>
            <span className={styles.detail}>{detail}</span>
          </span>
        </button>
      }
    >
      <MenuItem onSelect={() => void navigate({ to: '/t/$tenant/profile', params: { tenant: me.tenant.slug } })}>Profile</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void leave()}>Sign out</MenuItem>
    </Menu>
  );
}
