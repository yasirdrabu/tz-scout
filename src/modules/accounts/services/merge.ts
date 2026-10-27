import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { accountArchived, accountMerged } from '../contracts/events';
import { mergeGuard } from '../contracts/ports';
import type { SignalKind } from '../contracts/types';
import { account, accountAlias, accountSummary, fact, person, personAlias, personRole, signal } from '../db/schema';
import { signalDedupKeys } from '../domain/signals';
import { applyExclusion } from './exclusion';
import { reproject } from './facts';
import { lockAccounts } from './lock';
import { findMatch } from './people';
import { repickPrimary } from './primary';
import { setPractices } from './practices';
import { writeSummary } from './summary';

const subjectOf = (id: string) => ({ type: 'account', id });
const closestSource = (c: { personSourceId: string | null; agentSourceId: string | null; vendorSourceId: string | null }) =>
  c.agentSourceId ?? c.vendorSourceId ?? c.personSourceId ?? '';

const signalKeys = (s: typeof signal.$inferSelect) =>
  signalDedupKeys({
    source: closestSource(s),
    externalId: s.externalId,
    url: s.url,
    kind: s.kind as SignalKind,
    title: s.title,
    occurredAt: s.occurredAt ?? s.recordedAt,
  });

/** Loads an account that can be merged: it must exist and be active. */
async function loadActive(ctx: ModuleContext, id: string) {
  const [row] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  if (row.archivedAt) throw new ScoutError({ slug: 'conflict', status: 409, title: 'An archived account cannot be merged.' });
  return row;
}

/**
 * Moves the merged account's people to the survivor. A person the survivor already has (email, then LinkedIn,
 * then name) is archived and becomes a `merged_id` alias of the survivor's person; their facts, roles and
 * aliases follow. Returns the ids moved as new people and the ids collapsed into existing ones.
 */
async function movePeople(ctx: ModuleContext, survivorId: string, mergedId: string) {
  const where = (accountId: string) => and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, accountId));
  const survivors = await ctx.tx.select().from(person).where(and(where(survivorId), isNull(person.archivedAt)));
  const incoming = await ctx.tx.select().from(person).where(where(mergedId));
  const hasPin = survivors.some((p) => p.primaryPinnedAt);
  const moved: string[] = [];
  const collapsed: { id: string; into: string }[] = [];
  for (const p of incoming) {
    const match = p.archivedAt ? undefined : findMatch(survivors, p);
    if (!match) {
      moved.push(p.id);
      continue;
    }
    collapsed.push({ id: p.id, into: match.id });
    await ctx.tx.update(fact).set({ personId: match.id }).where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.personId, p.id)));
    for (const table of [personRole, personAlias] as const) {
      const rows = await ctx.tx.select().from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.personId, p.id)));
      if (rows.length) await ctx.tx.insert(table).values(rows.map((r) => ({ ...r, personId: match.id }))).onConflictDoNothing();
      await ctx.tx.delete(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.personId, p.id)));
    }
    await ctx.tx.insert(personAlias).values({ tenantId: ctx.tenantId, personId: match.id, kind: 'merged_id', value: p.id }).onConflictDoNothing();
  }
  const archivedIds = collapsed.map((c) => c.id);
  if (archivedIds.length) {
    await ctx.tx
      .update(person)
      .set({ accountId: survivorId, archivedAt: new Date(), isPrimary: false, primaryPinnedAt: null, primaryPinnedBy: null, updatedAt: new Date() })
      .where(and(eq(person.tenantId, ctx.tenantId), inArray(person.id, archivedIds)));
  }
  if (moved.length) {
    // One pinned primary per account: the survivor's pin wins.
    await ctx.tx
      .update(person)
      .set({ accountId: survivorId, updatedAt: new Date(), ...(hasPin ? { primaryPinnedAt: null, primaryPinnedBy: null } : {}) })
      .where(and(eq(person.tenantId, ctx.tenantId), inArray(person.id, moved)));
  }
  return { moved, collapsed };
}

/** Moves signals; one the survivor already has (any dedup key in common) is archived rather than shown twice. */
async function moveSignals(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<string[]> {
  const mine = await ctx.tx.select().from(signal).where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.accountId, survivorId)));
  const seen = new Set(mine.flatMap(signalKeys));
  const theirs = await ctx.tx.select().from(signal).where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.accountId, mergedId)));
  const duplicates: string[] = [];
  for (const s of theirs) {
    const keys = signalKeys(s);
    if (keys.some((k) => seen.has(k))) {
      if (!s.archivedAt) duplicates.push(s.id);
    } else keys.forEach((k) => seen.add(k));
  }
  if (duplicates.length) {
    await ctx.tx.update(signal).set({ archivedAt: new Date() }).where(and(eq(signal.tenantId, ctx.tenantId), inArray(signal.id, duplicates)));
  }
  await ctx.tx.update(signal).set({ accountId: survivorId }).where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.accountId, mergedId)));
  return duplicates;
}

/**
 * The survivor keeps its own name and domain: when it has a current value, every other live name or domain fact
 * of either account (the merged account's, and the survivor's own candidates) stops competing. The merged values
 * stay as aliases.
 */
