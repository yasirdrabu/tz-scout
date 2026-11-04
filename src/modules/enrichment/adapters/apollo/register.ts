import { registerAdapter } from '@/modules/integrations';
import { apolloLive } from './live';
import { apolloMock } from './mock';

/** Sample data in tests and sample-only environments; live Apollo once the connection is switched to live. */
export const registerApolloAdapter = (): void => registerAdapter('apollo', { mock: () => apolloMock(), live: (creds) => apolloLive(creds) });
