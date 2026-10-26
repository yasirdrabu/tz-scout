import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, rewrap } from '@/modules/integrations/domain/crypto';

const K1 = randomBytes(32);
const K2 = randomBytes(32);

describe('credential crypto', () => {
  it('round trips', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1);
    expect(s.keyVersion).toBe(1);
    expect(decryptSecret(s, new Map([[1, K1]]))).toBe('pat-abc-1234');
  });

  it('uses a fresh data key and iv each time', () => {
    const a = encryptSecret('same', K1, 1);
    const b = encryptSecret('same', K1, 1);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it('throws when the ciphertext is tampered with', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1);
    const buf = Buffer.from(s.ciphertext, 'base64');
    buf[0] = buf[0]! ^ 1;
    expect(() => decryptSecret({ ...s, ciphertext: buf.toString('base64') }, new Map([[1, K1]]))).toThrow();
  });

  it('throws with the wrong key or an unknown version', () => {
    const s = encryptSecret('x', K1, 1);
    expect(() => decryptSecret(s, new Map([[1, K2]]))).toThrow();
    expect(() => decryptSecret(s, new Map([[2, K1]]))).toThrow(/key version/i);
  });

  it('rewraps to a new master key without changing the value', () => {
    const s = encryptSecret('pat-abc-1234', K1, 1);
    const r = rewrap(s, K1, K2, 2);
    expect(r.keyVersion).toBe(2);
    expect(r.ciphertext).toBe(s.ciphertext);
    expect(decryptSecret(r, new Map([[2, K2]]))).toBe('pat-abc-1234');
    expect(() => decryptSecret(r, new Map([[2, K1]]))).toThrow();
  });

  it('does not leak the plain text into the sealed form', () => {
    expect(JSON.stringify(encryptSecret('pat-abc-1234', K1, 1))).not.toContain('pat-abc');
  });
});
