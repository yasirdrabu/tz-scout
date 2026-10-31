import { beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
  childSources: async () => ['src_child'],
  personSourceFor: async () => 'src_person',
}));

// Fresh module graph per test, with a stand-in for compose.ts that registers a stub the way
// compose registers real implementations. Whatever imports compose must see the stub.
beforeEach(() => {
  vi.resetModules();
  vi.doMock('@/entry/compose', async () => {
    const { registerSourceAccessProvider } = await import('@/modules/accounts/contracts/ports');
    registerSourceAccessProvider(stub);
    return {};
  });
});

const provider = async () => (await import('@/modules/accounts/contracts/ports')).sourceAccessProvider();

describe('composition root', () => {
  it('is loaded by the /api/v1 route module', async () => {
    await import('@/http/routes/v1/_lib/v1-route');
    expect(await provider()).toBe(stub);
  });

  it('is loaded by the registry every background role imports', async () => {
    await import('@/entry/registry');
    expect(await provider()).toBe(stub);
  });
});
