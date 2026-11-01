import { z } from 'zod';
import {
  KIND_LABELS,
  LIST_HAS_NO_KEYS,
  SOURCE_KINDS,
  hasCrmSource,
  listSources,
  registerSource,
  newSourceDetail,
  sourceViews,
  type RegisterSourceInput,
  type SourceKind,
} from '@/modules/intake';
import { createKeyWithAccess, memberRole } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';

const createSourceBody = z
  .strictObject({
    kind: z.enum(SOURCE_KINDS),
    name: z.string(),
    parent_id: z.string(),
    user_id: z.string(),
    owner_user_id: z.string().nullable(),
    daily_arrival_cap: z.number(),
    initial_review_status_key: z.string(),
    settings: z.record(z.string(), z.unknown()),
    create_key: z.boolean(),
  })
  .partial()
  .required({ kind: true, name: true });

const bad = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });
const many = (q: URLSearchParams, name: string) =>
  q
    .getAll(name)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The registry as a tree (§10). `kind` may repeat; `status` is `active,paused` by default or `archived`; `q` is
 * part of a name. `meta.counts_by_kind` counts every kind under the status and search, so the Type filter keeps its
 * options; `can_add_crm` is false once the workspace has its HubSpot source (Ruling 5).
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const kinds = many(url.searchParams, 'kind');
  for (const k of kinds) if (!SOURCE_KINDS.includes(k as SourceKind)) throw bad('kind', `Kind must be one of ${SOURCE_KINDS.join(', ')}.`);
  const status = many(url.searchParams, 'status');
  if (status.some((s) => !['active', 'paused', 'archived'].includes(s))) throw bad('status', 'Status must be active, paused or archived.');
  const q = url.searchParams.get('q') ?? undefined;
  const all = await listSources(ctx, { statuses: status as ('active' | 'paused' | 'archived')[], q });
  const counts = Object.fromEntries(SOURCE_KINDS.map((k) => [k, 0])) as Record<SourceKind, number>;
  for (const r of all) counts[r.kind]++;
  const rows = kinds.length ? all.filter((r) => kinds.includes(r.kind)) : all;
  const page = pageOfList(req, rows);
  return {
    data: await sourceViews(ctx, page.data),
    nextCursor: page.nextCursor,
    meta: { countsByKind: counts, kindLabels: KIND_LABELS, canAddCrm: !(await hasCrmSource(ctx)) },
  };
});

// A key in the response must not be stored for a replay, so a create with a key is not idempotent.
const withKey = (body: unknown) => !!body && typeof body === 'object' && (body as { create_key?: unknown }).create_key === true;

/**
 * Adds a source (§12). With `create_key`, an agent or partner also gets a key that sends and checks status, shown
 * in this response only (Decision 14).
 */
export const POST = v1Route({ permission: 'sources:manage', idempotent: (body) => !withKey(body) }, async (req, principal, ctx) => {
  const { createKey, ...input } = await parseBody<RegisterSourceInput & { createKey?: boolean }>(req, createSourceBody);
  if (input.userId && !(await memberRole(ctx, input.userId))) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'That person is not a member of this workspace.' });
  }
  if (createKey && input.kind === 'list') throw bad('create_key', LIST_HAS_NO_KEYS);
  if (createKey && input.kind !== 'agent' && input.kind !== 'partner') throw bad('create_key', 'Only an agent or a partner gets a key when it is added.');
  const added = await registerSource(ctx, input);
  const key = createKey ? await createKeyWithAccess(ctx, { name: `${added.name} key`, access: 'send_and_status', sourceId: added.id }, principal) : null;
  return created({
    ...(await newSourceDetail(ctx, added)),
    ...(key ? { apiKey: { id: key.id, prefix: key.prefix, secret: key.secret, environment: key.environment, createdAt: key.createdAt } } : {}),
  });
});
