import { and, eq, gt } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { listApiKeys, members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { briefUpdated } from '../contracts/events';
import { PAGE_SECTIONS, SECTION_MAX } from '../contracts/types';
import { brief, briefSection, briefSectionHistory } from '../db/schema';
import { readBrief } from './brief';
import { leadOfferId, offerNames, sectionView, type SectionView } from './read';

export const EMPTY_SECTION = 'Write the section first, then save it.';
export const SECTION_TOO_LONG = 'Keep it under 4,000 characters.';
export const SECTION_CHANGED = 'Someone changed this section since you opened it. Reload to see their version.';
export const NO_SUCH_SECTION = "That brief section doesn't exist.";

const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path: 'body', message: title }] });

/** Who is editing: a member by user id, or an API key as `key:<id>` with the key's name (PLB-E3-S2-AC2). */
async function editor(ctx: ModuleContext): Promise<{ id: string; name: string }> {
  if (ctx.actor.kind === 'user') {
    const userId = ctx.access?.userId ?? ctx.actor.id;
    const m = (await members(ctx)).find((x) => x.userId === userId);
    return { id: userId, name: m?.name || m?.email || 'A teammate' };
  }
  if (ctx.actor.kind === 'agent') {
    const [key] = await listApiKeys(ctx, { id: ctx.actor.id });
    return { id: `key:${ctx.actor.id}`, name: key?.name ?? 'An API key' };
  }
  throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person or an API key can edit a brief.' });
}

/**
 * A person's or agent's text for one page section (PLB-E3-S2): the old version goes to history, the section becomes
 * `origin: 'human'` with the editor, and a draft never overwrites it unless asked. `ifVersion` guards against a
 * change made since the editor opened it. Creates the brief row when none exists.
 */
export async function editSection(ctx: ModuleContext, accountId: string, key: string, input: { body: string; ifVersion?: number | null }): Promise<SectionView> {
  if (!PAGE_SECTIONS.some((s) => s.key === key)) throw new ScoutError({ slug: 'not-found', status: 404, title: NO_SUCH_SECTION });
  const body = input.body.trim();
  if (!body) throw invalid(EMPTY_SECTION);
  if (body.length > SECTION_MAX) throw invalid(SECTION_TOO_LONG);
  const account = await getAccount(ctx, accountId);
  if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  const id = account.id;
  const who = await editor(ctx);
  const now = new Date();

  // No lock on the brief row: a draft in flight holds none either, and writes sections by version (Ruling 4).
  await ctx.tx.insert(brief).values({ tenantId: ctx.tenantId, accountId: id }).onConflictDoNothing();
  const row = await readBrief(ctx, id);
  const where = and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, id), eq(briefSection.key, key));
  const [current] = await ctx.tx.select().from(briefSection).where(where).for('update');
  if (input.ifVersion !== undefined && input.ifVersion !== null && input.ifVersion !== (current?.version ?? 0)) {
    // Only a person's change since the editor opened it is a conflict; a draft that wrote over it is not.
    const since = input.ifVersion;
    const humanSince =
      current?.origin === 'human' ||
      (
        await ctx.tx
          .select({ v: briefSectionHistory.version })
          .from(briefSectionHistory)
          .where(and(eq(briefSectionHistory.tenantId, ctx.tenantId), eq(briefSectionHistory.accountId, id), eq(briefSectionHistory.key, key), gt(briefSectionHistory.version, since), eq(briefSectionHistory.origin, 'human')))
          .limit(1)
      ).length > 0;
    if (humanSince || !current) throw new ScoutError({ slug: 'conflict', status: 409, title: SECTION_CHANGED });
  }

  const values = {
    body,
    citations: [],
    origin: 'human',
    mode: null,
    aiRunId: null,
    offerId: row?.offerId ?? current?.offerId ?? null,
    editedBy: who.id,
    editedByName: who.name,
    editedAt: now,
    updatedAt: now,
  };
  let saved;
  if (current) {
    await ctx.tx.insert(briefSectionHistory).values({ ...current, recordedAt: now });
    [saved] = await ctx.tx.update(briefSection).set({ ...values, version: current.version + 1 }).where(where).returning();
  } else {
    [saved] = await ctx.tx.insert(briefSection).values({ tenantId: ctx.tenantId, accountId: id, key, ...values, version: 1 }).returning();
  }
  await publish(ctx, briefUpdated, { accountId: id, sectionKeys: [key], origin: 'human', mode: null }, { type: 'account', id });
  const lead = (await leadOfferId(ctx, id)) ?? row?.offerId ?? null;
  return sectionView(saved!, lead, await offerNames(ctx, [saved!.offerId]));
}
