import { registerAdapter } from '@/modules/integrations';
import { websiteLive } from './live';
import { websiteMock } from './mock';

/** Sample pages by default; the live reader once the connection is switched to live (it needs no key). */
export const registerWebsiteAdapter = (): void => registerAdapter('website', { mock: () => websiteMock(), live: (creds) => websiteLive(creds) });
