import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { account, accountAlias, person } from '../db/schema';
import { matchName, regionKey, trigramSimilarity } from '../domain/names';

export type MatchConfidence = 'certain' | 'likely' | 'possible';
export type AccountMatch = { accountId: string; confidence: MatchConfidence; reason: string };

export type MatchCandidate = {
  domain?: string;
  linkedinUrl?: string;
  externalIds?: { system: string; id: string }[];
  name?: string;
  country?: string;
  region?: string;
  city?: string;
  shellEmail?: string;
};

const MAX_MATCHES = 5;
const POSSIBLE_THRESHOLD = 0.85;
const MAX_MERGE_HOPS = 20;

// The Match column of the SRC-E3 step 4 table.
const REASONS = {
  domain: 'Same domain, or a domain alias of an account',
  linkedin: 'Same company LinkedIn URL',
  externalId: 'Same (source, external_id) seen before on an account',
  shell: 'Same person email on a shell account',
  likely: 'Same normalised name and same country, account has no domain',
  possible: 'Name is very similar and in the same state or city',
} as const;

const trimSlashes = (s: string) => s.trim().toLowerCase().replace(/\/+$/, '');

/**
 * Which existing accounts an arrival may belong to, strongest first, at most 5 (SRC-E3 step 4).
 * Archived accounts never match; a merged account's domain and ids are aliases of its survivor.
 * Reads apply no visibility: it runs inside intake's pipeline.
 */
export async function findMatches(ctx: ModuleContext, c: MatchCandidate): Promise<AccountMatch[]> {
  const live = and(eq(account.tenantId, ctx.tenantId), isNull(account.archivedAt));
  const found: AccountMatch[] = [];
  const add = (rows: { id: string }[], confidence: MatchConfidence, reason: string) => {
    for (const r of rows) found.push({ accountId: r.id, confidence, reason });
  };

  const domain = c.domain?.trim().toLowerCase();
  if (domain) {
    add(await ctx.tx.select({ id: account.id }).from(account).where(and(live, eq(account.domain, domain))), 'certain', REASONS.domain);
    add(
      await ctx.tx
        .select({ id: account.id })
        .from(accountAlias)
        .innerJoin(account, eq(account.id, accountAlias.accountId))
        .where(and(live, eq(accountAlias.tenantId, ctx.tenantId), eq(accountAlias.kind, 'domain'), sql`lower(${accountAlias.value}) = ${domain}`)),
      'certain',
      REASONS.domain,
    );
  }

  if (c.linkedinUrl) {
    const url = trimSlashes(c.linkedinUrl);
    add(
      await ctx.tx.select({ id: account.id }).from(account).where(and(live, sql`rtrim(lower(${account.linkedinUrl}), '/') = ${url}`)),
      'certain',
      REASONS.linkedin,
    );
  }

  for (const x of c.externalIds ?? []) {
    add(
      await ctx.tx
        .select({ id: account.id })
        .from(accountAlias)
        .innerJoin(account, eq(account.id, accountAlias.accountId))
        .where(and(live, eq(accountAlias.tenantId, ctx.tenantId), eq(accountAlias.kind, 'external_id'), eq(accountAlias.system, x.system), eq(accountAlias.value, x.id))),
      'certain',
      REASONS.externalId,
    );
  }

  if (c.shellEmail) {
    add(
      await ctx.tx
        .select({ id: account.id })
        .from(person)
        .innerJoin(account, eq(account.id, person.accountId))
        .where(and(live, eq(account.isShell, true), eq(person.tenantId, ctx.tenantId), isNull(person.archivedAt), sql`lower(${person.email}) = ${c.shellEmail.trim().toLowerCase()}`)),
      'certain',
      REASONS.shell,
    );
  }

  const name = c.name ? matchName(c.name) : '';
  if (name) {
    if (c.country) {
      add(
        await ctx.tx
          .select({ id: account.id })
          .from(account)
          .where(and(live, eq(account.matchName, name), isNull(account.domain), sql`lower(${account.hqCountry}) = ${c.country.trim().toLowerCase()}`)),
        'likely',
        REASONS.likely,
      );
    }
    found.push(...(await possibleMatches(ctx, live, c, name)));
  }

  const best = new Map<string, AccountMatch>();
  for (const m of found) if (!best.has(m.accountId)) best.set(m.accountId, m); // found is in table order
  return [...best.values()].slice(0, MAX_MATCHES);
}

/** Pre-filters in SQL by the same region key or city, then scores by name similarity here. */
async function possibleMatches(ctx: ModuleContext, live: SQL | undefined, c: MatchCandidate, name: string): Promise<AccountMatch[]> {
  const key = regionKey(c.country, c.region);
  const city = c.city?.trim().toLowerCase();
  const places = [key ? eq(account.hqStateKey, key) : undefined, city ? sql`lower(${account.hqCity}) = ${city}` : undefined].filter(
    (p): p is SQL => !!p,
  );
  if (places.length === 0) return [];
  const rows = await ctx.tx
    .select({ id: account.id, matchName: account.matchName })
    .from(account)
    .where(and(live, sql`(${sql.join(places, sql` or `)})`));
  return rows
    .map((r) => ({ id: r.id, score: trigramSimilarity(r.matchName, name) }))
    .filter((r) => r.score >= POSSIBLE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ accountId: r.id, confidence: 'possible' as const, reason: REASONS.possible }));
}

/**
 * Follows `merged_id` aliases to the surviving account. `mergedInto` is set (to the survivor's id) when
 * the id asked for was merged away. Null when the id is neither an account nor a merged id.
 */
export async function resolveAccountId(ctx: ModuleContext, id: string): Promise<{ id: string; mergedInto?: string } | null> {
  let current = id;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const [alias] = await ctx.tx
      .select({ survivorId: accountAlias.accountId })
      .from(accountAlias)
      .where(and(eq(accountAlias.tenantId, ctx.tenantId), eq(accountAlias.kind, 'merged_id'), eq(accountAlias.value, current)));
    if (!alias) break;
    current = alias.survivorId;
  }
  const [row] = await ctx.tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, current)));
  if (!row) return null;
  return current === id ? { id } : { id: current, mergedInto: current };
}
