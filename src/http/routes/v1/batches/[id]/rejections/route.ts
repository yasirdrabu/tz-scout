import { rejectionRows } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { attachment, csvLine } from '../../../_lib/intake';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * `GET /batches/{id}/rejections?format=csv` (§13 Download error report): the rejected rows the caller may see, as CSV
 * with `row,company,website,reason,detail`. The contact columns (person, email, phone) come only with `people:read`.
 * Cells a spreadsheet would read as a formula are escaped.
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  if ((new URL(req.url).searchParams.get('format') ?? 'csv') !== 'csv') {
    const title = 'The error report comes as CSV: use format=csv.';
    throw new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path: 'format', message: title }] });
  }
  const rows = await rejectionRows(ctx, id);
  if (!rows) throw notFound();
  const contacts = can(principal, 'people:read');
  const header = ['row', 'company', 'website', 'reason', 'detail', ...(contacts ? ['person', 'email', 'phone'] : [])];
  const lines = [
    header.join(','),
    ...rows.map((r) => csvLine([r.row, r.company, r.website, r.reason, r.detail, ...(contacts ? [r.person, r.email, r.phone] : [])])),
  ];
  return new Response(`${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': attachment(`${id}-rejected.csv`),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});
