import { registerAdapter } from '@/modules/integrations';
import { hubspotMock } from './mock';

/** Live comes with Task 3; until then every environment gets the mock. */
export const registerHubspotAdapter = (): void => registerAdapter('hubspot', { mock: (ctx) => hubspotMock(ctx) });
