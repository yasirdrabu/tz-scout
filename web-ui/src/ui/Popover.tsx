import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './Popover.module.css';

export type PopoverProps = {
  /** One focusable element, for example a Button. */
  trigger: ReactElement;
  /** Accessible name of the panel. */
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  /** Extra class for the panel, for its width and padding. */
  className?: string;
  children: ReactNode;
};

/** A panel anchored to its trigger. Esc and a click outside close it. */
export function Popover({ trigger, label, open, onOpenChange, align = 'start', className, children }: PopoverProps) {
  return (
    <RadixPopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content aria-label={label} align={align} sideOffset={6} className={cx(styles.content, className)}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
