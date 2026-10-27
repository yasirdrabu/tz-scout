import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { accountExclusionChanged, accountUpdated, personUpdated } from '../contracts/events';
import type { ArrivalAccountFields, ArrivalPerson, SourceChain } from '../contracts/types';
import { account, accountAlias, fact, person, personRole, signal } from '../db/schema';
import { matchName } from '../domain/names';
import { pickPrimary } from '../domain/primary';
import { applyExclusion } from './exclusion';
import { ACCOUNT_COLUMNS, PERSON_COLUMNS, recordFacts, reproject, type FactInput } from './facts';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { writeSummary } from './summary';

/** Fact key of a pinned primary contact; its value is the person id. */
const PRIMARY_KEY = 'primary_person_id';
const LIVE = ['current', 'candidate'];

const subjectOf = (id: string) => ({ type: 'account', id });
const notFound = (what: 'account' | 'person' | 'signal') => new ScoutError({ slug: 'not-found', status: 404, title: `That ${what} was not found.` });

/** Edits come from people only. The editor's person source is the person level of the fact's chain. */
function editor(ctx: ModuleContext): { userId: string; chain: SourceChain } {
  const userId = ctx.access?.userId;
  if (!userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can edit this here.' });
  return { userId, chain: ctx.access?.sourceId ? { personSourceId: ctx.access.sourceId } : {} };
}

/** The live account id for an id that may have been merged. */
async function accountIdFor(ctx: ModuleContext, id: string): Promise<string> {
  const found = await resolveAccountId(ctx, id);
  if (!found) throw notFound('account');
  return found.id;
}

const ACCOUNT_KEY_BY_FIELD: Record<string, string> = Object.fromEntries(Object.entries(ACCOUNT_COLUMNS).map(([key, col]) => [col, key]));
const PERSON_KEY_BY_FIELD: Record<string, string> = Object.fromEntries(Object.entries(PERSON_COLUMNS).map(([key, col]) => [col, key]));

function factsFromPatch(patch: object, keyByField: Record<string, string>): FactInput[] {
  return Object.entries(patch)
    .filter(([field, value]) => field in keyByField && value !== undefined && value !== null)
    .map(([field, value]) => ({ key: keyByField[field]!, value: field === 'domain' || field === 'email' ? String(value).trim().toLowerCase() : value }));
}

/** A domain another active account holds stays a candidate; the editor is told instead of silently ignored. */
async function assertDomainTaken(ctx: ModuleContext, accountId: string, domain: string): Promise<void> {
  const [row] = await ctx.tx.select({ domain: account.domain }).from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  if (row?.domain !== domain) throw new ScoutError({ slug: 'conflict', status: 409, title: 'Another account already has that domain.' });
}

export type AccountPatch = ArrivalAccountFields;

/** Pins each given account field as a fact from the editor, then re-picks the current values. */
export async function editAccount(ctx: ModuleContext, accountId: string, patch: AccountPatch): Promise<void> {
  const { userId, chain } = editor(ctx);
  const id = await accountIdFor(ctx, accountId);
  await lockAccount(ctx, id);
  const facts = factsFromPatch(patch, ACCOUNT_KEY_BY_FIELD);
  if (facts.length === 0) return;
  await recordFacts(ctx, id, null, facts, chain, undefined, userId);
  const keys = facts.map((f) => f.key);
  await reproject(ctx, id, keys);
  const domain = facts.find((f) => f.key === 'domain')?.value;
  if (typeof domain === 'string') await assertDomainTaken(ctx, id, domain);
  await applyExclusion(ctx, id);
  await publish(ctx, accountUpdated, { accountId: id, changedKeys: keys }, subjectOf(id));
}

export type PersonPatch = Pick<
  ArrivalPerson,
  'firstName' | 'lastName' | 'title' | 'seniority' | 'email' | 'emailStatus' | 'phone' | 'mobilePhone' | 'linkedinUrl' | 'decisionNote' | 'roleKeys'
>;

/**
 * Pins each given person field as a fact from the editor. `roleKeys` is the full set of roles the person should have;
 * roles added here are `set_by_person`. Re-picks the primary contact.
 */
export async function editPerson(ctx: ModuleContext, personId: string, patch: PersonPatch): Promise<void> {
  const { userId, chain } = editor(ctx);
  const [row] = await ctx.tx.select({ accountId: person.accountId }).from(person).where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId)));
  if (!row) throw notFound('person');
  const accountId = row.accountId;
  await lockAccount(ctx, accountId);

  const facts = factsFromPatch(patch, PERSON_KEY_BY_FIELD);
  const changedKeys = facts.map((f) => f.key);
  if (facts.length) {
    await recordFacts(ctx, accountId, personId, facts, chain, undefined, userId);
    await reproject(ctx, accountId, changedKeys);
  }

  let rolesChanged = false;
  if (patch.roleKeys) {
    const wanted = [...new Set(patch.roleKeys)];
    const where = and(eq(personRole.tenantId, ctx.tenantId), eq(personRole.personId, personId));
    const removed = await ctx.tx
      .delete(personRole)
      .where(wanted.length ? and(where, notInArray(personRole.roleKey, wanted)) : where)
      .returning({ roleKey: personRole.roleKey });
    const added = wanted.length
      ? await ctx.tx
          .insert(personRole)
          .values(wanted.map((roleKey) => ({ tenantId: ctx.tenantId, personId, roleKey, origin: 'set_by_person', setBy: userId })))
          .onConflictDoNothing()
          .returning({ roleKey: personRole.roleKey })
      : [];
    rolesChanged = removed.length > 0 || added.length > 0;
    if (rolesChanged) changedKeys.push('roles');
  }

  await repickPrimary(ctx, accountId);
  if (changedKeys.length === 0) return;
  const roles = await ctx.tx
    .select({ roleKey: personRole.roleKey })
    .from(personRole)
    .where(and(eq(personRole.tenantId, ctx.tenantId), eq(personRole.personId, personId)));
  await publish(
    ctx,
    personUpdated,
    { accountId, personId, changedKeys, roleKeys: roles.map((r) => r.roleKey).sort() },
    subjectOf(accountId),
  );
}

