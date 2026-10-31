import { endSessions } from '@/modules/tenancy';
import { idAndAction, notFound } from '../_lib/path';
import { noContent, publicRoute, sessionRoute } from '../_lib/v1-route';

/**
 * Actions on a top-level resource, `POST /v1/{resource}:{action}`. Static routes such as `/v1/me`
 * win over this one, so it only sees paths with an action. Today: `POST /v1/me:sign-out-everywhere`
 * ends every session of the caller, this one included, on every device and in every workspace.
 */
export const POST = sessionRoute({}, async (req, person, { tx }) => {
  const { id, action } = idAndAction(req, 'v1');
  if (id !== 'me' || action !== 'sign-out-everywhere') throw notFound();
  await endSessions(tx, person.userId);
  return noContent();
});

/** Any other method on an unknown top-level path is the API's problem+json 404, not Next's empty 405. */
const unknown = publicRoute(async () => {
  throw notFound();
});
export const GET = unknown;
export const PUT = unknown;
export const PATCH = unknown;
export const DELETE = unknown;
