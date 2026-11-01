import type { SearchSort } from '@/modules/accounts';
import { normaliseDomain } from '@/modules/intake';
import type { AccountListFilters } from '@/modules/routing';
import { ScoutError } from '@/platform/errors';

const SORTS: SearchSort[] = ['priority', 'last_signal', 'created', 'name', 'stage_priority'];
const bad = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path, message }] });
const many = (q: URLSearchParams, name: string) =>
  q
    .getAll(name)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);

/** All accounts' query string (screens.md §8). `stage` and `review_status` may repeat or be comma separated; `owner_user_id` takes `me`. */
export function accountFilters(url: URL): AccountListFilters {
  const q = url.searchParams;
  const asked = q.get('domain');
  const domain = asked ? normaliseDomain(asked) : undefined;
  if (domain === null) throw bad('domain', 'Use a domain like acme.com.');
  const sort = q.get('sort') || undefined;
  if (sort && !SORTS.includes(sort as SearchSort)) throw bad('sort', `Sort by one of ${SORTS.join(', ')}.`);
  const unassigned = q.get('unassigned');
  if (unassigned && unassigned !== 'true' && unassigned !== 'false') throw bad('unassigned', 'Use true or false.');
  const stages = many(q, 'stage');
  const statuses = many(q, 'review_status');
  return {
    text: q.get('q') ?? undefined,
    domain,
    tier: q.get('tier') || undefined,
    practiceId: q.get('practice_id') || undefined,
    offerId: q.get('offer_id') || undefined,
    sourceId: q.get('source_id') || undefined,
    stages: stages.length ? stages : undefined,
    ownerUserId: q.get('owner_user_id') || undefined,
    unassigned: unassigned === 'true',
    reviewStatusKeys: statuses.length ? statuses : undefined,
    sort: sort as SearchSort | undefined,
  };
}
