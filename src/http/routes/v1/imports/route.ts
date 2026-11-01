import { createImport, getImport } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { FORM_SLACK, IMPORT_MAX_BYTES, importExtras, readUpload, withoutReasons } from '../_lib/intake';
import { accepted, v1Route } from '../_lib/v1-route';

/**
 * Uploads a file to import. `source_id` credits another source (Ruling 10: a person with `sources:manage`, naming an
 * active person, partner or list source); `notes` and `name` describe the batch. The 202 carries what the Match step
 * shows. A multi-sheet workbook without `sheet` stores nothing; the answer lists the sheets (200).
 */
export const POST = v1Route({ permission: 'imports:run', maxBytes: IMPORT_MAX_BYTES + FORM_SLACK }, async (req, principal, ctx) => {
  const { fileName, contentType, bytes, fields } = await readUpload(req, IMPORT_MAX_BYTES, ['sheet', 'vendor_source_id', 'source_id', 'notes', 'name']);
  const r = await createImport(ctx, {
    fileName,
    contentType,
    bytes,
    ...(fields.sheet ? { sheet: fields.sheet } : {}),
    ...(fields.vendor_source_id ? { vendorSourceId: fields.vendor_source_id } : {}),
    ...(fields.source_id ? { sourceId: fields.source_id } : {}),
    ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    canCredit: principal.kind === 'user' && can(principal, 'sources:manage'),
  });
  if (r.status === 'needs_sheet') return r;
  const view = (await getImport(ctx, r.id))!;
  return accepted({
    importId: r.id,
    batchId: r.batchId,
    status: r.status,
    layout: r.layout,
    proposedMapping: can(principal, 'people:read') ? r.mapping : withoutReasons(r.mapping),
    needsConfirm: r.status === 'needs_confirm',
    headers: r.headers,
    rowCount: r.rowCount,
    sha256: r.sha256,
    ...importExtras(view, can(principal, 'people:read')),
  });
});
