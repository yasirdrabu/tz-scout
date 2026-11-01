import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import styles from './Drawer.module.css';

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** A line under the title, for example the person's email. */
  subtitle?: ReactNode;
  /** Before the title, for example an avatar. */
  lead?: ReactNode;
  /** A row above the title, before Close: for example previous and next. */
  toolbar?: ReactNode;
  /** Under the title, for example the actions on what is open. */
  actions?: ReactNode;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
};

/** Right-side panel: focus held inside, Esc and Close dismiss it, focus returns to what opened it. */
export function Drawer({ open, onOpenChange, title, subtitle, lead, toolbar, actions, width = 440, footer, children }: DrawerProps) {
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) returnTo.current = document.activeElement;
  }, [open]);

  const close = (
    <RadixDialog.Close asChild>
      <IconButton label="Close">
        <X />
      </IconButton>
    </RadixDialog.Close>
  );

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          style={{ width }}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnTo.current?.isConnected) return;
            event.preventDefault();
            returnTo.current.focus();
          }}
        >
          <div className={toolbar ? styles.headStacked : styles.head}>
            {toolbar && (
              <div className={styles.toolbar}>
                {toolbar}
                {close}
              </div>
            )}
            <div className={styles.headRow}>
              {lead}
              <div className={styles.heading}>
                <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
                {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
              </div>
              {!toolbar && close}
            </div>
            {actions && <div className={styles.actions}>{actions}</div>}
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
