import { describe, expect, it } from 'vitest';

// The first import loads the whole app's module graph, which can take over 5 s on a busy machine.
describe('entry registry', () => {
  it('registers platform.ping for every process role', async () => {
    await import('@/entry/registry');
    const { jobDef } = await import('@/platform/events/registry');
    expect(jobDef('platform.ping')).toBeDefined();
  }, 30_000);
});
