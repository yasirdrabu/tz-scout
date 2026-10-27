import { createImport } from '@/modules/intake';
import { FORM_SLACK, IMPORT_MAX_BYTES, readUpload } from '../_lib/intake';
import { accepted, v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

// A multi-sheet workbook without `sheet` stores nothing; the answer lists the sheets (200).
export const POST = v1Route({ permission: 'imports:run', maxBytes: IMPORT_MAX_BYTES + FORM_SLACK }, async (req, _principal, ctx) => {
  const { fileName, contentType, bytes, fields } = await readUpload(req, IMPORT_MAX_BYTES, ['sheet', 'vendor_source_id']);
  const r = await createImport(ctx, {
    fileName,
    contentType,
    bytes,
    ...(fields.sheet ? { sheet: fields.sheet } : {}),
    ...(fields.vendor_source_id ? { vendorSourceId: fields.vendor_source_id } : {}),
  });
  if (r.status === 'needs_sheet') return r;
  return accepted({
    importId: r.id,
    batchId: r.batchId,
    status: r.status,
    layout: r.layout,
    proposedMapping: r.mapping,
    needsConfirm: r.status === 'needs_confirm',
    headers: r.headers,
    rowCount: r.rowCount,
    sha256: r.sha256,
  });
});
