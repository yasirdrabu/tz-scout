import { attachFile } from '@/modules/intake';
import { FILE_MAX_BYTES, FORM_SLACK, readUpload } from '../../../_lib/intake';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const POST = v1Route({ permission: 'arrivals:write', maxBytes: FILE_MAX_BYTES + FORM_SLACK }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const { fileName, contentType, bytes } = await readUpload(req, FILE_MAX_BYTES);
  return created(await attachFile(ctx, id, { fileName, contentType, bytes }));
});
