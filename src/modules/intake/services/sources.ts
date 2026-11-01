import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { activeAccountIds, type SourceAccessProvider, type SourceChain, type SourceInfoProvider } from '@/modules/accounts';
import { memberRole, members, revokeKeysForSource, type SourceValidator } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { reviewStatusValidator } from '../contracts/ports';
import { arrival, source } from '../db/schema';

export const SOURCE_KINDS = ['person', 'agent', 'vendor', 'list', 'partner', 'crm', 'web_form', 'scheduled_pull'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** `removed` (Decision 13, Ruling 2) is a source that never sent and was taken away: a 404 everywhere. */
export type SourceStatus = 'active' | 'paused' | 'archived' | 'removed';

/** SRC-E1: sources a person stands behind start as `needs_review`, the rest as `unvetted`. A list is a person's upload. */
export const DEFAULT_REVIEW_STATUS: Record<SourceKind, string> = {
  person: 'needs_review',
  list: 'needs_review',
  crm: 'needs_review',
  web_form: 'needs_review',
  agent: 'unvetted',
  vendor: 'unvetted',
  partner: 'unvetted',
  scheduled_pull: 'unvetted',
};

/** The kind a parent must have, for the kinds that need one. A list sits under a person, as an agent does (Ruling 1). */
const PARENT_KIND: Partial<Record<SourceKind, { kind: SourceKind; copy: string }>> = {
  agent: { kind: 'person', copy: 'An agent needs an owner. Pick the person who runs it.' },
  list: { kind: 'person', copy: 'A list needs an owner. Pick the person who uploads it.' },
  scheduled_pull: { kind: 'vendor', copy: 'A scheduled pull needs a vendor.' },
};

/** Ruling 1: a list gets its accounts from files, so it never holds keys. */
export const LIST_HAS_NO_KEYS = 'A list gets its accounts from files, not the API.';
/** Ruling 5: Scout polls the one seeded HubSpot source. */
export const ONE_CRM_SOURCE = 'This workspace already syncs from HubSpot.';

export const MAX_DAILY_CAP = 10_000;

export type SourceView = {
  id: string;
  kind: SourceKind;
  name: string;
  parentId: string | null;
  userId: string | null;
  ownerUserId: string | null;
  status: SourceStatus;
  initialReviewStatusKey: string;
  dailyArrivalCap: number;
  trust: number;
  settings: Record<string, unknown>;
  createdAt: Date;
};

export type RegisterSourceInput = {
  kind: SourceKind;
  name: string;
  parentId?: string;
  userId?: string;
  /** Who answers for it (Decision 11). Left out: its person, its parent's person, else the creating person (Ruling 3). */
  ownerUserId?: string | null;
  dailyArrivalCap?: number;
  initialReviewStatusKey?: string;
  settings?: Record<string, unknown>;
};

export type SourcePatch = {
  name?: string;
  status?: Exclude<SourceStatus, 'removed'>;
  ownerUserId?: string | null;
  dailyArrivalCap?: number;
  initialReviewStatusKey?: string;
};

const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That source was not found.' });
const conflict = (slug: string, title: string, errors?: { path: string; message: string }[]) =>
  new ScoutError({ slug, status: 409, title, ...(errors ? { errors } : {}) });
const NAME_NEEDED = 'Give the source a name so its batches can be traced back to it.';
const nameTaken = (name: string) => {
  const title = `A source called ${name} already exists. Pick another name.`;
  return conflict('conflict', title, [{ path: 'name', message: title }]);
};

/** A starting status the tenant picked must be one of its active review statuses (once routing is registered). */
async function checkReviewStatus(ctx: ModuleContext, key: string | undefined): Promise<void> {
  if (key && !(await reviewStatusValidator().exists(ctx, key))) throw invalid('Pick a review status from your list.');
}

type Row = typeof source.$inferSelect;

function view(r: Row): SourceView {
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    name: r.name,
    parentId: r.parentId,
    userId: r.userId,
    ownerUserId: r.ownerUserId,
    status: r.status as SourceStatus,
    initialReviewStatusKey: r.initialReviewStatusKey ?? DEFAULT_REVIEW_STATUS[r.kind as SourceKind],
    dailyArrivalCap: r.dailyArrivalCap,
    trust: r.trust,
    settings: (r.settings ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
  };
}

function checkCap(cap: number | undefined): void {
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0 && cap <= MAX_DAILY_CAP)) {
    throw invalid('The daily limit must be between 0 and 10,000.');
  }
}

