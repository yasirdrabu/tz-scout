import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, rewrap } from '@/modules/integrations/domain/crypto';

const K1 = randomBytes(32);
const K2 = randomBytes(32);
const AAD = 't_1|con_1|cred_1';

describe('credential crypto', () => {
  it('round trips', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1, AAD);
    expect(s.keyVersion).toBe(1);
    expect(decryptSecret(s, new Map([[1, K1]]), AAD)).toBe('pat-abc-1234');
  });

  it('uses a fresh data key and iv each time', () => {
    const a = encryptSecret('same', K1, 1, AAD);
    const b = encryptSecret('same', K1, 1, AAD);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it('throws when the ciphertext is tampered with', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1, AAD);
    const buf = Buffer.from(s.ciphertext, 'base64');
    buf[0] = buf[0]! ^ 1;
    expect(() => decryptSecret({ ...s, ciphertext: buf.toString('base64') }, new Map([[1, K1]]), AAD)).toThrow();
  });

  it('throws with the wrong key or an unknown version', () => {
    const s = encryptSecret('x', K1, 1, AAD);
    expect(() => decryptSecret(s, new Map([[1, K2]]), AAD)).toThrow();
    expect(() => decryptSecret(s, new Map([[2, K1]]), AAD)).toThrow(/key version/i);
  });

  it('rewraps to a new master key without changing the value', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1, AAD);
    const r = rewrap(s, K1, K2, 2);
    expect(r.keyVersion).toBe(2);
    expect(r.ciphertext).toBe(s.ciphertext);
    expect(decryptSecret(r, new Map([[2, K2]]), AAD)).toBe('pat-abc-1234');
    expect(() => decryptSecret(r, new Map([[2, K1]]), AAD)).toThrow();
  });

  it('does not decrypt when moved to another credential row', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1, AAD);
    expect(() => decryptSecret(s, new Map([[1, K1]]), 't_2|con_1|cred_1')).toThrow();
    expect(() => decryptSecret(s, new Map([[1, K1]]), 't_1|con_1|cred_2')).toThrow();
  });

  it('does not decrypt when the wrapped key is relabelled with another key version', () => {
    const s = encryptSecret('x', K1, 1, AAD);
    expect(() => decryptSecret({ ...s, keyVersion: 2 }, new Map([[2, K1]]), AAD)).toThrow();
  });

  it('does not leak the plain text into the sealed form', () => {
    expect(JSON.stringify(encryptSecret('pat-abc-1234', K1, 1, AAD))).not.toContain('pat-abc');
  });
});