/**
 * Marks who to approach first: the pinned person if there is one, else the best by seniority and verified email.
 * Target titles come from the best offer, which arrives with R1b, so none are used yet. The caller holds the account lock.
 */
async function repickPrimary(ctx: ModuleContext, accountId: string): Promise<void> {
  const people = await ctx.tx
    .select()
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, accountId), isNull(person.archivedAt)));
  const [pin] = await ctx.tx
    .select({ value: fact.value })
    .from(fact)
    .where(
      and(
        eq(fact.tenantId, ctx.tenantId),
        eq(fact.accountId, accountId),
        eq(fact.key, PRIMARY_KEY),
        inArray(fact.status, LIVE),
        isNull(fact.personId),
      ),
    );
  const pinned = typeof pin?.value === 'string' ? pin.value : null;
  const primaryId = pickPrimary(
    people.map((p) => ({ id: p.id, title: p.title, seniority: p.seniority, emailStatus: p.emailStatus, pinnedPrimary: p.id === pinned })),
    [],
  );
  for (const p of people) {
    const next = p.id === primaryId;
    if (p.isPrimary !== next) {
      await ctx.tx
        .update(person)
        .set({ isPrimary: next, updatedAt: new Date() })
        .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, p.id)));
    }
  }
}

/** Pins a person as the one to approach first, or with `null` removes the pin so the pick is automatic again. */
export async function pinPrimary(ctx: ModuleContext, accountId: string, personId: string | null): Promise<void> {
  const { userId, chain } = editor(ctx);
  const id = await accountIdFor(ctx, accountId);
  await lockAccount(ctx, id);
  if (personId) {
    const [row] = await ctx.tx
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, id), eq(person.id, personId), isNull(person.archivedAt)));
    if (!row) throw notFound('person');
  }
  await ctx.tx
    .update(fact)
    .set({ status: 'archived' })
    .where(and(eq(fact.tenantId, ctx.tenantId), eq(fact.accountId, id), eq(fact.key, PRIMARY_KEY), inArray(fact.status, LIVE)));
  if (personId) {
    await recordFacts(ctx, id, null, [{ key: PRIMARY_KEY, value: personId }], chain, undefined, userId);
    await reproject(ctx, id, [PRIMARY_KEY]);
  }
  await repickPrimary(ctx, id);
  await publish(ctx, accountUpdated, { accountId: id, changedKeys: ['primary_person'] }, subjectOf(id));
}

