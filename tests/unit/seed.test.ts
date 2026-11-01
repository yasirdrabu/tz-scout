import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/config', () => ({ config: { isProduction: true } }));

// The first import loads the whole app's module graph, which can take over 5 s on a busy machine.
describe('seed', () => {
  it('refuses to run in production', async () => {
    const { seed } = await import('@/entry/seed');
    await expect(seed()).rejects.toThrow('Seed data is for local use only.');
  }, 30_000);
});
