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
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
};

/** Right-side panel: focus held inside, Esc and Close dismiss it, focus returns to what opened it. */
export function Drawer({ open, onOpenChange, title, subtitle, lead, width = 440, footer, children }: DrawerProps) {
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) returnTo.current = document.activeElement;
  }, [open]);

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
          <div className={styles.head}>
            {lead}
            <div className={styles.heading}>
              <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
              {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
            </div>
            <RadixDialog.Close asChild>
              <IconButton label="Close">
                <X />
              </IconButton>
            </RadixDialog.Close>
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
