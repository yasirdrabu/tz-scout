import { describe, expect, it } from 'vitest';
import { ScoutError, toProblem } from '@/platform/errors';

describe('toProblem', () => {
  it('maps ScoutError', () => {
    const r = toProblem(new ScoutError({ slug: 'key-revoked', status: 401, title: 'Key revoked' }));
    expect(r.status).toBe(401);
    expect(r.body.type).toBe('https://scout.taazaa.ai/problems/key-revoked');
    expect(r.body.title).toBe('Key revoked');
  });
  it('hides unknown errors', () => {
    const r = toProblem(new Error('x'));
    expect(r.status).toBe(500);
    expect(r.body.title).toBe('Something went wrong');
    expect(JSON.stringify(r.body)).not.toContain('stack');
    expect(JSON.stringify(r.body)).not.toContain('"x"');
  });
});
