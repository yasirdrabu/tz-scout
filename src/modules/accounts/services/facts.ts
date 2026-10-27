import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { sourceInfoProvider } from '../contracts/ports';
import { isKnownFactKey, type FactKind, type SourceChain } from '../contracts/types';
import { account, fact, person } from '../db/schema';
import { pickCurrent, type PickFact } from '../domain/current-value';
import { matchName, regionKey } from '../domain/names';

type AccountRow = typeof account.$inferInsert;
type PersonRow = typeof person.$inferInsert;

/** Fact key to the account column that holds its current value. */
export const ACCOUNT_COLUMNS: Record<string, keyof AccountRow> = {
  name: 'name',
  domain: 'domain',
  website_url: 'websiteUrl',
  linkedin_url: 'linkedinUrl',
  industry: 'industry',
  industry_key: 'industryKey',
  employees: 'employees',
  employees_min: 'employeesMin',
  employees_max: 'employeesMax',
  revenue_cents: 'revenueCents',
  revenue_min_cents: 'revenueMinCents',
  revenue_max_cents: 'revenueMaxCents',
  hq_city: 'hqCity',
  hq_state: 'hqState',
  hq_country: 'hqCountry',
  description: 'description',
  technologies: 'technologies',
  keywords: 'keywords',
  parent_domain: 'parentDomain',
  headcount_growth_6m: 'headcountGrowth6m',
  founded_year: 'foundedYear',
};

/** Fact key to the person column that holds its current value. */
export const PERSON_COLUMNS: Record<string, keyof PersonRow> = {
  first_name: 'firstName',
  last_name: 'lastName',
  title: 'title',
  seniority: 'seniority',
  email: 'email',
  email_status: 'emailStatus',
  phone: 'phone',
  mobile_phone: 'mobilePhone',
  linkedin_url: 'linkedinUrl',
  decision_note: 'decisionNote',
};

export type FactInput = { key: string; value: unknown; url?: string; note?: string; observedAt?: Date };

const chainKey = (c: SourceChain) => `${c.personSourceId ?? ''}|${c.agentSourceId ?? ''}|${c.vendorSourceId ?? ''}`;
const chainOf = (r: { personSourceId: string | null; agentSourceId: string | null; vendorSourceId: string | null }): SourceChain => ({
  ...(r.personSourceId ? { personSourceId: r.personSourceId } : {}),
  ...(r.agentSourceId ? { agentSourceId: r.agentSourceId } : {}),
  ...(r.vendorSourceId ? { vendorSourceId: r.vendorSourceId } : {}),
});
const LIVE = ['current', 'candidate'];

function kindOf(key: string, personId: string | null): FactKind {
  if (key.startsWith('form.')) return 'form_answer';
  if (personId) return 'contact';
  if (key in ACCOUNT_COLUMNS) return 'firmographic';
  return isKnownFactKey(key) ? 'research' : 'custom';
}

