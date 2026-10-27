import { getAccount, getFacts } from '@/modules/accounts';
import { can } from '@/modules/tenancy';
import { pageOfList } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { CONTACT_KEYS } from '../../respond';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  const q = new URL(req.url).searchParams;
  const facts = await getFacts(ctx, account.id, {
    key: q.get('field') ?? undefined,
    includeHistory: q.get('include') === 'history',
  });
  // TEN-E3-S3-AC1: a person's contact facts need people:read too.
  const shown = can(principal, 'people:read') ? facts : facts.filter((f) => !(f.personId && CONTACT_KEYS.has(f.key)));
  return pageOfList(req, shown);
});
