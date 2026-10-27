import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { resolvePractice } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { accountCreated, accountUpdated, factRecorded, personAdded, personUpdated, signalRecorded } from '../contracts/events';
import type { ArrivalAccountFields, ArrivalForAccounts, FactKind } from '../contracts/types';
import { account, accountAlias, fact } from '../db/schema';
import { matchName } from '../domain/names';
import { applyExclusion, type Exclusion } from './exclusion';
import { ACCOUNT_COLUMNS, recordFacts, reproject, type FactInput } from './facts';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { matchOrAddPerson, type PersonResult } from './people';
import { repickPrimary } from './primary';
import { setPractices } from './practices';
import { storeSignal, type StoredSignal } from './signals';
import { writeSummary } from './summary';

export type UpsertResult = {
  accountId: string;
  created: boolean;
  /** Every person in the arrival, in order, new or matched. */
  personIds: string[];
  existingPersonIds: string[];
  /** Every signal in the arrival, in order, new or already stored. */
  signalIds: string[];
  existingSignalIds: string[];
  factIds: string[];
  excluded: Exclusion | null;
};

const SHELL_ROLES = ['business_owner', 'commercial_buyer'];
const TIERS = ['A', 'B', 'C'];
const subjectOf = (id: string) => ({ type: 'account', id });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });

const shellName = (a: ArrivalForAccounts) =>
  [a.people[0]?.firstName, a.people[0]?.lastName].filter(Boolean).join(' ').trim() || undefined;

/**
 * Loads the target account, or creates one. A create with a domain is an insert that does nothing on
 * the active-domain unique index, so two concurrent creates for one domain give one account: the
 * second insert waits for the first transaction, then finds its row.
 */
async function createOrLoad(ctx: ModuleContext, a: ArrivalForAccounts, accountId?: string) {
  if (accountId) {
    const [row] = await ctx.tx
      .select({ id: account.id, isShell: account.isShell })
      .from(account)
      .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
    if (!row) throw notFound();
    return { ...row, created: false };
  }
  const isShell = a.soleProprietor && !a.account.name;
  const domain = a.account.domain?.toLowerCase() ?? null;
  const name = a.account.name ?? (isShell ? shellName(a) : undefined) ?? domain;
  if (!name) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Add a company name or website.' });
  }
  const insert = ctx.tx.insert(account).values({ id: newId('acc'), tenantId: ctx.tenantId, name, matchName: matchName(name), domain, isShell });
  const [row] = await (domain
    ? insert.onConflictDoNothing({ target: [account.tenantId, account.domain], where: sql`archived_at is null and domain is not null` })
    : insert
  ).returning({ id: account.id });
  if (row) return { id: row.id, isShell, created: true };
  const [existing] = await ctx.tx
    .select({ id: account.id, isShell: account.isShell })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.domain, domain!), isNull(account.archivedAt)));
  return { ...existing!, created: false };
}

function accountFacts(a: ArrivalForAccounts, isShell: boolean): FactInput[] {
  const observedAt = a.receivedAt;
  const fields: ArrivalAccountFields = { ...a.account, ...(isShell && !a.account.name ? { name: shellName(a) } : {}) };
  const out: FactInput[] = [];
  for (const [key, column] of Object.entries(ACCOUNT_COLUMNS)) {
    const value = fields[column as keyof ArrivalAccountFields];
    if (value !== undefined) out.push({ key, value: key === 'domain' ? String(value).toLowerCase() : value, observedAt });
  }
  for (const [key, value] of Object.entries(a.research)) out.push({ key, value, observedAt });
  for (const f of a.facts) {
    if (f.personIndex === undefined) out.push({ key: f.key, value: f.value, url: f.url, note: f.note, observedAt: f.observedAt ?? observedAt });
  }
  return out;
}

