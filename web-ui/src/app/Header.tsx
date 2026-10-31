import { Search } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import styles from './Header.module.css';

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Header with global search. `/` focuses search. Results come with the search endpoint
 * (api-gaps.md tenancy); the CRM sync indicator stays hidden until `GET /me/counts` exists.
 */
export function Header() {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || editable(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className={styles.header}>
      <form role="search" className={styles.search} onSubmit={(e) => e.preventDefault()}>
        <Search aria-hidden="true" className={styles.icon} />
        <label htmlFor={id} className="sr-only">
          Search
        </label>
        <input
          ref={input}
          id={id}
          type="search"
          className={styles.input}
          placeholder="Search accounts, people and batches"
          autoComplete="off"
          aria-keyshortcuts="/"
        />
      </form>
    </header>
  );
}
