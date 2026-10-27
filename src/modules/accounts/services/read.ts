import { and, arrayOverlaps, asc, desc, eq, exists, gt, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { AccountView, CrmStatus, FactKind, FactView, PersonView, RoleOrigin, SignalKind, SignalView, SourceChain } from '../contracts/types';
import { account, accountAlias, accountSummary, exclusionRule, fact, person, personRole, signal } from '../db/schema';
import type { Exclusion } from './exclusion';
import { resolveAccountId } from './match';
import { filterVisibleAccountIds, visibleAccounts } from './visibility';

type PersonRow = typeof person.$inferSelect;
type FactRow = typeof fact.$inferSelect;
type SignalRow = typeof signal.$inferSelect;

async function canSee(ctx: ModuleContext, accountId: string): Promise<boolean> {
  return (await filterVisibleAccountIds(ctx, [accountId])).length === 1;
}

/** Follows merged ids, then checks the caller may see the account. */
async function visible(ctx: ModuleContext, id: string): Promise<{ id: string; mergedInto?: string } | null> {
  const found = await resolveAccountId(ctx, id);
  return found && (await canSee(ctx, found.id)) ? found : null;
}

const chainOf = (r: { personSourceId: string | null; agentSourceId: string | null; vendorSourceId: string | null }): SourceChain => ({
  ...(r.personSourceId ? { personSourceId: r.personSourceId } : {}),
  ...(r.agentSourceId ? { agentSourceId: r.agentSourceId } : {}),
  ...(r.vendorSourceId ? { vendorSourceId: r.vendorSourceId } : {}),
});

const toFact = (f: FactRow): FactView => ({
  id: f.id,
  accountId: f.accountId,
  personId: f.personId,
  key: f.key,
  value: f.value,
  valueType: f.valueType,
  kind: f.kind as FactKind,
  sourceChain: chainOf(f),
  arrivalId: f.arrivalId,
  url: f.url,
  note: f.note,
  observedAt: f.observedAt,
  recordedAt: f.recordedAt,
  status: f.status as FactView['status'],
  pinnedBy: f.pinnedBy,
  pinnedAt: f.pinnedAt,
});

const toSignal = (s: SignalRow): SignalView => ({
  id: s.id,
  accountId: s.accountId,
  type: s.type,
  kind: s.kind as SignalKind,
  title: s.title,
  detail: s.detail,
  url: s.url,
  value: s.value,
  confidence: s.confidence,
  occurredAt: s.occurredAt,
  sourceChain: chainOf(s),
  arrivalId: s.arrivalId,
  externalId: s.externalId,
  recordedAt: s.recordedAt,
  archivedAt: s.archivedAt,
});

async function peopleOf(ctx: ModuleContext, accountIds: string[]): Promise<PersonView[]> {
  const rows = await ctx.tx
    .select()
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), inArray(person.accountId, accountIds), isNull(person.archivedAt)))
    .orderBy(asc(person.createdAt), asc(person.id));
  const roles = rows.length
    ? await ctx.tx
        .select()
        .from(personRole)
        .where(and(eq(personRole.tenantId, ctx.tenantId), inArray(personRole.personId, rows.map((p) => p.id))))
        .orderBy(asc(personRole.roleKey))
    : [];
  const view = (p: PersonRow): PersonView => ({
    id: p.id,
    accountId: p.accountId,
    firstName: p.firstName,
    lastName: p.lastName,
    title: p.title,
    seniority: p.seniority,
    email: p.email,
    emailStatus: p.emailStatus,
    phone: p.phone,
    mobilePhone: p.mobilePhone,
    linkedinUrl: p.linkedinUrl,
    isPrimary: p.isPrimary,
    decisionNote: p.decisionNote,
    roles: roles.filter((r) => r.personId === p.id).map((r) => ({ key: r.roleKey, origin: r.origin as RoleOrigin })),
  });
  return rows.map(view);
}

/** An account with its people and aliases, following a merged id to its survivor (`mergedInto` is then set). */
export async function getAccount(ctx: ModuleContext, id: string): Promise<(AccountView & { mergedInto?: string }) | null> {
  return (await getAccounts(ctx, [id]))[0] ?? null;
}

