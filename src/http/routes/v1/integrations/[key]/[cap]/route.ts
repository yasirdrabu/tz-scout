import { z } from 'zod';
import { allowOverage, integration, setCapLimit, type CapView } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { parseBody } from '../../../_lib/body';
import { notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { MANAGE, integrationKey } from '../../key';

// This directory is `[cap]`, not `cap`, because the route table has one file per path and
// `cap:allow-overage` cannot be a directory name; it serves /cap (PUT) and /cap:allow-overage (POST).
const body = z.strictObject({ limit: z.number() });

/** The segment after the service key: `cap` or `cap:allow-overage`. */
function capSegment(req: Request): string {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  try {
    return decodeURIComponent(parts[parts.indexOf('integrations') + 2] ?? '');
  } catch {
    throw notFound();
  }
}

/** Sets the service's usage limit (a whole number of 1 or more); returns the new `cap`. */
export const PUT = v1Route(MANAGE, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  if (capSegment(req) !== 'cap') throw notFound();
  const { limit } = await parseBody<{ limit: number }>(req, body);
  await setCapLimit(ctx, key, limit);
  return currentCap(ctx, key);
});

/** `POST /api/v1/integrations/{key}/cap:allow-overage` lets the service go over its limit until the period resets; returns the `cap`. */
export const POST = v1Route(MANAGE, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  if (capSegment(req) !== 'cap:allow-overage') throw notFound();
  await allowOverage(ctx, key);
  return currentCap(ctx, key);
});

async function currentCap(ctx: ModuleContext, key: string): Promise<CapView> {
  const { cap } = await integration(ctx, key);
  if (!cap) throw notFound();
  return cap;
}
