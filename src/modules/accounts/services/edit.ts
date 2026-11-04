import { and, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { accountExclusionChanged, accountUpdated, personUpdated } from '../contracts/events';
import type { ArrivalAccountFields, ArrivalPerson, SourceChain } from '../contracts/types';
import { account, accountAlias, person, personRole, signal } from '../db/schema';
import { matchName } from '../domain/names';
import { closeByEdit } from './conflicts';
import { applyExclusion } from './exclusion';
import { ACCOUNT_COLUMNS, PERSON_COLUMNS, keepReplacedDomain, recordFacts, reproject, reprojectPerson, type FactInput } from './facts';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { repickPrimary } from './primary';
import { writeSummary } from './summary';
import { filterVisibleAccountIds } from './visibility';

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
  if (!found || (await filterVisibleAccountIds(ctx, [found.id])).length === 0) throw notFound('account');
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
  const [before] = await ctx.tx.select({ domain: account.domain }).from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, id)));
  await recordFacts(ctx, id, null, facts, chain, undefined, userId);
  const keys = facts.map((f) => f.key);
  await reproject(ctx, id, keys);
  await closeByEdit(ctx, id, null, keys);
  const domain = facts.find((f) => f.key === 'domain')?.value;
  if (typeof domain === 'string') {
    await assertDomainTaken(ctx, id, domain);
    await keepReplacedDomain(ctx, id, before?.domain ?? null);
  }
  await applyExclusion(ctx, id);
  await publish(ctx, accountUpdated, { accountId: id, changedKeys: keys }, subjectOf(id));
}

export type PersonPatch = Pick<
  ArrivalPerson,
  'firstName' | 'lastName' | 'title' | 'seniority' | 'email' | 'emailStatus' | 'phone' | 'mobilePhone' | 'linkedinUrl' | 'decisionNote' | 'roleKeys'
> & { confirmRoleKeys?: string[] };

/**
 * Pins each given person field as a fact from the editor. `roleKeys` is the full set of roles the person should have;
 * roles added here are `set_by_person`. `confirmRoleKeys` turns roles the person holds after the patch (for example guessed ones)
 * into `set_by_person`. Re-picks the primary contact.
 */
export async function editPerson(ctx: ModuleContext, personId: string, patch: PersonPatch): Promise<void> {
  const { userId, chain } = editor(ctx);
  const [row] = await ctx.tx.select({ accountId: person.accountId })
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId), isNull(person.archivedAt)));
  if (!row || (await filterVisibleAccountIds(ctx, [row.accountId])).length === 0) throw notFound('person');
  const accountId = row.accountId;
  await lockAccount(ctx, accountId);

  const confirm = [...new Set(patch.confirmRoleKeys ?? [])];
  if (confirm.length) {
    const held = patch.roleKeys
      ? patch.roleKeys
      : (await ctx.tx.select({ roleKey: personRole.roleKey }).from(personRole).where(and(eq(personRole.tenantId, ctx.tenantId), eq(personRole.personId, personId)))).map((r) => r.roleKey);
    if (confirm.some((k) => !held.includes(k))) {
      const message = 'Only a role the person holds can be confirmed.';
      throw new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path: 'confirm_role_keys', message }] });
    }
  }

  const facts = factsFromPatch(patch, PERSON_KEY_BY_FIELD);
  const changedKeys = facts.map((f) => f.key);
  if (facts.length) {
    await recordFacts(ctx, accountId, personId, facts, chain, undefined, userId);
    await reprojectPerson(ctx, accountId, changedKeys);
    await closeByEdit(ctx, accountId, personId, changedKeys);
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
  }
  if (confirm.length) {
    const confirmed = await ctx.tx
      .update(personRole)
      .set({ origin: 'set_by_person', setBy: userId, setAt: new Date() })
      .where(
        and(
          eq(personRole.tenantId, ctx.tenantId),
          eq(personRole.personId, personId),
          inArray(personRole.roleKey, confirm),
          ne(personRole.origin, 'set_by_person'),
        ),
      )
      .returning({ roleKey: personRole.roleKey });
    if (confirmed.length > 0) rolesChanged = true;
  }
  if (rolesChanged) changedKeys.push('roles');

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

/** Pins a person as the one to approach first, or with `null` removes the pin so the pick is automatic again. */
export async function pinPrimary(ctx: ModuleContext, accountId: string, personId: string | null): Promise<void> {
  const { userId } = editor(ctx);
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
    .update(person)
    .set({ primaryPinnedAt: null, primaryPinnedBy: null })
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, id)));
  if (personId) {
    await ctx.tx
      .update(person)
      .set({ primaryPinnedAt: new Date(), primaryPinnedBy: userId })
      .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, personId)));
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
  if (!row || (await filterVisibleAccountIds(ctx, [row.accountId])).length === 0) throw notFound('signal');
  await lockAccount(ctx, row.accountId);
  if (row.archivedAt) return;
  await ctx.tx
    .update(signal)
    .set({ archivedAt: new Date() })
    .where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.id, signalId)));
  await audit(ctx, { action: 'accounts.signal.archive', subject: { type: 'signal', id: signalId }, after: { accountId: row.accountId, reason } });
  await writeSummary(ctx, row.accountId);
  await publish(ctx, accountUpdated, { accountId: row.accountId, changedKeys: ['signals'] }, subjectOf(row.accountId));
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
