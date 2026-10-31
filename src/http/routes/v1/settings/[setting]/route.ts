import { resetReviewSettings } from '@/modules/routing';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

type Handler = (req: Request) => Promise<Response>;
const unknown = v1Route({}, async () => {
  throw notFound();
});

/** `POST /api/v1/settings/{setting}:{action}`. Static settings paths win over this one, so it only sees actions. */
const actions: Record<string, Handler> = {
  /** Decision 2: `Restore defaults` for review statuses, reasons and auto-accept. */
  'review:reset': v1Route({ permission: 'settings:manage', peopleOnly: true }, async (_req, _principal, ctx) => resetReviewSettings(ctx)),
};

export const POST: Handler = (req) => {
  let key: string | null = null;
  try {
    const { id, action } = idAndAction(req, 'settings');
    key = action ? `${id}:${action}` : null;
  } catch {
    // A malformed path is handled by the 404 route.
  }
  return (key && Object.hasOwn(actions, key) ? actions[key]! : unknown)(req);
};
export const GET = unknown;
export const PUT = unknown;
export const PATCH = unknown;
export const DELETE = unknown;