function checkName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  if (!trimmed) throw new ScoutError({ slug: 'validation', status: 400, title: NAME_NEEDED, errors: [{ path: 'name', message: NAME_NEEDED }] });
  return trimmed;
}

/** 409 when another source that is not removed has this name, ignoring case. */
async function checkNameFree(ctx: ModuleContext, name: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx
    .select({ id: source.id })
    .from(source)
    .where(
      and(
        eq(source.tenantId, ctx.tenantId),
        ne(source.status, 'removed'),
        sql`lower(${source.name}) = lower(${name})`,
        exceptId ? ne(source.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (row) throw nameTaken(name);
}

/** The owner must be a member of the workspace (Ruling 3). */
async function checkOwner(ctx: ModuleContext, userId: string | null | undefined): Promise<void> {
  if (userId && !(await memberRole(ctx, userId))) throw invalid('That person is not a member of this workspace.');
}

/** One source in the context's tenant, or undefined. A removed source is gone (Ruling 2). */
export async function loadSource(ctx: ModuleContext, id: string): Promise<Row | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, id), ne(source.status, 'removed')));
  return row;
}

/** Sources directly under this one that still count: not archived or removed. */
async function liveChildCount(ctx: ModuleContext, id: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.parentId, id), inArray(source.status, ['active', 'paused'])));
  return row?.n ?? 0;
}

/** Whether any arrival credits the source anywhere in its chain (Ruling 2). */
export async function hasSent(ctx: ModuleContext, id: string): Promise<boolean> {
  const [row] = await ctx.tx
    .select({ id: arrival.id })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), or(eq(arrival.personSourceId, id), eq(arrival.agentSourceId, id), eq(arrival.vendorSourceId, id))))
    .limit(1);
  return !!row;
}

const hasChildren = (name: string) => conflict('source-has-children', `Remove or archive the sources under ${name} first.`);

/** Each given source's name, by id, in the context's tenant; unknown ids are left out. */
export async function sourceNames(ctx: ModuleContext, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ id: source.id, name: source.name })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), inArray(source.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return err.code === '23505' || err.cause?.code === '23505';
};

/**
 * Registers a source. Agents and lists need a person parent and scheduled pulls a vendor parent; one person source
 * per user; names are unique among sources that are not removed, ignoring case (except a person source made for a
 * member, `opts.namedAfterPerson`, since two people can share a name); one CRM source (Ruling 5).
 */
export async function registerSource(ctx: ModuleContext, input: RegisterSourceInput, opts: { namedAfterPerson?: boolean } = {}): Promise<SourceView> {
  if (!SOURCE_KINDS.includes(input.kind)) throw invalid('Pick a kind of source.');
  const name = checkName(input.name ?? '')!;
  checkCap(input.dailyArrivalCap);
  await checkReviewStatus(ctx, input.initialReviewStatusKey?.trim());

  const needs = PARENT_KIND[input.kind];
  let parent: Row | undefined;
  if (needs) {
    parent = input.parentId ? await loadSource(ctx, input.parentId) : undefined;
    if (!parent || parent.kind !== needs.kind || parent.status === 'archived') {
      throw new ScoutError({ slug: 'validation', status: 400, title: needs.copy, errors: [{ path: 'parent_id', message: needs.copy }] });
    }
  } else if (input.parentId) {
    throw invalid('Only agents, lists and scheduled pulls have a parent source.');
  }
  if (input.userId && input.kind !== 'person') throw invalid('Only a person source can be linked to a user.');
  const taken = () => invalid('This person already has a source.');
  if (input.userId && (await personSourceFor(ctx, input.userId))) throw taken();
  if (!opts.namedAfterPerson) await checkNameFree(ctx, name);
  if (input.kind === 'crm') {
    const [crm] = await ctx.tx
      .select({ id: source.id })
      .from(source)
      .where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'crm'), ne(source.status, 'removed')))
      .limit(1);
    if (crm) throw conflict('conflict', ONE_CRM_SOURCE);
  }
  await checkOwner(ctx, input.ownerUserId);
  const ownerUserId =
    input.ownerUserId !== undefined
      ? input.ownerUserId
      : input.kind === 'person'
        ? (input.userId ?? null)
        : parent?.kind === 'person'
          ? parent.userId
          : ctx.actor.kind === 'user'
            ? ctx.actor.id
            : null;

  const values = {
    id: newId('src'),
    tenantId: ctx.tenantId,
    kind: input.kind,
    name,
    parentId: input.parentId ?? null,
    userId: input.userId ?? null,
    ownerUserId,
    initialReviewStatusKey: input.initialReviewStatusKey?.trim() || DEFAULT_REVIEW_STATUS[input.kind],
    dailyArrivalCap: input.dailyArrivalCap ?? 500,
    settings: input.settings ?? {},
  };
  try {
    // A savepoint, so a race on the one-person-source rule does not abort the caller's transaction.
    const [row] = await ctx.tx.transaction((sp) => sp.insert(source).values(values).returning());
    return view(row!);
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
}

