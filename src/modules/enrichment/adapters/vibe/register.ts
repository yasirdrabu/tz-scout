import { registerAdapter } from '@/modules/integrations';
import { vibeMock } from './mock';

/** Sample data only (Ruling 2): with no live side, switching Vibe to live keeps "This service can't run live yet." */
export const registerVibeAdapter = (): void => registerAdapter('vibe', { mock: () => vibeMock() });
