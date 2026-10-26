import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** All fields base64. `wrappedDataKey` is iv (12) + auth tag (16) + encrypted data key (32). */
export type Sealed = {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDataKey: string;
  keyVersion: number;
};

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function gcmSeal(key: Buffer, plain: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

const wrapKey = (masterKey: Buffer, dataKey: Buffer): Buffer => {
  const w = gcmSeal(masterKey, dataKey);
  return Buffer.concat([w.iv, w.tag, w.ciphertext]);
};

function unwrapKey(masterKey: Buffer, wrapped: string): Buffer {
  const b = Buffer.from(wrapped, 'base64');
  return gcmOpen(masterKey, b.subarray(0, IV_LEN), b.subarray(IV_LEN, IV_LEN + TAG_LEN), b.subarray(IV_LEN + TAG_LEN));
}

/** Envelope encryption: a random data key encrypts the value; the master key wraps the data key. */
export function encryptSecret(plain: string, masterKey: Buffer, keyVersion: number): Sealed {
  const dataKey = randomBytes(32);
  const s = gcmSeal(dataKey, Buffer.from(plain, 'utf8'));
  return {
    ciphertext: s.ciphertext.toString('base64'),
    iv: s.iv.toString('base64'),
    authTag: s.tag.toString('base64'),
    wrappedDataKey: wrapKey(masterKey, dataKey).toString('base64'),
    keyVersion,
  };
}

export function decryptSecret(s: Sealed, keys: Map<number, Buffer>): string {
  const master = keys.get(s.keyVersion);
  if (!master) throw new Error(`No master key for key version ${s.keyVersion}`);
  const dataKey = unwrapKey(master, s.wrappedDataKey);
  return gcmOpen(
    dataKey,
    Buffer.from(s.iv, 'base64'),
    Buffer.from(s.authTag, 'base64'),
    Buffer.from(s.ciphertext, 'base64'),
  ).toString('utf8');
}

/** Re-wraps the data key under a new master key. The credential value is never decrypted. */
export function rewrap(s: Sealed, from: Buffer, to: Buffer, toVersion: number): Sealed {
  const dataKey = unwrapKey(from, s.wrappedDataKey);
  return { ...s, wrappedDataKey: wrapKey(to, dataKey).toString('base64'), keyVersion: toVersion };
}
