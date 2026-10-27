import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import type { ArrivalPerson, SourceChain } from '../contracts/types';
import { fact, person, personRole } from '../db/schema';
import { ScoutError } from '@/platform/errors';
import { reprojectPerson } from './edit';
import { PERSON_COLUMNS, recordFacts, reproject, type FactInput } from './facts';

type PersonRow = typeof person.$inferSelect;

export type PersonResult = {
  personId: string;
  existing: boolean;
  factIds: string[];
  /** Fact keys recorded, plus `roles` when a role was added. Empty for a new person. */
  changedKeys: string[];
  roleKeys: string[];
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const normLinkedin = (s: string | null | undefined) =>
  norm(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const letters = (s: string | null | undefined) => norm(s).replace(/[^\p{L}]/gu, '');

/** True when an email's local part is built from the person's name: jsmith, john.smith, smithj, john, ... */
function nameFitsEmail(p: PersonRow, email: string): boolean {
  const local = letters(email.split('@')[0]);
  const f = letters(p.firstName);
  const l = letters(p.lastName);
  if (!local || !f) return false;
  const forms = [f + l, f[0] + l, f + l.slice(0, 1), l + f, l + f[0], f, l].filter((x) => x.length > 1);
  return forms.includes(local);
}

export type MatchablePerson = { email?: string | null; linkedinUrl?: string | null; firstName?: string | null; lastName?: string | null };

/** The person among `people` that `input` is, by email, then LinkedIn, then name. */
export function findMatch(people: PersonRow[], input: MatchablePerson): PersonRow | undefined {
  if (input.email) {
    const byEmail = people.find((p) => norm(p.email) === norm(input.email));
    if (byEmail) return byEmail;
  }
  if (input.linkedinUrl) {
    const byLinkedin = people.find((p) => p.linkedinUrl && normLinkedin(p.linkedinUrl) === normLinkedin(input.linkedinUrl));
    if (byLinkedin) return byLinkedin;
  }
  if (input.firstName) {
    const byName = people.find((p) => norm(p.firstName) === norm(input.firstName) && norm(p.lastName) === norm(input.lastName));
    if (byName) return byName;
  }
  // A published email from a research sheet, with no name: the person whose name fits it.
  if (input.email && !input.firstName && !input.lastName) {
    const fits = people.filter((p) => !p.email && nameFitsEmail(p, input.email!));
    if (fits.length === 1) return fits[0];
  }
  return undefined;
}

function personFacts(input: ArrivalPerson, observedAt?: Date): FactInput[] {
  const values: Record<string, unknown> = {
    first_name: input.firstName,
    last_name: input.lastName,
    title: input.title,
    seniority: input.seniority,
    email: input.email?.trim().toLowerCase(),
    email_status: input.emailStatus,
    phone: input.phone,
    mobile_phone: input.mobilePhone,
    linkedin_url: input.linkedinUrl,
    decision_note: input.decisionNote,
  };
  return Object.entries(values)
    .filter(([key, value]) => key in PERSON_COLUMNS && value !== undefined)
    .map(([key, value]) => ({ key, value, observedAt }));
}

/**
 * Finds the person at the account (email, then LinkedIn, then same first and last name, then a
 * research-sheet email whose local part fits a name) or adds them. Records the values as facts and
 * the roles as `stated`. The caller holds the account lock.
 */
export async function matchOrAddPerson(
  ctx: ModuleContext,
  accountId: string,
  input: ArrivalPerson,
  chain: SourceChain,
  arrivalId: string,
  opts: { observedAt?: Date; facts?: FactInput[]; extraRoleKeys?: string[] } = {},
): Promise<PersonResult> {
  const people = await ctx.tx
    .select()
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, accountId), isNull(person.archivedAt)));
  const match = findMatch(people, input);
  const personId = match?.id ?? newId('per');
  if (!match) await ctx.tx.insert(person).values({ id: personId, tenantId: ctx.tenantId, accountId });

  const facts = [...personFacts(input, opts.observedAt), ...(opts.facts ?? [])];
  const factIds = await recordFacts(ctx, accountId, personId, facts, chain, arrivalId);
  const recordedKeys = factIds.length
    ? [...new Set((await ctx.tx.select({ key: fact.key }).from(fact).where(inArray(fact.id, factIds))).map((f) => f.key))]
    : [];
  if (recordedKeys.length) await reproject(ctx, accountId, recordedKeys);

  const wanted = [...new Set([...(input.roleKeys ?? []), ...(opts.extraRoleKeys ?? [])])];
  const added = wanted.length
    ? await ctx.tx
        .insert(personRole)
        .values(wanted.map((roleKey) => ({ tenantId: ctx.tenantId, personId, roleKey, origin: 'stated' })))
        .onConflictDoNothing()
        .returning({ roleKey: personRole.roleKey })
    : [];
  const roles = await ctx.tx
    .select({ roleKey: personRole.roleKey })
    .from(personRole)
    .where(and(eq(personRole.tenantId, ctx.tenantId), eq(personRole.personId, personId)));

  return {
    personId,
    existing: !!match,
    factIds,
    changedKeys: match ? [...recordedKeys, ...(added.length ? ['roles'] : [])] : [],
    roleKeys: roles.map((r) => r.roleKey).sort(),
  };
}

/**
 * Records facts about a person already at the account, for a targeted arrival that names the person
 * (an API key's `PATCH /people/{id}`). Facts stay unpinned; a changed email updates the person. The
 * caller holds the account lock.
 */
export async function updatePersonFromArrival(
  ctx: ModuleContext,
  accountId: string,
  personId: string,
  input: FactInput[],
  chain: SourceChain,
  arrivalId: string,
): Promise<PersonResult> {
  const [row] = await ctx.tx
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId), eq(person.accountId, accountId), isNull(person.archivedAt)));
  if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That person was not found.' });
  const facts = input.map((f) => (f.key === 'email' && typeof f.value === 'string' ? { ...f, value: f.value.trim().toLowerCase() } : f));
  const factIds = await recordFacts(ctx, accountId, personId, facts, chain, arrivalId);
  const keys = factIds.length
    ? [...new Set((await ctx.tx.select({ key: fact.key }).from(fact).where(inArray(fact.id, factIds))).map((f) => f.key))]
    : [];
  if (keys.length) await reprojectPerson(ctx, accountId, keys);
  const roles = await ctx.tx
    .select({ roleKey: personRole.roleKey })
    .from(personRole)
    .where(and(eq(personRole.tenantId, ctx.tenantId), eq(personRole.personId, personId)));
  return { personId, existing: true, factIds, changedKeys: keys, roleKeys: roles.map((r) => r.roleKey).sort() };
}