/** Changes a source. Archiving it revokes its keys; a paused or archived source stores nothing more. */
export async function updateSource(ctx: ModuleContext, id: string, patch: SourcePatch): Promise<SourceView> {
  const visible = await visibleSourceIds(ctx);
  const current = await loadSource(ctx, id);
  if (!current || (visible && !visible.includes(id))) throw notFound();
  // Archived is final: its keys are revoked, so a new source is the way back.
  if (current.status === 'archived' && patch.status !== undefined && patch.status !== 'archived') {
    throw new ScoutError({
      slug: 'conflict',
      status: 409,
      title: "An archived source can't be reactivated. Create a new source.",
    });
  }
  const name = checkName(patch.name);
  checkCap(patch.dailyArrivalCap);
  if (patch.status !== undefined && !['active', 'paused', 'archived'].includes(patch.status)) {
    throw invalid('Status must be active, paused or archived.');
  }
  const initialReviewStatusKey = patch.initialReviewStatusKey?.trim();
  if (patch.initialReviewStatusKey !== undefined && !initialReviewStatusKey) throw invalid('Pick a starting review status.');
  await checkReviewStatus(ctx, initialReviewStatusKey);
  if (name !== undefined && name.toLowerCase() !== current.name.toLowerCase()) await checkNameFree(ctx, name, id);
  await checkOwner(ctx, patch.ownerUserId);
  const archiving = patch.status === 'archived' && current.status !== 'archived';
  if (archiving && (await liveChildCount(ctx, id)) > 0) throw hasChildren(current.name);

  const [row] = await ctx.tx
    .update(source)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
      ...(patch.dailyArrivalCap !== undefined ? { dailyArrivalCap: patch.dailyArrivalCap } : {}),
      ...(initialReviewStatusKey ? { initialReviewStatusKey } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, id)))
    .returning();
  if (archiving) await revokeKeysForSource(ctx, id);
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== current.ownerUserId) {
    await audit(ctx, {
      action: 'intake.source.owner_changed',
      subject: { type: 'source', id },
      before: { ownerUserId: current.ownerUserId },
      after: { ownerUserId: patch.ownerUserId },
    });
  }
  return view(row!);
}

/**
 * Removes a source that has sent nothing (Decision 13, Ruling 2): it becomes `removed`, a 404 everywhere, and its
 * keys are revoked. One that has sent can only be archived; one with live sources under it waits for them.
 */
export async function removeSource(ctx: ModuleContext, id: string): Promise<void> {
  const visible = await visibleSourceIds(ctx);
  const current = await loadSource(ctx, id);
  if (!current || (visible && !visible.includes(id))) throw notFound();
  if (await hasSent(ctx, id)) throw conflict('source-has-sent', `${current.name} has sent accounts, so it can only be archived.`);
  if ((await liveChildCount(ctx, id)) > 0) throw hasChildren(current.name);
  await ctx.tx
    .update(source)
    .set({ status: 'removed', updatedAt: new Date() })
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, id)));
  await revokeKeysForSource(ctx, id, 'Source removed');
  await audit(ctx, { action: 'intake.source.removed', subject: { type: 'source', id }, before: { name: current.name, kind: current.kind, status: current.status } });
}

