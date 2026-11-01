import { useState } from 'react';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { copyText } from '../settings/shared';
import styles from './Sources.module.css';

/** A new key's secret, shown once, with Copy (Decision 14). The caller drops the secret when it closes. */
export function KeyReveal({ secret }: { secret: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyText(secret);
    setCopied(ok);
    if (!ok) toast.show("Copy didn't work. Select the key and copy it.");
  }
  return (
    <div className={styles.section}>
      <code className={styles.secret} aria-label="New API key">
        {secret}
      </code>
      <div className={styles.row}>
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <span className={styles.note}>Copy this now. You won't see it again.</span>
      </div>
    </div>
  );
}
