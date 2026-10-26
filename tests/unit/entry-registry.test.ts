import { describe, expect, it } from 'vitest';

describe('entry registry', () => {
  it('registers platform.ping for every process role', async () => {
    await import('@/entry/registry');
    const { jobDef } = await import('@/platform/events/registry');
    expect(jobDef('platform.ping')).toBeDefined();
  });
});
