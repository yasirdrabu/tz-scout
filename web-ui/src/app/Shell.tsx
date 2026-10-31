import type { ReactNode } from 'react';
import type { Me } from '../api/me';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import styles from './Shell.module.css';

/** The frame of every signed-in screen: sidebar 240 px, header 60 px, scrolling content. */
export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <a href="#content" className={styles.skip}>
        Skip to content
      </a>
      <Sidebar me={me} />
      <div className={styles.main}>
        <Header />
        <main id="content" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