/** The accounts for these ids, in order. Missing, hidden and repeated (after merges) ids are left out. */
export async function getAccounts(ctx: ModuleContext, ids: string[]): Promise<(AccountView & { mergedInto?: string })[]> {
  const found: { id: string; mergedInto?: string }[] = [];
  for (const id of ids) {
    const r = await visible(ctx, id);
    if (r && !found.some((f) => f.id === r.id)) found.push(r);
  }
  if (found.length === 0) return [];
  const keys = found.map((f) => f.id);
  const rows = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), inArray(account.id, keys)));
  const aliases = await ctx.tx
    .select()
    .from(accountAlias)
    .where(and(eq(accountAlias.tenantId, ctx.tenantId), inArray(accountAlias.accountId, keys)))
    .orderBy(asc(accountAlias.createdAt), asc(accountAlias.value));
  const people = await peopleOf(ctx, keys);
  return found.flatMap((f) => {
    const a = rows.find((r) => r.id === f.id);
    if (!a) return [];
    const { tenantId: _tenant, matchName: _match, updatedAt: _updated, ...cols } = a;
    return [
      {
        ...cols,
        researchTier: a.researchTier as AccountView['researchTier'],
        crmStatus: a.crmStatus as CrmStatus,
        people: people.filter((p) => p.accountId === f.id),
        aliases: aliases.filter((x) => x.accountId === f.id).map((x) => ({ kind: x.kind, value: x.value, system: x.system })),
        ...(f.mergedInto ? { mergedInto: f.mergedInto } : {}),
      },
    ];
  });
}

/** Signals, newest first. Archived ones are left out unless asked for; `since` keeps those that happened on or after it. */
export async function getSignals(
  ctx: ModuleContext,
  accountId: string,
  opts: { since?: Date; includeArchived?: boolean } = {},
): Promise<SignalView[]> {
  const target = await visible(ctx, accountId);
  if (!target) return [];
  const where: (SQL | undefined)[] = [
    eq(signal.tenantId, ctx.tenantId),
    eq(signal.accountId, target.id),
    opts.includeArchived ? undefined : isNull(signal.archivedAt),
    opts.since ? gte(signal.occurredAt, opts.since) : undefined,
  ];
  const rows = await ctx.tx.select().from(signal).where(and(...where)).orderBy(desc(signal.occurredAt), desc(signal.id));
  return rows.map(toSignal);
}

/** One signal, when the principal can see its account. */
export async function getSignal(ctx: ModuleContext, signalId: string): Promise<SignalView | null> {
  const [row] = await ctx.tx.select().from(signal).where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.id, signalId)));
  return row && (await visible(ctx, row.accountId)) ? toSignal(row) : null;
}

/** Current facts, or every fact with its status when `includeHistory` is set. */
export async function getFacts(
  ctx: ModuleContext,
  accountId: string,
  opts: { key?: string; includeHistory?: boolean } = {},
): Promise<FactView[]> {
  const target = await visible(ctx, accountId);
  if (!target) return [];
  const where: (SQL | undefined)[] = [
    eq(fact.tenantId, ctx.tenantId),
    eq(fact.accountId, target.id),
    opts.key ? eq(fact.key, opts.key) : undefined,
    opts.includeHistory ? undefined : eq(fact.status, 'current'),
  ];
  const rows = await ctx.tx.select().from(fact).where(and(...where)).orderBy(desc(fact.observedAt), desc(fact.id));
  return rows.map(toFact);
}

/** One person with their roles, when the principal can see their account. */
export async function getPerson(ctx: ModuleContext, personId: string): Promise<PersonView | null> {
  const [row] = await ctx.tx
    .select({ accountId: person.accountId })
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId), isNull(person.archivedAt)));
  if (!row || !(await canSee(ctx, row.accountId))) return null;
  return (await peopleOf(ctx, [row.accountId])).find((p) => p.id === personId) ?? null;
}

export async function listPeople(ctx: ModuleContext, accountId: string): Promise<PersonView[]> {
  const target = await visible(ctx, accountId);
  return target ? peopleOf(ctx, [target.id]) : [];
}

export type ScoringView = {
  accountId: string;
  domain: string | null;
  industry: string | null;
  industryKey: string | null;
  employees: number | null;
  revenueCents: number | null;
  hqCountry: string | null;
  technologies: string[];
  headcountGrowth6m: number | null;
  practiceIds: string[];
  facts: FactView[];
  people: PersonView[];
  signals: SignalView[];
  researchTier: 'A' | 'B' | 'C' | null;
  researchTierSignalAt: Date | null;
  excludedReasonKey: string | null;
  excludedLabel: string | null;
  excludedOverride: boolean;
};

