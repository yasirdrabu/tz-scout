import { z } from 'zod';
import { setRelationshipDefault } from '@/modules/intake';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const pointsBody = z.strictObject({ points: z.number() });

/** Platform admins only in R1 (SRC-E5). Nothing is published: warm-intro points don't feed scoring until a later release. */
export const PUT = v1Route(
  { platformAdminOnly: 'Only a platform admin can change these in this release.', peopleOnly: true },
  async (req, _principal, ctx) => {
    const { id: key, action } = idAndAction(req, 'warm-intros');
    if (action) throw notFound();
    return setRelationshipDefault(ctx, key, (await parseBody<{ points: number }>(req, pointsBody)).points);
  },
);