function valueTypeOf(value: unknown): string {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

/**
 * Stores what a source said, as `candidate` facts; `reproject` decides which are current.
 * A fact this chain already said (same key, same value, still live) is not stored again.
 * Returns the ids of the facts it stored.
 */
export async function recordFacts(
  ctx: ModuleContext,
  accountId: string,
  personId: string | null,
  facts: FactInput[],
  chain: SourceChain,
  arrivalId?: string,
): Promise<string[]> {
  const given = facts.filter((f) => f.value !== undefined && f.value !== null);
  if (given.length === 0) return [];
  const live = await ctx.tx
    .select()
    .from(fact)
    .where(
      and(
        eq(fact.tenantId, ctx.tenantId),
        eq(fact.accountId, accountId),
        personId ? eq(fact.personId, personId) : isNull(fact.personId),
        inArray(fact.key, given.map((f) => f.key)),
        inArray(fact.status, LIVE),
      ),
    );
  const said = new Set(live.map((f) => `${f.key}\n${chainKey(chainOf(f))}\n${JSON.stringify(f.value)}`));
  const fresh = given.filter((f) => !said.has(`${f.key}\n${chainKey(chain)}\n${JSON.stringify(f.value)}`));
  if (fresh.length === 0) return [];
  const inserted = await ctx.tx
    .insert(fact)
    .values(
      fresh.map((f) => ({
        id: newId('fct'),
        tenantId: ctx.tenantId,
        accountId,
        personId,
        key: f.key,
        value: f.value,
        valueType: valueTypeOf(f.value),
        kind: kindOf(f.key, personId),
        personSourceId: chain.personSourceId ?? null,
        agentSourceId: chain.agentSourceId ?? null,
        vendorSourceId: chain.vendorSourceId ?? null,
        arrivalId: arrivalId ?? null,
        url: f.url ?? null,
        note: f.note ?? null,
        observedAt: f.observedAt ?? new Date(),
        status: 'candidate',
      })),
    )
    .returning({ id: fact.id });
  return inserted.map((r) => r.id);
}

/**
 * Re-picks the current value of each key (all keys, or `keys`) for the account and its people,
 * sets fact statuses, and writes the projected columns plus `match_name` and `hq_state_key`.
 * Trust is read once per distinct source chain.
 */
export async function reproject(ctx: ModuleContext, accountId: string, keys?: string[]): Promise<void> {
  const rows = await ctx.tx
    .select()
    .from(fact)
    .where(
      and(
        eq(fact.tenantId, ctx.tenantId),
        eq(fact.accountId, accountId),
        inArray(fact.status, LIVE),
        keys ? inArray(fact.key, keys) : undefined,
      ),
    );
  if (rows.length === 0) return;

  const trust = new Map<string, number>();
  for (const r of rows) {
    const k = chainKey(chainOf(r));
    if (!trust.has(k)) trust.set(k, await sourceInfoProvider().getTrust(ctx, chainOf(r)));
  }

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = `${r.personId ?? ''}\n${r.key}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }

  const status = new Map<string, string>();
  const accountSet: Partial<AccountRow> = {};
  const personSets = new Map<string, Partial<PersonRow>>();
  for (const facts of groups.values()) {
    const { personId, key } = facts[0]!;
    const pick = pickCurrent(
      facts.map<PickFact>((f) => ({ id: f.id, key: f.key, value: f.value, observedAt: f.observedAt, pinned: !!f.pinnedAt, sourceChain: chainOf(f) })),
      (f) => trust.get(chainKey(f.sourceChain)) ?? 0,
    );
    const superseded = new Set(pick.supersededIds);
    for (const f of facts) {
      const next = f.id === pick.currentId ? 'current' : superseded.has(f.id) ? 'superseded' : 'candidate';
      if (next !== f.status) status.set(f.id, next);
    }
    const column = personId ? PERSON_COLUMNS[key] : ACCOUNT_COLUMNS[key];
    if (!column) continue;
    if (personId) personSets.set(personId, { ...personSets.get(personId), [column]: pick.value });
    else Object.assign(accountSet, { [column]: pick.value });
  }

  for (const next of ['current', 'candidate', 'superseded']) {
    const ids = [...status].filter(([, s]) => s === next).map(([id]) => id);
    if (ids.length) await ctx.tx.update(fact).set({ status: next }).where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, ids)));
  }

  if (Object.keys(accountSet).length) await writeAccountColumns(ctx, accountId, accountSet);
  for (const [personId, set] of personSets) {
    const where = and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId));
    const [before] = await ctx.tx.select().from(person).where(where);
    const changed = before && changedOnly(before, set);
    if (changed) await ctx.tx.update(person).set({ ...changed, updatedAt: new Date() }).where(where);
  }
}

/** The entries of `set` that differ from `before`, or null when nothing changes. */
function changedOnly<T extends object>(before: T, set: Partial<T>): Partial<T> | null {
  const out = Object.fromEntries(
    Object.entries(set).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k as keyof T])),
  ) as Partial<T>;
  return Object.keys(out).length ? out : null;
}

async function writeAccountColumns(ctx: ModuleContext, accountId: string, set: Partial<AccountRow>): Promise<void> {
  const [before] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  if (!before) return;
  if (set.name !== undefined) set.matchName = matchName(String(set.name));
  if (set.hqState !== undefined || set.hqCountry !== undefined) {
    set.hqStateKey = regionKey(set.hqCountry ?? before.hqCountry, set.hqState ?? before.hqState);
  }
  if (set.domain !== undefined && set.domain !== before.domain && set.domain !== null) {
    // Another active account already holds that domain: keep ours (the new one is kept as an alias).
    const [taken] = await ctx.tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.tenantId, ctx.tenantId), eq(account.domain, String(set.domain)), isNull(account.archivedAt), ne(account.id, accountId)));
    if (taken) delete set.domain;
  }
  const changed = changedOnly(before, set);
  if (!changed) return;
  await ctx.tx
    .update(account)
    .set({ ...changed, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
}
