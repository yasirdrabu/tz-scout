import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './Tabs.module.css';

export type Tab = { id: string; label: string };

export type TabsProps = {
  /** Names the tab list, for example "Member status". */
  label: string;
  tabs: Tab[];
  value: string;
  onChange: (id: string) => void;
  size?: 'md' | 'sm';
  /** The panel for the selected tab. */
  children?: ReactNode;
};

const KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/** Tabs with their panel: arrow keys, Home and End move between tabs and select them. */
export function Tabs({ label, tabs, value, onChange, size = 'md', children }: TabsProps) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const tabId = (id: string) => `${base}-tab-${id}`;

  function onKeyDown(e: KeyboardEvent) {
    const move = KEYS[e.key];
    if (!move) return;
    e.preventDefault();
    const tab = tabs[move(tabs.findIndex((t) => t.id === value), tabs.length)];
    if (!tab) return;
    onChange(tab.id);
    list.current?.querySelector<HTMLButtonElement>(`[id="${tabId(tab.id)}"]`)?.focus();
  }

  return (
    <div className={styles.tabs}>
      <div ref={list} role="tablist" aria-label={label} className={cx(styles.list, styles[size])}>
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              id={tabId(t.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={children === undefined ? undefined : `${base}-panel`}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => onChange(t.id)}
              onKeyDown={onKeyDown}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div id={`${base}-panel`} role="tabpanel" aria-labelledby={tabId(value)} className={styles.panel}>
          {children}
        </div>
      )}
    </div>
  );
}
