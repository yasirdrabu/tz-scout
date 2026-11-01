import { listSessions } from '@/modules/tenancy';
import { sessionRoute } from '../../_lib/v1-route';

// The caller's signed-in devices (sessions still in use), the current one marked. Tokens never leave the server.
export const GET = sessionRoute({}, async (_req, person, { tx }) => ({
  data: await listSessions(tx, person.userId, person.sessionId),
}));
