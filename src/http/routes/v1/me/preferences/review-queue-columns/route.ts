import { z } from 'zod';
import { getQueueColumns, resetQueueColumns, setQueueColumns, type ColumnChoice } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ columns: z.array(z.strictObject({ key: z.string(), visible: z.boolean() })) });
const opts = { permission: 'review:act', peopleOnly: true } as const;

/** The caller's review queue columns, in order, or the default ("Saved for you only."). */
export const GET = v1Route(opts, async (_req, _principal, ctx) => getQueueColumns(ctx));

/** Every column once, in the order wanted, each shown or hidden. */
export const PUT = v1Route(opts, async (req, _principal, ctx) => setQueueColumns(ctx, (await parseBody<{ columns: ColumnChoice[] }>(req, body)).columns));

/** `Reset`: back to the default columns. */
export const DELETE = v1Route(opts, async (_req, _principal, ctx) => resetQueueColumns(ctx));
