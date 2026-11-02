import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { accountUpdated, conflictDetected, conflictResolved } from '../contracts/events';
import { sourceInfoProvider } from '../contracts/ports';
import type { FactView, SourceChain } from '../contracts/types';
import { accountSummary, conflict, fact } from '../db/schema';
import { differs, toleranceFor } from '../domain/conflicts';
import type { PickFact } from '../domain/current-value';
import { reproject } from './facts';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { filterVisibleAccountIds } from './visibility';

/** One picked key of the account or a person: its current fact and its live (not superseded) facts. */
export type ConflictGroup = { personId: string | null; key: string; currentId: string; live: PickFact[] };

const chainKey = (c: SourceChain) => `${c.personSourceId ?? ''}|${c.agentSourceId ?? ''}|${c.vendorSourceId ?? ''}`;
const chainOf = (r: { personSourceId: string | null; agentSourceId: string | null; vendorSourceId: string | null }): SourceChain => ({
  ...(r.personSourceId ? { personSourceId: r.personSourceId } : {}),
  ...(r.agentSourceId ? { agentSourceId: r.agentSourceId } : {}),
  ...(r.vendorSourceId ? { vendorSourceId: r.vendorSourceId } : {}),
});
/** The distinct source ids in the facts' chains, sorted. */
const sourceIdsOf = (rows: { personSourceId: string | null; agentSourceId: string | null; vendorSourceId: string | null }[]) =>
  [...new Set(rows.flatMap((r) => [r.personSourceId, r.agentSourceId, r.vendorSourceId]).filter((s): s is string => !!s))].sort();
const textArray = (ids: string[]) => sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;

/** The live facts from other source chains that differ from the current value beyond the key's tolerance (Ruling 4). */
export function disagreeingIds(g: ConflictGroup): string[] {
  if (!toleranceFor(g.key)) return [];
  const current = g.live.find((f) => f.id === g.currentId);
  if (!current) return [];
  return g.live
    .filter((f) => f.id !== current.id && chainKey(f.sourceChain) !== chainKey(current.sourceChain) && differs(g.key, current.value, f.value))
    .map((f) => f.id);
}

/**
 * Opens the key's conflict, or adds the disagreeing facts to its open one (one open conflict per account, person
 * and key; the partial unique index enforces it). The caller holds the account lock. Returns the ids of the
 * conflicts opened or extended, and recounts the summary when there are any.
 */
export async function detectConflicts(ctx: ModuleContext, accountId: string, groups: ConflictGroup[]): Promise<string[]> {
  const changed: string[] = [];
  for (const g of groups) {
    const others = disagreeingIds(g);
    if (others.length === 0) continue;
    const factIds = [g.currentId, ...others];
    // Returns a row only when the conflict is new or gained a fact.
    const [row] = (await ctx.tx.execute(sql`
      insert into accounts.conflict (id, tenant_id, account_id, person_id, key, fact_ids)
      values (${newId('cfl')}, ${ctx.tenantId}, ${accountId}, ${g.personId}, ${g.key}, ${textArray(factIds)})
      on conflict (tenant_id, account_id, coalesce(person_id, ''), key) where status = 'open'
      do update set fact_ids = conflict.fact_ids || array(select f from unnest(excluded.fact_ids) as f where f <> all(conflict.fact_ids))
      where not (excluded.fact_ids <@ conflict.fact_ids)
      returning id, fact_ids
    `)) as unknown as { id: string; fact_ids: string[] }[];
    if (!row) continue;
    await conflictChanged(ctx, { id: row.id, accountId, personId: g.personId, key: g.key, factIds: row.fact_ids });
    changed.push(row.id);
  }
  if (changed.length) await recountOpenConflicts(ctx, accountId);
  return changed;
}

