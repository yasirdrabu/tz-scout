import { DEMO_PROVIDER, registerAdapter, type Adapter } from '../../providers';

/** Test-only provider. The mock never touches the network; the "live" demo adapter checks the credential shape only. */
export const demoMock: Adapter = {
  async test() {
    return { ok: true, message: 'Sample data is working.' };
  },
};

/** A credential value starting with "bad" fails its test, so tests can drive both outcomes. */
export const registerDemoAdapter = (): void =>
  registerAdapter(DEMO_PROVIDER, {
    mock: () => demoMock,
    live: (creds) => ({
      async test() {
        return creds.value.startsWith('bad')
          ? { ok: false, message: 'The token was refused.', missingPermissions: ['demo.read'] }
          : { ok: true, message: 'Connected to the demo service.' };
      },
    }),
  });
