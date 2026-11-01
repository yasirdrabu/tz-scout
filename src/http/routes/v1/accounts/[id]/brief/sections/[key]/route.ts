import { z } from 'zod';
import { editSection } from '@/modules/playbooks';
import { parseBody } from '../../../../../_lib/body';
import { idAndAction, notFound } from '../../../../../_lib/path';
import { v1Route } from '../../../../../_lib/v1-route';

const body = z.strictObject({ body: z.string(), if_version: z.number().int().positive().optional() });

/** PLB-E3-S2: a person's or API key's text for one of the four page sections, the whole body (Ruling 11). */
export const PUT = v1Route({ permission: 'playbooks:write', maxBytes: 16 * 1024 }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  let key: string;
  try {
    key = decodeURIComponent(new URL(req.url).pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    throw notFound();
  }
  const input = await parseBody<{ body: string; ifVersion?: number }>(req, body);
  return editSection(ctx, id, key, input);
});