/** The one place a conflict has just opened or gained a fact. */
async function conflictChanged(
  ctx: ModuleContext,
  c: { id: string; accountId: string; personId: string | null; key: string; factIds: string[] },
): Promise<void> {
  const chains = await ctx.tx
    .select({ personSourceId: fact.personSourceId, agentSourceId: fact.agentSourceId, vendorSourceId: fact.vendorSourceId })
    .from(fact)
    .where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, c.factIds)));
  const sourceIds = sourceIdsOf(chains);
  await publish(
    ctx,
    conflictDetected,
    { conflictId: c.id, accountId: c.accountId, ...(c.personId ? { personId: c.personId } : {}), key: c.key, factIds: c.factIds, sourceIds },
    { type: 'account', id: c.accountId },
  );
}

/** Writes `account_summary.open_conflict_count` from the conflict table. */
export async function recountOpenConflicts(ctx: ModuleContext, accountId: string): Promise<void> {
  await ctx.tx
    .update(accountSummary)
    .set({
      openConflictCount: sql`(select count(*)::int from ${conflict} where ${conflict.tenantId} = ${ctx.tenantId}
        and ${conflict.accountId} = ${accountId} and ${conflict.status} = 'open')`,
      updatedAt: new Date(),
    })
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, accountId)));
}

/**
 * A merge moves the merged account's conflicts to the survivor (a collapsed person's to the person they became).
 * An open conflict on a key the survivor already has open joins it. Recounts both summaries. The caller holds
 * both account locks.
 */
export async function moveConflicts(
  ctx: ModuleContext,
  survivorId: string,
  mergedId: string,
  collapsed: { id: string; into: string }[],
): Promise<void> {
  const into = new Map(collapsed.map((c) => [c.id, c.into]));
  const theirs = await ctx.tx.select().from(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.accountId, mergedId)));
  for (const c of theirs) {
    const personId = c.personId ? (into.get(c.personId) ?? c.personId) : null;
    const [mine] =
      c.status === 'open'
        ? await ctx.tx
            .select()
            .from(conflict)
            .where(
              and(
                eq(conflict.tenantId, ctx.tenantId),
                eq(conflict.accountId, survivorId),
                sql`coalesce(${conflict.personId}, '') = ${personId ?? ''}`,
                eq(conflict.key, c.key),
                eq(conflict.status, 'open'),
              ),
            )
        : [];
    if (mine) {
      const factIds = [...mine.factIds, ...c.factIds.filter((id) => !mine.factIds.includes(id))];
      await ctx.tx.update(conflict).set({ factIds }).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, mine.id)));
      await ctx.tx.delete(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id)));
    } else {
      await ctx.tx.update(conflict).set({ accountId: survivorId, personId }).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id)));
    }
  }
  await recountOpenConflicts(ctx, survivorId);
  await recountOpenConflicts(ctx, mergedId);
}

type ConflictRow = typeof conflict.$inferSelect;
type FactRow = typeof fact.$inferSelect;

export type ConflictFactView = {
  id: string;
  value: unknown;
  observedAt: Date;
  sourceChain: SourceChain;
  arrivalId: string | null;
  /** Effective trust of the fact's source chain. */
  trust: number;
  status: FactView['status'];
};

export type ConflictView = {
  id: string;
  accountId: string;
  personId: string | null;
  key: string;
  status: 'open' | 'resolved';
  resolution: 'kept' | 'edited' | null;
  keptFactId: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  note: string | null;
  explanation: string | null;
  createdAt: Date;
  facts: ConflictFactView[];
};

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const isLive = (status: string) => status === 'current' || status === 'candidate';
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That conflict was not found.' });

async function factsOf(ctx: ModuleContext, ids: string[]): Promise<FactRow[]> {
  if (ids.length === 0) return [];
  return ctx.tx.select().from(fact).where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, ids)));
}