/** Every source below the given ones (agents under a person, scheduled pulls under a vendor), at any depth. */
export async function childSources(ctx: ModuleContext, sourceIds: string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const ids = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await ctx.tx.execute(sql`
    with recursive below(id) as (
      select s.id from intake.source s where s.tenant_id = ${ctx.tenantId} and s.parent_id in (${ids})
      union
      select s.id from intake.source s join below b on s.parent_id = b.id where s.tenant_id = ${ctx.tenantId}
    )
    select id from below order by id
  `)) as unknown as { id: string }[];
  const given = new Set(sourceIds);
  return rows.map((r) => r.id).filter((id) => !given.has(id));
}

/**
 * For seeding: a person source still named by one of its person's stale names (an email handle) takes the person's name.
 * Safe to run again. Returns how many it renamed.
 */
export async function renamePersonSources(ctx: ModuleContext, people: readonly { userId: string; name: string; staleNames: readonly string[] }[]): Promise<number> {
  let renamed = 0;
  for (const p of people) {
    if (p.staleNames.length === 0) continue;
    const rows = await ctx.tx
      .update(source)
      .set({ name: p.name, updatedAt: new Date() })
      .where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'person'), eq(source.userId, p.userId), inArray(source.name, [...p.staleNames])))
      .returning({ id: source.id });
    renamed += rows.length;
  }
  return renamed;
}

/** The person source of a tenant user, if they have one. */
export async function personSourceFor(ctx: ModuleContext, userId: string): Promise<string | undefined> {
  const [row] = await ctx.tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'person'), eq(source.userId, userId)));
  return row?.id;
}

/** A member's person source, created on first use so every owner and new member can send from the web app. */
export async function ensurePersonSource(ctx: ModuleContext, userId: string): Promise<string | undefined> {
  const existing = await personSourceFor(ctx, userId);
  if (existing) return existing;
  const member = (await members(ctx)).find((m) => m.userId === userId);
  if (!member) return undefined;
  try {
    return (await registerSource(ctx, { kind: 'person', name: member.name.trim() || member.email.split('@')[0]!, userId }, { namedAfterPerson: true })).id;
  } catch (e) {
    // Lost a race to another request that made it first.
    const raced = await personSourceFor(ctx, userId);
    if (raced) return raced;
    throw e;
  }
}

function limitSourceIds(limit: DataLimit): string[] {
  if (limit.kind === 'sources') return limit.ids;
  if (limit.kind === 'any_of') return limit.limits.flatMap(limitSourceIds);
  return [];
}

/** The sources the principal may see: its own and the ones its limit names, with their children. Null means all. */
export async function visibleSourceIds(ctx: ModuleContext): Promise<string[] | null> {
  const access = ctx.access;
  if (!access || access.dataLimit.kind === 'all') return null;
  const roots = [...(access.sourceId ? [access.sourceId] : []), ...limitSourceIds(access.dataLimit)];
  return [...new Set([...roots, ...(await childSources(ctx, roots))])];
}

export type SourceListRow = SourceView & { arrivalsLast30Days: number; lastSentAt: Date | null; hasSent: boolean };

export type SourceListFilter = {
  /** Default `active` and `paused`; archived sources show only when asked for (Ruling 2). Removed ones never do. */
  statuses?: Exclude<SourceStatus, 'removed'>[];
  kinds?: SourceKind[];
  /** Part of the name, ignoring case. */
  q?: string;
};

/** Per source: arrivals in the last 30 days, the latest arrival and whether any arrival credits it, over every chain column. */
async function arrivalStats(ctx: ModuleContext, ids: string[], now: Date): Promise<Map<string, { recent: number; last: Date | null }>> {
  if (ids.length === 0) return new Map();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await ctx.tx.execute(sql`
    select c.sid as id, count(*) filter (where a.received_at >= ${since.toISOString()}::timestamptz)::int as recent, max(a.received_at) as last
    from intake.arrival a
    cross join lateral (values (a.person_source_id), (a.agent_source_id), (a.vendor_source_id)) as c(sid)
    where a.tenant_id = ${ctx.tenantId} and c.sid in (${list})
    group by c.sid
  `)) as unknown as { id: string; recent: number; last: Date | string | null }[];
  return new Map(rows.map((r) => [r.id, { recent: Number(r.recent), last: r.last ? new Date(r.last) : null }]));
}

