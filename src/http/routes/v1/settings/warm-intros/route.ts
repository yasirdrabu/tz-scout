import { listRelationshipDefaults } from '@/modules/intake';
import { pageOfList } from '../../_lib/pagination';
import { v1Route } from '../../_lib/v1-route';

export const GET = v1Route({ platformAdminOnly: 'Only a platform admin can change these in this release.' }, async (req, _principal, ctx) =>
  pageOfList(req, await listRelationshipDefaults(ctx)),
);