async function views(ctx: ModuleContext, rows: ConflictRow[]): Promise<ConflictView[]> {
  const byId = new Map((await factsOf(ctx, [...new Set(rows.flatMap((r) => r.factIds))])).map((f) => [f.id, f]));
  const trust = new Map<string, number>();
  for (const f of byId.values()) {
    const k = chainKey(chainOf(f));
    if (!trust.has(k)) trust.set(k, await sourceInfoProvider().getTrust(ctx, chainOf(f)));
  }
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    personId: r.personId,
    key: r.key,
    status: r.status as ConflictView['status'],
    resolution: r.resolution as ConflictView['resolution'],
    keptFactId: r.keptFactId,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
    note: r.note,
    explanation: r.explanation,
    createdAt: r.createdAt,
    facts: r.factIds
      .map((id) => byId.get(id))
      .filter((f): f is FactRow => !!f)
      .map((f) => ({
        id: f.id,
        value: f.value,
        observedAt: f.observedAt,
        sourceChain: chainOf(f),
        arrivalId: f.arrivalId,
        trust: trust.get(chainKey(chainOf(f)))!,
        status: f.status as FactView['status'],
      })),
  }));
}

/** The account's open conflicts, then those resolved in the last 30 days. Empty when the account is hidden or missing. */
export async function listConflicts(ctx: ModuleContext, accountId: string): Promise<ConflictView[]> {
  const found = await resolveAccountId(ctx, accountId);
  if (!found || (await filterVisibleAccountIds(ctx, [found.id])).length === 0) return [];
  const rows = await ctx.tx
    .select()
    .from(conflict)
    .where(
      and(
        eq(conflict.tenantId, ctx.tenantId),
        eq(conflict.accountId, found.id),
        or(eq(conflict.status, 'open'), gte(conflict.resolvedAt, new Date(Date.now() - RECENT_MS))),
      ),
    )
    // 'open' sorts before 'resolved'.
    .orderBy(asc(conflict.status), desc(conflict.resolvedAt), desc(conflict.createdAt), asc(conflict.id));
  return views(ctx, rows);
}

async function visibleRow(ctx: ModuleContext, id: string): Promise<ConflictRow | null> {
  const [row] = await ctx.tx.select().from(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, id)));
  return row && (await filterVisibleAccountIds(ctx, [row.accountId])).length === 1 ? row : null;
}

/** One conflict, when the principal can see its account. */
export async function getConflict(ctx: ModuleContext, id: string): Promise<ConflictView | null> {
  const row = await visibleRow(ctx, id);
  return row ? (await views(ctx, [row]))[0]! : null;
}

/**
 * The conflict is settled: `conflictResolved` with the kept fact's sources winning and the archived facts' other
 * sources losing (none for an edit, Ruling 7), and the summary recounted.
 */
async function settled(
  ctx: ModuleContext,
  c: ConflictRow,
  s: { kept: FactRow; archived: FactRow[]; resolution: 'kept' | 'edited'; by: string; note?: string },
): Promise<void> {
  const winningSourceIds = sourceIdsOf([s.kept]);
  const losingSourceIds = s.resolution === 'edited' ? [] : sourceIdsOf(s.archived).filter((id) => !winningSourceIds.includes(id));
  await publish(
    ctx,
    conflictResolved,
    {
      conflictId: c.id,
      accountId: c.accountId,
      key: c.key,
      keptFactId: s.kept.id,
      archivedFactIds: s.archived.map((f) => f.id),
      winningSourceIds,
      losingSourceIds,
      resolvedBy: s.by,
      resolution: s.resolution,
      ...(s.note ? { note: s.note } : {}),
    },
    { type: 'account', id: c.accountId },
  );
  await recountOpenConflicts(ctx, c.accountId);
}

async function archive(ctx: ModuleContext, facts: FactRow[]): Promise<void> {
  if (facts.length === 0) return;
  await ctx.tx.update(fact).set({ status: 'archived' }).where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, facts.map((f) => f.id))));
}

/**
 * A person keeps one value of the conflict (Ruling 6): the kept fact is pinned, the conflict's other live facts are
 * archived and the key is re-picked. On a resolved conflict this switches the kept value: the chosen archived fact
 * is pinned and the previous one archived. A missing or hidden conflict is a 404, a fact outside it a 400, and a
 * fact its source has since replaced a 409.
 */
