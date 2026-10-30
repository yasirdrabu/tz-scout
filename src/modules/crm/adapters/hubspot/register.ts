import { registerAdapter } from '@/modules/integrations';
import { hubspotLive } from './live';
import { hubspotMock } from './mock';

/** Sample data in tests and sample-only environments; the live connector once a connection is switched to live. */
export const registerHubspotAdapter = (): void => registerAdapter('hubspot', { mock: (ctx) => hubspotMock(ctx), live: (creds) => hubspotLive(creds) });