/** Hides a signal from scoring ("Not relevant"). The reason is kept in the audit log. */
export async function archiveSignal(ctx: ModuleContext, signalId: string, reason: string): Promise<void> {
  editor(ctx);
  const [row] = await ctx.tx
    .select({ accountId: signal.accountId, archivedAt: signal.archivedAt })
    .from(signal)
    .where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.id, signalId)));
  if (!row) throw notFound('signal');
  await lockAccount(ctx, row.accountId);
  if (row.archivedAt) return;
  await ctx.tx
    .update(signal)
    .set({ archivedAt: new Date() })
    .where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.id, signalId)));
  await audit(ctx, { action: 'accounts.signal.archive', subject: { type: 'signal', id: signalId }, after: { accountId: row.accountId, reason } });
  await writeSummary(ctx, row.accountId);
}

async function setOverride(ctx: ModuleContext, accountId: string, on: boolean, note?: string): Promise<void> {
  const id = await accountIdFor(ctx, accountId);
  await lockAccount(ctx, id);
  const [acc] = await ctx.tx
    .select({ key: account.excludedReasonKey, override: account.excludedOverride })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  if (!acc || acc.override === on) return;
  await ctx.tx
    .update(account)
    .set({ excludedOverride: on, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  await audit(ctx, {
    action: on ? 'accounts.exclusion.override' : 'accounts.exclusion.remove_override',
    subject: subjectOf(id),
    before: { excludedOverride: acc.override, excludedReasonKey: acc.key },
    after: { excludedOverride: on, ...(note ? { note } : {}) },
  });
  await publish(ctx, accountExclusionChanged, { accountId: id, ...(acc.key ? { excludedReasonKey: acc.key } : {}), override: on }, subjectOf(id));
}

/** "Sell anyway": the account stays marked, but scoring and review treat the exclusion as overridden. A note is required. */
export async function overrideExclusion(ctx: ModuleContext, accountId: string, note: string): Promise<void> {
  editor(ctx);
  const trimmed = note.trim();
  if (!trimmed) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Add a note saying why.', errors: [{ path: 'note', message: 'Add a note saying why.' }] });
  }
  await setOverride(ctx, accountId, true, trimmed);
}

export async function removeExclusionOverride(ctx: ModuleContext, accountId: string): Promise<void> {
  editor(ctx);
  await setOverride(ctx, accountId, false);
}

/** Turns a shell account into a normal one with a company name and domain. The old name stays as an alias. */
export async function convertShell(ctx: ModuleContext, accountId: string, input: { name: string; domain: string }): Promise<void> {
  const { userId, chain } = editor(ctx);
  const id = await accountIdFor(ctx, accountId);
  await lockAccount(ctx, id);
  const [acc] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  if (!acc) throw notFound('account');
  if (!acc.isShell) throw new ScoutError({ slug: 'conflict', status: 409, title: 'This account is not a shell.' });

  const domain = input.domain.trim().toLowerCase();
  await recordFacts(ctx, id, null, [{ key: 'name', value: input.name.trim() }, { key: 'domain', value: domain }], chain, undefined, userId);
  await reproject(ctx, id, ['name', 'domain']);
  await assertDomainTaken(ctx, id, domain);
  const oldName = matchName(acc.name);
  if (oldName !== matchName(input.name)) {
    await ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId: id, kind: 'name', value: oldName }).onConflictDoNothing();
  }
  await ctx.tx
    .update(account)
    .set({ isShell: false, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  await applyExclusion(ctx, id);
  await publish(ctx, accountUpdated, { accountId: id, changedKeys: ['name', 'domain', 'is_shell'] }, subjectOf(id));
}
