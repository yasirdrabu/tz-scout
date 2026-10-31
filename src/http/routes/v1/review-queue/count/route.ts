import { countQueue } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';
import { queueFilters } from '../filters';

/** REV-E1-S1-AC4: how many accounts the same filters would list, under the caller's data limit. */
export const GET = v1Route({ permission: 'review:act' }, async (req, _principal, ctx) => ({ count: await countQueue(ctx, queueFilters(new URL(req.url))) }));