/** `previousDomain`: the domain before this arrival's facts were projected. A replaced primary stays an alias. */
async function addAliases(ctx: ModuleContext, accountId: string, a: ArrivalForAccounts, previousDomain: string | null): Promise<void> {
  const [acc] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  const rows: (typeof accountAlias.$inferInsert)[] = [];
  if (previousDomain && previousDomain !== acc!.domain) rows.push({ tenantId: ctx.tenantId, accountId, kind: 'domain', value: previousDomain });
  const domain = a.account.domain?.toLowerCase();
  if (domain && domain !== acc!.domain) rows.push({ tenantId: ctx.tenantId, accountId, kind: 'domain', value: domain });
  const name = a.account.name ? matchName(a.account.name) : '';
  if (name && name !== acc!.matchName) rows.push({ tenantId: ctx.tenantId, accountId, kind: 'name', value: name });
  for (const x of a.externalIds) rows.push({ tenantId: ctx.tenantId, accountId, kind: 'external_id', system: x.system, value: x.id });
  if (rows.length) await ctx.tx.insert(accountAlias).values(rows).onConflictDoNothing();
}

/** Projects `researcher_tier` onto the account when this arrival's tier fact is current. */
async function projectResearchTier(ctx: ModuleContext, accountId: string, a: ArrivalForAccounts, factIds: string[]): Promise<void> {
  if (factIds.length === 0) return;
  const [tier] = await ctx.tx
    .select({ value: fact.value })
    .from(fact)
    .where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, factIds), eq(fact.key, 'researcher_tier'), eq(fact.status, 'current')));
  const value = typeof tier?.value === 'string' ? tier.value.toUpperCase() : null;
  if (!value || !TIERS.includes(value)) return;
  const dated = a.signals.map((s) => s.occurredAt?.getTime()).filter((t): t is number => t !== undefined);
  await ctx.tx
    .update(account)
    .set({ researchTier: value, researchTierSignalAt: dated.length ? new Date(Math.max(...dated)) : null, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
}

/** Published before the practice and exclusion events, so a new account is announced first. */
async function publishCreated(ctx: ModuleContext, accountId: string, a: ArrivalForAccounts): Promise<void> {
  const [acc] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  await publish(
    ctx,
    accountCreated,
    { accountId, name: acc!.name, domain: acc!.domain, isShell: acc!.isShell, arrivalId: a.arrivalId },
    subjectOf(accountId),
  );
}

async function publishEvents(
  ctx: ModuleContext,
  accountId: string,
  a: ArrivalForAccounts,
  created: boolean,
  people: PersonResult[],
  signals: StoredSignal[],
  factIds: string[],
): Promise<void> {
  const subject = subjectOf(accountId);
  const facts = factIds.length
    ? await ctx.tx
        .select({ id: fact.id, key: fact.key, kind: fact.kind, personId: fact.personId, status: fact.status })
        .from(fact)
        .where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, factIds)))
    : [];
  if (!created) {
    const changedKeys = [...new Set(facts.filter((f) => !f.personId && f.status === 'current').map((f) => f.key))];
    if (changedKeys.length) await publish(ctx, accountUpdated, { accountId, changedKeys }, subject);
  }
  for (const p of people) {
    if (!p.existing) await publish(ctx, personAdded, { accountId, personId: p.personId, roleKeys: p.roleKeys, arrivalId: a.arrivalId }, subject);
    else if (p.changedKeys.length) {
      await publish(ctx, personUpdated, { accountId, personId: p.personId, changedKeys: p.changedKeys, roleKeys: p.roleKeys }, subject);
    }
  }
  for (const f of facts) {
    await publish(
      ctx,
      factRecorded,
      {
        accountId,
        ...(f.personId ? { personId: f.personId } : {}),
        factId: f.id,
        key: f.key,
        kind: f.kind as FactKind,
        sourceChain: a.sourceChain,
        becameCurrent: f.status === 'current',
      },
      subject,
    );
  }
  for (const [i, s] of signals.entries()) {
    if (s.existing) continue;
    const input = a.signals[i]!;
    await publish(
      ctx,
      signalRecorded,
      {
        accountId,
        signalId: s.signalId,
        type: s.type,
        kind: s.kind,
        occurredAt: s.occurredAt.toISOString(),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        sourceChain: a.sourceChain,
      },
      subject,
    );
  }
}

