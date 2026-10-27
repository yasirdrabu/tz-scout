import { and, asc, eq, gt, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { SourceAccessProvider, SourceChain, SourceInfoProvider } from '@/modules/accounts';
import { members, revokeKeysForSource, type SourceValidator } from '@/modules/tenancy';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { arrival, source } from '../db/schema';

export const SOURCE_KINDS = ['person', 'agent', 'vendor', 'partner', 'crm', 'web_form', 'scheduled_pull'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus = 'active' | 'paused' | 'archived';

/** SRC-E1: sources a person stands behind start as `needs_review`, the rest as `unvetted`. */
export const DEFAULT_REVIEW_STATUS: Record<SourceKind, string> = {
  person: 'needs_review',
  crm: 'needs_review',
  web_form: 'needs_review',
  agent: 'unvetted',
  vendor: 'unvetted',
  partner: 'unvetted',
  scheduled_pull: 'unvetted',
};

/** The kind a parent must have, for the kinds that need one. */
const PARENT_KIND: Partial<Record<SourceKind, { kind: SourceKind; copy: string }>> = {
  agent: { kind: 'person', copy: 'An agent needs an owner. Pick the person who runs it.' },
  scheduled_pull: { kind: 'vendor', copy: 'A scheduled pull needs a vendor.' },
};

export const MAX_DAILY_CAP = 10_000;

export type SourceView = {
  id: string;
  kind: SourceKind;
  name: string;
  parentId: string | null;
  userId: string | null;
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
  dailyArrivalCap?: number;
  initialReviewStatusKey?: string;
  settings?: Record<string, unknown>;
};

export type SourcePatch = {
  name?: string;
  status?: SourceStatus;
  dailyArrivalCap?: number;
  initialReviewStatusKey?: string;
};

const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That source was not found.' });

type Row = typeof source.$inferSelect;

function view(r: Row): SourceView {
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    name: r.name,
    parentId: r.parentId,
    userId: r.userId,
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
  if (!trimmed) throw invalid('Give the source a name.');
  return trimmed;
}

/** One source in the context's tenant, or undefined. */
export async function loadSource(ctx: ModuleContext, id: string): Promise<Row | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, id)));
  return row;
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return err.code === '23505' || err.cause?.code === '23505';
};

/** Registers a source. Agents need a person parent and scheduled pulls a vendor parent; one person source per user. */
export async function registerSource(ctx: ModuleContext, input: RegisterSourceInput): Promise<SourceView> {
  if (!SOURCE_KINDS.includes(input.kind)) throw invalid('Pick a kind of source.');
  const name = checkName(input.name)!;
  checkCap(input.dailyArrivalCap);

  const needs = PARENT_KIND[input.kind];
  if (needs) {
    const parent = input.parentId ? await loadSource(ctx, input.parentId) : undefined;
    if (!parent || parent.kind !== needs.kind || parent.status === 'archived') throw invalid(needs.copy);
  } else if (input.parentId) {
    throw invalid('Only agents and scheduled pulls have a parent source.');
  }
  if (input.userId && input.kind !== 'person') throw invalid('Only a person source can be linked to a user.');
  const taken = () => invalid('This person already has a source.');
  if (input.userId && (await personSourceFor(ctx, input.userId))) throw taken();

  const values = {
    id: newId('src'),
    tenantId: ctx.tenantId,
    kind: input.kind,
    name,
    parentId: input.parentId ?? null,
    userId: input.userId ?? null,
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

  const [row] = await ctx.tx
    .update(source)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.dailyArrivalCap !== undefined ? { dailyArrivalCap: patch.dailyArrivalCap } : {}),
      ...(initialReviewStatusKey ? { initialReviewStatusKey } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.id, id)))
    .returning();
  if (patch.status === 'archived' && current.status !== 'archived') await revokeKeysForSource(ctx, id);
  return view(row!);
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
    return (await registerSource(ctx, { kind: 'person', name: member.name.trim() || member.email.split('@')[0]!, userId })).id;
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

export type SourceListRow = SourceView & { arrivalsLast30Days: number };

/** The registry as a tree (each parent followed by its children, by name), limited to what the principal sees. */
export async function listSources(ctx: ModuleContext): Promise<SourceListRow[]> {
  const visible = await visibleSourceIds(ctx);
  if (visible && visible.length === 0) return [];
  const rows = await ctx.tx
    .select()
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), visible ? inArray(source.id, visible) : undefined))
    .orderBy(asc(source.name), asc(source.id));
  const ids = rows.map((r) => r.id);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const recent = await ctx.tx
      .select({ person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
      .from(arrival)
      .where(
        and(
          eq(arrival.tenantId, ctx.tenantId),
          gte(arrival.receivedAt, since),
          or(inArray(arrival.personSourceId, ids), inArray(arrival.agentSourceId, ids), inArray(arrival.vendorSourceId, ids)),
        ),
      );
    for (const a of recent) {
      for (const id of new Set([a.person, a.agent, a.vendor])) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const shown = new Set(ids);
  const children = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.parentId && shown.has(r.parentId)) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  }
  const out: SourceListRow[] = [];
  const walk = (r: Row) => {
    out.push({ ...view(r), arrivalsLast30Days: counts.get(r.id) ?? 0 });
    for (const c of children.get(r.id) ?? []) walk(c);
  };
  for (const r of rows) if (!r.parentId || !shown.has(r.parentId)) walk(r);
  return out;
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
  let best: { trust: number; chain: SourceChain } | null = null;
  for (const chain of await chainsForAccount(ctx, accountIds)) {
    const trust = await intakeSourceInfo.getTrust(ctx, chain);
    if (!best || trust > best.trust) best = { trust, chain };
  }
  const sourceId = best && (best.chain.agentSourceId ?? best.chain.personSourceId ?? best.chain.vendorSourceId);
  if (!best || !sourceId) return null;
  const row = await loadSource(ctx, sourceId);
  return { trust: best.trust, sourceId, sourceName: row?.name ?? sourceId };
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
  const rows = await ctx.tx
    .selectDistinct({ id: arrival.accountId })
    .from(arrival)
    .where(
      and(
        eq(arrival.tenantId, ctx.tenantId),
        eq(arrival.status, 'resolved'),
        isNotNull(arrival.accountId),
        opts.afterId ? gt(arrival.accountId, opts.afterId) : undefined,
        or(inArray(arrival.personSourceId, sources), inArray(arrival.agentSourceId, sources), inArray(arrival.vendorSourceId, sources)),
      ),
    )
    .orderBy(asc(arrival.accountId))
    .limit(limit + 1);
  const ids = rows.slice(0, limit).map((r) => r.id!);
  return { ids, nextAfterId: rows.length > limit ? ids[ids.length - 1]! : null };
}

/** Accounts' `SourceAccessProvider`. */
export const intakeSourceAccess: SourceAccessProvider = { childSources, personSourceFor: ensurePersonSource };
