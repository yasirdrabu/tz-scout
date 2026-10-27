import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, page, pageLimit } from '@/app/v1/_lib/pagination';

const url = (q: string) => new URL(`http://x/v1/y${q}`);

describe('pageLimit', () => {
  it('is 50 by default and allows 200', () => {
    expect(pageLimit(url(''))).toBe(50);
    expect(pageLimit(url('?limit=200'))).toBe(200);
  });
  it('rejects 0 and 999 with a 400 validation error', () => {
    for (const bad of ['0', '999', 'abc', '-1']) {
      expect(() => pageLimit(url(`?limit=${bad}`))).toThrow(
        expect.objectContaining({
          slug: 'validation',
          status: 400,
          errors: [{ path: 'limit', message: 'Limit must be between 1 and 200.' }],
        }),
      );
    }
  });
});

describe('page', () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: `r${i + 1}`, n: i + 1 }));
  it('cuts the extra row and points the cursor at the last row kept', () => {
    const p = page(rows, 50, (r) => ({ id: r.id, n: r.n }));
    expect(p.items).toHaveLength(50);
    expect(decodeCursor(p.nextCursor)).toEqual({ id: 'r50', n: 50 });
  });
  it('has no cursor on the last page', () => {
    expect(page(rows.slice(0, 50), 50, (r) => ({ id: r.id })).nextCursor).toBeNull();
  });
});

describe('decodeCursor', () => {
  it('round-trips and treats a missing cursor as none', () => {
    expect(decodeCursor(encodeCursor({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeCursor(null)).toBeNull();
  });
  it('rejects a bad cursor with a 400 on path cursor', () => {
    for (const bad of ['!!!', Buffer.from('[1]').toString('base64url'), Buffer.from('nope').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(
        expect.objectContaining({ slug: 'validation', status: 400, errors: [expect.objectContaining({ path: 'cursor' })] }),
      );
    }
  });
});