/**
 * After the lock is held the account may have been merged away meanwhile: continue on the survivor.
 * An account archived for any other reason is not found.
 */
async function lockLive(ctx: ModuleContext, id: string): Promise<string> {
  await lockAccount(ctx, id);
  const live = async (accountId: string) => {
    const [row] = await ctx.tx
      .select({ archivedAt: account.archivedAt })
      .from(account)
      .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
    return !!row && !row.archivedAt;
  };
  if (await live(id)) return id;
  const found = await resolveAccountId(ctx, id);
  if (!found || found.id === id) throw notFound();
  await lockAccount(ctx, found.id);
  if (!(await live(found.id))) throw notFound();
  return found.id;
}

/**
 * The one entry point intake uses to create or update an account from a resolved arrival
 * (ACC-E1-S1). Runs in the caller's transaction, under the account lock. Reads apply no visibility:
 * it runs inside intake's pipeline.
 */
export async function upsertFromArrival(ctx: ModuleContext, a: ArrivalForAccounts, accountId?: string): Promise<UpsertResult> {
  const target = await createOrLoad(ctx, a, accountId);
  const id = await lockLive(ctx, target.id);
  const chain = a.sourceChain;

  const [before] = await ctx.tx
    .select({ domain: account.domain })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  // 1, 2. Facts about the account, then the current values.
  const factIds = await recordFacts(ctx, id, null, accountFacts(a, target.isShell), chain, a.arrivalId);
  await reproject(ctx, id);
  // 3. Aliases.
  await addAliases(ctx, id, a, before?.domain ?? null);
  // 4. People.
  const people: PersonResult[] = [];
  for (const [i, p] of a.people.entries()) {
    const personFacts = a.facts
      .filter((f) => f.personIndex === i)
      .map((f) => ({ key: f.key, value: f.value, url: f.url, note: f.note, observedAt: f.observedAt ?? a.receivedAt }));
    const r = await matchOrAddPerson(ctx, id, p, chain, a.arrivalId, {
      observedAt: a.receivedAt,
      facts: personFacts,
      extraRoleKeys: target.isShell && a.soleProprietor && i === 0 ? SHELL_ROLES : [],
    });
    people.push(r);
    factIds.push(...r.factIds);
  }
  if (people.length) await repickPrimary(ctx, id);
  // 5. Signals.
  const signals: StoredSignal[] = [];
  for (const s of a.signals) signals.push(await storeSignal(ctx, id, s, chain, a.arrivalId, a.receivedAt));
  // 6. Research tier.
  await projectResearchTier(ctx, id, a, factIds);
  if (target.created) await publishCreated(ctx, id, a);
  // 7. Practices. A new account's practices are part of its creation, not an update.
  const practiceId = await resolvePractice(ctx, a.practiceHint);
  if (practiceId) await setPractices(ctx, id, [practiceId], 'hint', { publish: !target.created });
  // 8. Exclusion.
  const excluded = await applyExclusion(ctx, id);
  // 9. Summary, with this arrival's sources added inline.
  const sourceIds = [chain.personSourceId, chain.agentSourceId, chain.vendorSourceId].filter((s): s is string => !!s);
  await writeSummary(ctx, id, { addSourceIds: sourceIds });
  // 10. Events (account.created went out after step 6).
  await publishEvents(ctx, id, a, target.created, people, signals, factIds);

  return {
    accountId: id,
    created: target.created,
    personIds: people.map((p) => p.personId),
    existingPersonIds: people.filter((p) => p.existing).map((p) => p.personId),
    signalIds: signals.map((s) => s.signalId),
    existingSignalIds: signals.filter((s) => s.existing).map((s) => s.signalId),
    factIds,
    excluded,
  };
}
