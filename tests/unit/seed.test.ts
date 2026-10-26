import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/config', () => ({ config: { isProduction: true } }));

describe('seed', () => {
  it('refuses to run in production', async () => {
    const { seed } = await import('@/entry/seed');
    await expect(seed()).rejects.toThrow('Seed data is for local use only.');
  });
});
