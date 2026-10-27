import { describe, expect, it } from 'vitest';
import { newId } from '@/platform/ids';

describe('newId', () => {
  it('rejects unknown prefixes at type level', () => {
    // @ts-expect-error unknown prefix
    expect(() => newId('zzz')).not.toThrow();
  });
  it('formats ids', () => {
    expect(newId('t')).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('sorts in creation order', () => {
    const a = newId('run');
    const b = newId('run');
    expect(a < b).toBe(true);
  });
});
