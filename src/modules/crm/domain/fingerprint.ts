import { createHash } from 'node:crypto';

/** Fingerprint of a note body, to tell whether someone edited it in the CRM since Scout last wrote it (v1's `noteHash`). */
export function noteFingerprint(body: string): string {
  return createHash('sha1').update(body.replace(/\s+/g, ' ').trim()).digest('hex');
}
