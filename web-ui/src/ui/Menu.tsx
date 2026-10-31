import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ReactElement, ReactNode } from 'react';
import styles from './Menu.module.css';

export type MenuProps = {
  /** One focusable element, for example a button. */
  trigger: ReactElement;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  width?: number;
  children: ReactNode;
};

/** A dropdown menu, named by its trigger: arrow keys move, Enter picks, Esc closes and focus returns to the trigger. */
export function Menu({ trigger, align = 'start', side = 'bottom', width = 250, children }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content align={align} side={side} sideOffset={6} className={styles.content} style={{ width }}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function MenuItem({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <RadixMenu.Item className={styles.item} onSelect={onSelect}>
      {children}
    </RadixMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className={styles.label}>{children}</RadixMenu.Label>;
}

export function MenuSeparator() {
  return <RadixMenu.Separator className={styles.separator} />;
}

export function MenuNote({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}
