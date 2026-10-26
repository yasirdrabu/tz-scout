import { config } from '@/platform/config';
import { ScoutError } from '@/platform/errors';
import { decryptSecret, encryptSecret, type Sealed } from '../domain/crypto';

export const MASTER_KEY_MISSING = 'Set SCOUT_MASTER_KEY to store credentials.';

const missing = () => new ScoutError({ slug: 'master-key-missing', status: 500, title: MASTER_KEY_MISSING });

/** Key version -> master key. The current key is `masterKeyVersion`; the previous key is one lower. */
export function keyring(): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  if (config.masterKey) keys.set(config.masterKeyVersion, config.masterKey);
  if (config.masterKeyPrevious) keys.set(config.masterKeyVersion - 1, config.masterKeyPrevious);
  return keys;
}

export function sealValue(value: string): Sealed {
  if (!config.masterKey) throw missing();
  return encryptSecret(value, config.masterKey, config.masterKeyVersion);
}

type SealedRow = { ciphertext: string; iv: string; authTag: string; wrappedDataKey: string; keyVersion: number };

export function openValue(row: SealedRow): string {
  const keys = keyring();
  if (keys.size === 0) throw missing();
  return decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      wrappedDataKey: row.wrappedDataKey,
      keyVersion: row.keyVersion,
    },
    keys,
  );
}