export async function resolveConflict(ctx: ModuleContext, id: string, keptFactId: string, note?: string): Promise<ConflictView> {
  const userId = ctx.access?.userId;
  if (!userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can settle a disagreement between sources.' });
  const seen = await visibleRow(ctx, id);
  if (!seen) throw notFound();
  await lockAccount(ctx, seen.accountId);
  const [c] = await ctx.tx.select().from(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, id)));
  if (!c) throw notFound();
  if (!c.factIds.includes(keptFactId)) {
    const message = 'That value is not part of this conflict.';
    throw new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path: 'kept_fact_id', message }] });
  }
  if (c.status === 'resolved' && c.keptFactId === keptFactId) return (await views(ctx, [c]))[0]!;

  const facts = await factsOf(ctx, c.factIds);
  const kept = facts.find((f) => f.id === keptFactId);
  if (!kept || !(isLive(kept.status) || (kept.status === 'archived' && c.status === 'resolved'))) {
    throw new ScoutError({ slug: 'conflict', status: 409, title: 'That value has been replaced by a newer one from the same source.' });
  }
  const archived = facts.filter((f) => f.id !== keptFactId && isLive(f.status));
  const now = new Date();
  await archive(ctx, archived);
  await ctx.tx
    .update(fact)
    .set({ status: 'candidate', pinnedBy: userId, pinnedAt: now })
    .where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.id, keptFactId)));
  const [row] = await ctx.tx
    .update(conflict)
    .set({ status: 'resolved', resolution: 'kept', keptFactId, resolvedBy: userId, resolvedAt: now, note: note ?? null })
    .where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, id)))
    .returning();
  await reproject(ctx, c.accountId, [c.key]);

  const archivedFactIds = archived.map((f) => f.id);
  await audit(ctx, { action: 'accounts.conflict.resolve', subject: { type: 'conflict', id }, after: { keptFactId, archivedFactIds, note } });
  await publish(ctx, accountUpdated, { accountId: c.accountId, changedKeys: [c.key] }, { type: 'account', id: c.accountId });
  await settled(ctx, c, { kept, archived, resolution: 'kept', by: userId, note });
  return (await views(ctx, [row!]))[0]!;
}

/**
 * A person edited `keys` of the account (`personId` null) or of one of its people: each key's open conflict closes
 * with the edit's fact kept and the conflict's live facts archived, and no source loses (Ruling 7). Runs after the
 * edit's re-pick, under the caller's account lock.
 */
export async function closeByEdit(ctx: ModuleContext, accountId: string, personId: string | null, keys: string[]): Promise<void> {
  const userId = ctx.access?.userId;
  if (!userId || keys.length === 0) return;
  const samePerson = (column: typeof conflict.personId | typeof fact.personId) => sql`coalesce(${column}, '') = ${personId ?? ''}`;
  const open = await ctx.tx
    .select()
    .from(conflict)
    .where(
      and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.accountId, accountId), samePerson(conflict.personId), inArray(conflict.key, keys), eq(conflict.status, 'open')),
    );
  for (const c of open) {
    const [kept] = await ctx.tx
      .select()
      .from(fact)
      .where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.accountId, accountId), samePerson(fact.personId), eq(fact.key, c.key), eq(fact.status, 'current')));
    // The edit's pinned fact is current after the re-pick; anything else (a domain another account holds) leaves it open.
    if (!kept?.pinnedAt) continue;
    const archived = (await factsOf(ctx, c.factIds)).filter((f) => f.id !== kept.id && isLive(f.status));
    await archive(ctx, archived);
    await ctx.tx
      .update(conflict)
      .set({
        status: 'resolved',
        resolution: 'edited',
        keptFactId: kept.id,
        factIds: c.factIds.includes(kept.id) ? c.factIds : [...c.factIds, kept.id],
        resolvedBy: userId,
        resolvedAt: new Date(),
      })
      .where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id)));
    await settled(ctx, c, { kept, archived, resolution: 'edited', by: userId });
  }
}