/** Everything scoring needs in one read: current columns, facts, people with roles, live signals, tier and the exclusion flags. Follows a merged id to its survivor. */
export async function getAccountForScoring(ctx: ModuleContext, accountId: string): Promise<ScoringView | null> {
  const target = await visible(ctx, accountId);
  if (!target) return null;
  const [acc] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, target.id)));
  if (!acc) return null;
  const exclusion = acc.excludedReasonKey ? await checkExclusion(ctx, acc.id) : null;
  return {
    accountId: acc.id,
    domain: acc.domain,
    industry: acc.industry,
    industryKey: acc.industryKey,
    employees: acc.employees,
    revenueCents: acc.revenueCents,
    hqCountry: acc.hqCountry,
    technologies: acc.technologies,
    headcountGrowth6m: acc.headcountGrowth6m,
    practiceIds: acc.practiceIds,
    facts: await getFacts(ctx, acc.id),
    people: await peopleOf(ctx, [acc.id]),
    signals: await getSignals(ctx, acc.id),
    researchTier: acc.researchTier as ScoringView['researchTier'],
    researchTierSignalAt: acc.researchTierSignalAt,
    excludedReasonKey: acc.excludedReasonKey,
    excludedLabel: exclusion?.label ?? null,
    excludedOverride: acc.excludedOverride,
  };
}

const MAX_PAGE = 200;
const MAX_SUMMARY_IDS = 1_000;

/**
 * Active account ids in id order, for background jobs: no visibility filter, so it refuses a context with an access.
 * `practiceIds` and `includeNoPractice` together keep accounts in any of those practices or in none;
 * `hasSignalSince` keeps accounts with a live signal on or after that time (an undated one counts from its recorded day).
 */
export async function listAccountIds(
  ctx: ModuleContext,
  opts: { practiceIds?: string[]; includeNoPractice?: boolean; hasSignalSince?: Date; afterId?: string; limit?: number } = {},
): Promise<{ ids: string[]; nextAfterId: string | null }> {
  if (ctx.access) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only background jobs can list every account.' });
  const limit = opts.limit ?? MAX_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new ScoutError({ slug: 'validation', status: 400, title: `Ask for 1 to ${MAX_PAGE} accounts at a time.` });
  }
  const byPractice =
    opts.practiceIds || opts.includeNoPractice
      ? or(
          opts.practiceIds?.length ? arrayOverlaps(account.practiceIds, opts.practiceIds) : undefined,
          opts.includeNoPractice ? sql`cardinality(${account.practiceIds}) = 0` : undefined,
        ) ?? sql`false`
      : undefined;
  const bySignal = opts.hasSignalSince
    ? exists(
        ctx.tx
          .select({ one: signal.id })
          .from(signal)
          .where(
            and(
              eq(signal.tenantId, ctx.tenantId),
              eq(signal.accountId, account.id),
              isNull(signal.archivedAt),
              sql`coalesce(${signal.occurredAt}, ${signal.recordedAt}) >= ${opts.hasSignalSince.toISOString()}::timestamptz`,
            ),
          ),
      )
    : undefined;
  const rows = await ctx.tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), isNull(account.archivedAt), opts.afterId ? gt(account.id, opts.afterId) : undefined, byPractice, bySignal))
    .orderBy(asc(account.id))
    .limit(limit + 1);
  const ids = rows.slice(0, limit).map((r) => r.id);
  return { ids, nextAfterId: rows.length > limit ? ids[ids.length - 1]! : null };
}

export type AccountSummaryView = {
  accountId: string;
  stage: string | null;
  reviewStatusKey: string | null;
  ownerUserId: string | null;
  priority: number | null;
  tier: string | null;
  bestOfferId: string | null;
};

/** The summary row of each account the principal can see, for at most 1,000 ids. Ids with no row or no access are left out. */
export async function getSummaries(ctx: ModuleContext, ids: string[]): Promise<AccountSummaryView[]> {
  if (ids.length > MAX_SUMMARY_IDS) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Ask for at most 1,000 accounts at a time.' });
  }
  if (ids.length === 0) return [];
  return ctx.tx
    .select({
      accountId: accountSummary.accountId,
      stage: accountSummary.stage,
      reviewStatusKey: accountSummary.reviewStatusKey,
      ownerUserId: accountSummary.ownerUserId,
      priority: accountSummary.priority,
      tier: accountSummary.tier,
      bestOfferId: accountSummary.bestOfferId,
    })
    .from(accountSummary)
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), inArray(accountSummary.accountId, ids), await visibleAccounts(ctx)))
    .orderBy(asc(accountSummary.accountId));
}

/** The stored exclusion (key, label and whether a person overrode it), or null when the account is not excluded. */
export async function checkExclusion(ctx: ModuleContext, accountId: string): Promise<Exclusion | null> {
  const target = await visible(ctx, accountId);
  if (!target) return null;
  const [acc] = await ctx.tx
    .select({ key: account.excludedReasonKey, override: account.excludedOverride })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, target.id)));
  if (!acc?.key) return null;
  const [rule] = await ctx.tx
    .select({ label: exclusionRule.label })
    .from(exclusionRule)
    .where(and(eq(exclusionRule.tenantId, ctx.tenantId), eq(exclusionRule.key, acc.key)));
  return { key: acc.key, label: rule?.label ?? acc.key, override: acc.override };
}
