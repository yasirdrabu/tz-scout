import { z } from 'zod';
import { confirmImport, getImport, previewImport } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { JSON_MAX_BYTES, limited, withoutContacts } from '../../_lib/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const column = z.strictObject({
  header: z.string(),
  target: z.string().nullable(),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().default('Chosen by a person.'),
});
const mappingBody = z.strictObject({ mapping: z.array(column) });
const previewBody = z.strictObject({ mapping: z.array(column).optional() });

export const GET = v1Route({ permission: 'imports:run' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'imports');
  if (action) throw notFound();
  const found = await getImport(ctx, id);
  if (!found) throw notFound();
  return found;
});

// POST /v1/imports/{id}:preview and /v1/imports/{id}:confirm
export const POST = v1Route({ permission: 'imports:run' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'imports');
  if (action !== 'preview' && action !== 'confirm') throw notFound();
  const body = await limited(req, JSON_MAX_BYTES);
  if (action === 'confirm') {
    const { mapping } = await parseBody<z.infer<typeof mappingBody>>(body, mappingBody);
    await confirmImport(ctx, id, mapping);
    return accepted({ importId: id, status: 'queued' });
  }
  const given = (await body.clone().text()).trim()
    ? (await parseBody<z.infer<typeof previewBody>>(body, previewBody)).mapping
    : undefined;
  const preview = await previewImport(ctx, id, given);
  return can(principal, 'people:read') ? preview : withoutContacts(preview);
});