/**
 * The registry as a tree (each parent followed by its children, by name), limited to what the principal sees and
 * to the filter. A child whose parent is filtered out stands at the top.
 */
export async function listSources(ctx: ModuleContext, f: SourceListFilter = {}, now = new Date()): Promise<SourceListRow[]> {
  const visible = await visibleSourceIds(ctx);
  if (visible && visible.length === 0) return [];
  const statuses = f.statuses?.length ? f.statuses : (['active', 'paused'] as const);
  const q = f.q?.trim();
  const rows = await ctx.tx
    .select()
    .from(source)
    .where(
      and(
        eq(source.tenantId, ctx.tenantId),
        inArray(source.status, [...statuses]),
        visible ? inArray(source.id, visible) : undefined,
        f.kinds?.length ? inArray(source.kind, f.kinds) : undefined,
        q ? sql`${source.name} ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : undefined,
      ),
    )
    .orderBy(asc(source.name), asc(source.id));
  const stats = await arrivalStats(ctx, rows.map((r) => r.id), now);

  const shown = new Set(rows.map((r) => r.id));
  const children = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.parentId && shown.has(r.parentId)) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  }
  const out: SourceListRow[] = [];
  const walk = (r: Row) => {
    const s = stats.get(r.id);
    out.push({ ...view(r), arrivalsLast30Days: s?.recent ?? 0, lastSentAt: s?.last ?? null, hasSent: !!s });
    for (const c of children.get(r.id) ?? []) walk(c);
  };
  for (const r of rows) if (!r.parentId || !shown.has(r.parentId)) walk(r);
  return out;
}

/** How many live (active or paused) sources sit directly under each given source. */
export async function liveChildCounts(ctx: ModuleContext, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ parentId: source.parentId, n: sql<number>`count(*)::int` })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), inArray(source.parentId, ids), inArray(source.status, ['active', 'paused'])))
    .groupBy(source.parentId);
  return new Map(rows.map((r) => [r.parentId!, Number(r.n)]));
}

/** One source the principal may see, with its arrival numbers; undefined when removed, hidden or another tenant's. */
export async function readSource(ctx: ModuleContext, id: string, now = new Date()): Promise<SourceListRow | undefined> {
  const visible = await visibleSourceIds(ctx);
  const row = await loadSource(ctx, id);
  if (!row || (visible && !visible.includes(id))) return undefined;
  const s = (await arrivalStats(ctx, [id], now)).get(id);
  return { ...view(row), arrivalsLast30Days: s?.recent ?? 0, lastSentAt: s?.last ?? null, hasSent: !!s };
}

/** The source's ancestors and itself, root first, as `{id, name}`. */
export async function sourceBreadcrumb(ctx: ModuleContext, id: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let at: string | null = id;
  for (let depth = 0; at && depth < 10; depth++) {
    const [row] = await ctx.tx
      .select({ id: source.id, name: source.name, parentId: source.parentId })
      .from(source)
      .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, at)));
    if (!row) break;
    out.unshift({ id: row.id, name: row.name });
    at = row.parentId;
  }
  return out;
}

/** Whether the tenant already has its CRM source, so Add a source hides the CRM card (Ruling 5). */
export async function hasCrmSource(ctx: ModuleContext): Promise<boolean> {
  const [row] = await ctx.tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'crm'), ne(source.status, 'removed')))
    .limit(1);
  return !!row;
}

// ---- Port implementations (registered in src/entry/compose.ts) ----

const LEVEL_WEIGHTS = { personSourceId: 0.4, agentSourceId: 0.3, vendorSourceId: 0.3 } as const;
const NEW_SOURCE_TRUST = 0.6;

/** Tenancy's `SourceValidator`: a key or grant may send for a source that exists and is not archived. */
export const intakeSourceValidator: SourceValidator = {
  exists: async (ctx, sourceId) => {
    const row = await loadSource(ctx, sourceId);
    return !!row && row.status !== 'archived';
  },
};

/** Accounts' `SourceInfoProvider`. */
export const intakeSourceInfo: SourceInfoProvider = {
  /** 0.4 person, 0.3 agent, 0.3 vendor, re-weighted over the levels present. Every source is 0.60 until R3. */
  getTrust: async (ctx, chain) => {
    const levels = (Object.keys(LEVEL_WEIGHTS) as (keyof typeof LEVEL_WEIGHTS)[]).filter((k) => chain[k]);
    if (levels.length === 0) return NEW_SOURCE_TRUST;
    const rows = await ctx.tx
      .select({ id: source.id, trust: source.trust })
      .from(source)
      .where(and(eq(source.tenantId, ctx.tenantId), inArray(source.id, levels.map((k) => chain[k]!))));
    const trust = new Map(rows.map((r) => [r.id, r.trust]));
    const total = levels.reduce((s, k) => s + LEVEL_WEIGHTS[k], 0);
    return levels.reduce((s, k) => s + LEVEL_WEIGHTS[k] * (trust.get(chain[k]!) ?? NEW_SOURCE_TRUST), 0) / total;
  },
  /** Every source in the chain of an arrival that resolved to the account. */
  sourcesForAccount: async (ctx, accountId) => {
    const rows = await ctx.tx
      .selectDistinct({ person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
      .from(arrival)
      .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, accountId), eq(arrival.status, 'resolved')));
    return [...new Set(rows.flatMap((r) => [r.person, r.agent, r.vendor]).filter((id): id is string => !!id))];
  },
};

/** The distinct source chains of the resolved arrivals for these accounts. */
export async function chainsForAccount(ctx: ModuleContext, accountIds: string[]): Promise<SourceChain[]> {
  if (accountIds.length === 0) return [];
  const rows = await ctx.tx
    .selectDistinct({ person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), inArray(arrival.accountId, accountIds), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.personSourceId), asc(arrival.agentSourceId), asc(arrival.vendorSourceId));
  return rows.map((r) => ({
    ...(r.person ? { personSourceId: r.person } : {}),
    ...(r.agent ? { agentSourceId: r.agent } : {}),
    ...(r.vendor ? { vendorSourceId: r.vendor } : {}),
  }));
}

/** The highest trust over the accounts' chains, with the closest source (agent, else person, else vendor) of the winning chain. */
export async function bestTrustForAccounts(
  ctx: ModuleContext,
  accountIds: string[],
): Promise<{ trust: number; sourceId: string; sourceName: string } | null> {
  let best: { trust: number; sourceId: string } | null = null;
  for (const chain of await chainsForAccount(ctx, accountIds)) {
    // A chain with no source at all cannot be named, so the next-best chain wins instead.
    const sourceId = chain.agentSourceId ?? chain.personSourceId ?? chain.vendorSourceId;
    if (!sourceId) continue;
    const trust = await intakeSourceInfo.getTrust(ctx, chain);
    if (!best || trust > best.trust) best = { trust, sourceId };
  }
  if (!best) return null;
  const row = await loadSource(ctx, best.sourceId);
  return { trust: best.trust, sourceId: best.sourceId, sourceName: row?.name ?? best.sourceId };
}

/** Accounts with a resolved arrival from the source or any source below it, in id order, `limit` (at most 200) at a time. */
export async function accountIdsForSource(
  ctx: ModuleContext,
  sourceId: string,
  opts: { afterId?: string; limit?: number } = {},
): Promise<{ ids: string[]; nextAfterId: string | null }> {
  const limit = opts.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('Ask for 1 to 200 accounts at a time.');
  const sources = [sourceId, ...(await childSources(ctx, [sourceId]))];
  const found: string[] = [];
  let cursor = opts.afterId;
  // Archived and merged-away accounts are dropped, so read candidates in chunks until the page is full.
  for (;;) {
    const rows = await ctx.tx
      .selectDistinct({ id: arrival.accountId })
      .from(arrival)
      .where(
        and(
          eq(arrival.tenantId, ctx.tenantId),
          eq(arrival.status, 'resolved'),
          isNotNull(arrival.accountId),
          cursor ? gt(arrival.accountId, cursor) : undefined,
          or(inArray(arrival.personSourceId, sources), inArray(arrival.agentSourceId, sources), inArray(arrival.vendorSourceId, sources)),
        ),
      )
      .orderBy(asc(arrival.accountId))
      .limit(1000);
    const candidates = rows.map((r) => r.id!);
    found.push(...(await activeAccountIds(ctx, candidates)));
    if (found.length > limit || candidates.length < 1000) break;
    cursor = candidates[candidates.length - 1];
  }
  const ids = found.slice(0, limit);
  return { ids, nextAfterId: found.length > limit ? ids[ids.length - 1]! : null };
}

/** Accounts' `SourceAccessProvider`. */
export const intakeSourceAccess: SourceAccessProvider = { childSources, personSourceFor: ensurePersonSource };

/** One source chain an account arrived through, named the way the queue shows it: "{name}" and "via {via}". */
export type AccountSource = {
  /** The closest sender: the agent, else the person, else the vendor. */
  sourceId: string;
  name: string;
  kind: string;
  /** The rest of the chain, person then vendor, joined with " · "; null when there is none. */
  via: string | null;
  /** Who answers for the source: a person source's user, or an agent's person (Decision 11, until sources get an owner of their own). */
  ownerUserId: string | null;
  arrivalId: string;
  batchId: string | null;
  receivedAt: Date;
};

type ChainRow = { accountId: string | null; arrivalId: string; batchId: string | null; receivedAt: Date; person: string | null; agent: string | null; vendor: string | null };

async function namedChains(ctx: ModuleContext, rows: ChainRow[]): Promise<{ accountId: string; source: AccountSource }[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.person, r.agent, r.vendor]).filter((id): id is string => !!id))];
  const sources = ids.length
    ? await ctx.tx
        .select({ id: source.id, name: source.name, kind: source.kind, parentId: source.parentId, userId: source.userId })
        .from(source)
        .where(and(eq(source.tenantId, ctx.tenantId), inArray(source.id, ids)))
    : [];
  const parents = [...new Set(sources.map((s) => s.parentId).filter((id): id is string => !!id && !ids.includes(id)))];
  const all = parents.length
    ? [...sources, ...(await ctx.tx.select({ id: source.id, name: source.name, kind: source.kind, parentId: source.parentId, userId: source.userId }).from(source).where(and(eq(source.tenantId, ctx.tenantId), inArray(source.id, parents))))]
    : sources;
  const byId = new Map(all.map((s) => [s.id, s]));
  const ownerOf = (id: string): string | null => {
    const s = byId.get(id);
    if (!s) return null;
    if (s.kind === 'person') return s.userId;
    const parent = s.parentId ? byId.get(s.parentId) : undefined;
    return parent?.kind === 'person' ? parent.userId : null;
  };
  return rows.flatMap((r) => {
    const closest = r.agent ?? r.person ?? r.vendor;
    const s = closest ? byId.get(closest) : undefined;
    if (!r.accountId || !closest || !s) return [];
    const via = [r.person, r.vendor].filter((id): id is string => !!id && id !== closest).map((id) => byId.get(id)?.name).filter(Boolean);
    return [
      {
        accountId: r.accountId,
        source: { sourceId: closest, name: s.name, kind: s.kind, via: via.length ? via.join(' · ') : null, ownerUserId: ownerOf(closest), arrivalId: r.arrivalId, batchId: r.batchId, receivedAt: r.receivedAt },
      },
    ];
  });
}

const chainColumns = {
  accountId: arrival.accountId,
  arrivalId: arrival.id,
  batchId: arrival.batchId,
  receivedAt: arrival.receivedAt,
  person: arrival.personSourceId,
  agent: arrival.agentSourceId,
  vendor: arrival.vendorSourceId,
};

/** The chain each account first arrived through (its earliest resolved arrival). The caller has checked the accounts are visible. */
export async function firstSources(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, AccountSource>> {
  if (accountIds.length === 0) return new Map();
  const rows = await ctx.tx
    .selectDistinctOn([arrival.accountId], chainColumns)
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), inArray(arrival.accountId, accountIds), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.accountId), asc(arrival.receivedAt), asc(arrival.id));
  return new Map((await namedChains(ctx, rows)).map((c) => [c.accountId, c.source]));
}

/** Every distinct chain an account arrived through, first arrival first. The caller has checked the account is visible. */
export async function sourcesOfAccount(ctx: ModuleContext, accountId: string): Promise<AccountSource[]> {
  const rows = await ctx.tx
    .select(chainColumns)
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, accountId), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.receivedAt), asc(arrival.id));
  const seen = new Set<string>();
  return (await namedChains(ctx, rows))
    .map((c) => c.source)
    .filter((s) => {
      const key = `${s.sourceId}|${s.via}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
