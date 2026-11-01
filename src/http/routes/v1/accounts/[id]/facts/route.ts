import { getAccount, getFacts } from '@/modules/accounts';
import { sourceNames } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { pageOfList } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { CONTACT_KEYS } from '../../respond';

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
  // Each source in the fact's chain by name, for the page's `{source} · {date}` (no arrivals:read needed).
  const chain = (f: (typeof shown)[number]) => [f.sourceChain.personSourceId, f.sourceChain.agentSourceId, f.sourceChain.vendorSourceId];
  const names = await sourceNames(ctx, [...new Set(shown.flatMap(chain).filter((x): x is string => !!x))]);
  const name = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  return pageOfList(
    req,
    shown.map((f) => ({ ...f, sourceNames: { person: name(f.sourceChain.personSourceId), agent: name(f.sourceChain.agentSourceId), vendor: name(f.sourceChain.vendorSourceId) } })),
  );
});
