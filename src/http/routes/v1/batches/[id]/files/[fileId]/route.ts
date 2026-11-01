import { readBatchFile } from '@/modules/intake';
import { requirePermission } from '@/modules/tenancy';
import { attachment, safeContentType } from '../../../../_lib/intake';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

/**
 * `GET /batches/{id}/files/{file_id}` (§14 Download file): the original upload, as an attachment with its stored type.
 * It holds every contact cell, so it needs `people:read` too (403). A file of another batch, a batch the caller can't
 * see, or one they see only through an account, is a 404.
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  requirePermission(principal, 'people:read');
  const batch = idAndAction(req, 'batches');
  const file = idAndAction(req, 'files');
  if (batch.action || file.action) throw notFound();
  const found = await readBatchFile(ctx, batch.id, file.id);
  if (!found) throw notFound();
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      'content-type': safeContentType(found.contentType),
      'content-length': String(found.bytes.byteLength),
      'content-disposition': attachment(found.fileName),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
});