async function moveFacts(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  const held = await ctx.tx
    .select({ key: fact.key })
    .from(fact)
    .where(
      and(eq(fact.tenantId, ctx.tenantId), eq(fact.accountId, survivorId), isNull(fact.personId), inArray(fact.key, ['name', 'domain']), eq(fact.status, 'current')),
    );
  const heldKeys = [...new Set(held.map((h) => h.key))];
  if (heldKeys.length) {
    await ctx.tx
      .update(fact)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(fact.tenantId, ctx.tenantId),
          inArray(fact.accountId, [survivorId, mergedId]),
          isNull(fact.personId),
          inArray(fact.key, heldKeys),
          inArray(fact.status, ['current', 'candidate']),
          sql`not (${fact.accountId} = ${survivorId} and ${fact.status} = 'current')`,
        ),
      );
  }
  await ctx.tx.update(fact).set({ accountId: survivorId }).where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.accountId, mergedId)));
}

/** An email fact that another person at the survivor already holds would break the one-email-per-person index; it stops competing. */
async function dropClashingEmails(ctx: ModuleContext, survivorId: string): Promise<void> {
  const people = await ctx.tx
    .select({ id: person.id, email: person.email })
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, survivorId), isNull(person.archivedAt)));
  const owner = new Map(people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p.id]));
  const facts = await ctx.tx
    .select({ id: fact.id, personId: fact.personId, value: fact.value })
    .from(fact)
    .where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.accountId, survivorId), eq(fact.key, 'email'), inArray(fact.status, ['current', 'candidate'])));
  const clashing = facts
    .filter((f) => typeof f.value === 'string' && owner.has(f.value.toLowerCase()) && owner.get(f.value.toLowerCase()) !== f.personId)
    .map((f) => f.id);
  if (clashing.length) await ctx.tx.update(fact).set({ status: 'superseded' }).where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, clashing)));
}

/** Moves the merged account's aliases (earlier merged ids and external ids included), skipping ones the survivor has. */
async function moveAliases(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  const rows = await ctx.tx.select().from(accountAlias).where(and(eq(accountAlias.tenantId, ctx.tenantId), eq(accountAlias.accountId, mergedId)));
  if (rows.length) await ctx.tx.insert(accountAlias).values(rows.map((r) => ({ ...r, accountId: survivorId }))).onConflictDoNothing();
  await ctx.tx.delete(accountAlias).where(and(eq(accountAlias.tenantId, ctx.tenantId), eq(accountAlias.accountId, mergedId)));
}

/**
 * Merges `mergedId` into `survivorId` (ACC-E5). People only; no unmerge. Runs in the caller's transaction
 * under both account locks, lower id first.
 */
export async function mergeAccounts(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  const userId = ctx.access?.userId;
  if (!userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can merge accounts.' });
  if (survivorId === mergedId) throw new ScoutError({ slug: 'conflict', status: 409, title: 'Choose two different accounts.' });

  await lockAccounts(ctx, [survivorId, mergedId]);
  const survivor = await loadActive(ctx, survivorId);
  const merged = await loadActive(ctx, mergedId);
  const verdict = await mergeGuard().check(ctx, survivorId, mergedId);
  if (!verdict.allowed) throw new ScoutError({ slug: 'conflict', status: 409, title: verdict.reason });

  const [mergedSummary] = await ctx.tx.select({ sourceIds: accountSummary.sourceIds }).from(accountSummary).where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, mergedId)));
  const peopleBefore = await ctx.tx
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), inArray(person.accountId, [survivorId, mergedId]), isNull(person.archivedAt)));

  // Archive first: the merged domain leaves the active-domain unique index before the survivor can project it.
  const now = new Date();
  await ctx.tx.update(account).set({ archivedAt: now, updatedAt: now }).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, mergedId)));

  const { moved, collapsed } = await movePeople(ctx, survivorId, mergedId);
  const duplicateSignalIds = await moveSignals(ctx, survivorId, mergedId);
  await moveFacts(ctx, survivorId, mergedId);
  await dropClashingEmails(ctx, survivorId);
  await moveAliases(ctx, survivorId, mergedId);
  await setPractices(ctx, survivorId, merged.practiceIds, 'hint', { publish: false });

  await reproject(ctx, survivorId);
  const [after] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, survivorId)));
  const aliases: (typeof accountAlias.$inferInsert)[] = [{ tenantId: ctx.tenantId, accountId: survivorId, kind: 'merged_id', value: mergedId }];
  if (merged.domain && merged.domain !== after!.domain) aliases.push({ tenantId: ctx.tenantId, accountId: survivorId, kind: 'domain', value: merged.domain });
  if (merged.matchName !== after!.matchName) aliases.push({ tenantId: ctx.tenantId, accountId: survivorId, kind: 'name', value: merged.matchName });
  await ctx.tx.insert(accountAlias).values(aliases).onConflictDoNothing();

  await repickPrimary(ctx, survivorId);
  await applyExclusion(ctx, survivorId);
  await writeSummary(ctx, survivorId, { addSourceIds: mergedSummary?.sourceIds ?? [] });

  await audit(ctx, {
    action: 'accounts.account.merge',
    subject: subjectOf(survivorId),
    before: { survivorId, mergedId, personIds: peopleBefore.map((p) => p.id), survivorDomain: survivor.domain, mergedDomain: merged.domain },
    after: {
      survivorId,
      mergedId,
      movedPersonIds: moved,
      collapsedPersonIds: collapsed,
      archivedDuplicateSignalIds: duplicateSignalIds,
    },
  });
  await publish(ctx, accountMerged, { survivorId, mergedId, mergedBy: userId }, subjectOf(survivorId));
  await publish(ctx, accountArchived, { accountId: mergedId, reason: 'merged' }, subjectOf(mergedId));
}
