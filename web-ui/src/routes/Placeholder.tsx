import type { ReactNode } from 'react';
import { Card } from '../ui/Card';
import { Pill } from '../ui/Pill';
import styles from './Page.module.css';
import placeholder from './Placeholder.module.css';
import type { Screen } from './screens';

/** Stands in for a screen until its plan builds it. */
export function Placeholder({ screen, subtitle, children }: { screen: Screen; subtitle?: string; children?: ReactNode }) {
  return (
    <div className={styles.page}>
      <div>
        <h1 className={styles.title}>{screen.title}</h1>
        <p className={styles.sub}>{subtitle ?? 'This screen is not built yet.'}</p>
      </div>
      {children}
      <Card>
        <dl className={placeholder.facts}>
          <dt>Spec</dt>
          <dd>
            <code className={placeholder.code}>screens.md §{screen.section}</code>
          </dd>
          <dt>Release</dt>
          <dd>
            <Pill tone="accent">{screen.tag}</Pill>
          </dd>
        </dl>
      </Card>
    </div>
  );
}
