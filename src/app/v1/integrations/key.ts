import { idAndAction, notFound } from '../_lib/path';

/** The service key in `/v1/integrations/{key}/...`; a path with an action there is a 404. */
export function integrationKey(req: Request): string {
  const { id, action } = idAndAction(req, 'integrations');
  if (action) throw notFound();
  return id;
}

/** Every write here is a person's (api-gaps: integrations). */
export const MANAGE = { permission: 'integrations:manage', peopleOnly: true } as const;
