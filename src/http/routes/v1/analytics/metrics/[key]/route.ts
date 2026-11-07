import { metricDetail } from '@/modules/analytics';
import { idAndAction } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** The drawer behind an Overview number (R3c-1 Rulings 12-13): the key in the path, its row in `?stage=&seller=&offer=&practice=`. */
export const GET = v1Route({ permission: 'analytics:read' }, async (req, _principal, ctx) => {
  const q = new URL(req.url).searchParams;
  const param = (k: string) => q.get(k) || undefined;
  return metricDetail(ctx, idAndAction(req, 'metrics').id, { stage: param('stage'), seller: param('seller'), offer: param('offer'), practice: param('practice') });
});
