import { z } from 'zod';
import { confirmImport, discardImport, getImport, previewImport } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { importExtras, withoutContacts, withoutReasons } from '../../_lib/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, noContent, v1Route } from '../../_lib/v1-route';

const column = z.strictObject({
  header: z.string(),
  target: z.string().nullable(),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().default('Chosen by a person.'),
});
const mappingBody = z.strictObject({ mapping: z.array(column) });
const previewBody = z.strictObject({ mapping: z.array(column).optional() });

export const GET = v1Route({ permission: 'imports:run' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'imports');
  if (action) throw notFound();
  const found = await getImport(ctx, id);
  if (!found) throw notFound();
  const peopleRead = can(principal, 'people:read');
  const mapping = peopleRead ? found.mapping : withoutReasons(found.mapping);
  return { ...found, ...importExtras(found, peopleRead), mapping };
});

// POST /api/v1/imports/{id}:preview and /api/v1/imports/{id}:confirm
export const POST = v1Route({ permission: 'imports:run' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'imports');
  if (action !== 'preview' && action !== 'confirm') throw notFound();
  const body = req;
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

/** Ruling 11: discards an import that waits for its columns to be confirmed (`Use a different file`). Again is a 204 too. */
export const DELETE = v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'imports');
  if (action) throw notFound();
  await discardImport(ctx, id);
  return noContent();
});
