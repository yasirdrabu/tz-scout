import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import styles from './Dialog.module.css';

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question for confirms, for example "Remove this source?". */
  title: string;
  /** The consequence in one sentence. */
  description?: string;
  footer?: ReactNode;
  width?: number;
  children?: ReactNode;
};

/** Modal dialog: focus held inside, Esc and Close dismiss it, focus returns to the trigger. */
export function Dialog({ open, onOpenChange, title, description, footer, width = 520, children }: DialogProps) {
  // Opened from outside (no Radix trigger), so remember what had focus and return to it on close.
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
          onCloseAutoFocus={(event) => {
            if (!returnTo.current?.isConnected) return;
            event.preventDefault();
            returnTo.current.focus();
          }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={styles.head}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label="Close">
                <X />
              </IconButton>
            </RadixDialog.Close>
          </div>
          {description && <RadixDialog.Description className={styles.description}>{description}</RadixDialog.Description>}
          {children && <div className={styles.body}>{children}</div>}
          {footer && <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
