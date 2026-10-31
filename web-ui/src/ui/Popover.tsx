import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactElement, ReactNode } from 'react';
import styles from './Popover.module.css';

export type PopoverProps = {
  /** One focusable element, for example a Button. */
  trigger: ReactElement;
  /** Accessible name of the panel. */
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  children: ReactNode;
};

/** A panel anchored to its trigger. Esc and a click outside close it. */
export function Popover({ trigger, label, open, onOpenChange, align = 'start', children }: PopoverProps) {
  return (
    <RadixPopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content aria-label={label} align={align} sideOffset={6} className={styles.content}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
