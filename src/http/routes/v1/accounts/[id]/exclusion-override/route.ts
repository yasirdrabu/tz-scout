import { removeExclusionOverride } from '@/modules/accounts';
import { idAndAction, notFound } from '../../../_lib/path';
import { noContent, v1Route } from '../../../_lib/v1-route';

export const DELETE = v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  await removeExclusionOverride(ctx, id);
  return noContent();
});
