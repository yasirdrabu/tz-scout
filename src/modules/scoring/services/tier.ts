import { and, eq, sql } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { members } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { accountScored } from '../contracts/events';
import { TIERS, type Tier } from '../contracts/types';
import { accountScore, scoreChange } from '../db/schema';

const MAX_NOTE = 4000;

export type TierView = {
  accountId: string;
  /** The tier the account holds: the one set by hand, else the scored one. */
  tier: string;
  scoredTier: string;
  /** Who set the tier by hand ("Changed by {name}"); null when it is Scout's. */
  tierSetBy: string | null;
  tierSetByName: string | null;
  tierSetAt: Date | null;
  tierNote: string | null;
};

const invalid = (title: string, path: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });

async function view(ctx: ModuleContext, row: typeof accountScore.$inferSelect): Promise<TierView> {
  const name = row.tierOverrideBy ? ((await members(ctx)).find((m) => m.userId === row.tierOverrideBy)?.name ?? null) : null;
  return {
    accountId: row.accountId,
    tier: row.tier,
    scoredTier: row.scoredTier,
    tierSetBy: row.tierOverrideBy,
    tierSetByName: name,
    tierSetAt: row.tierOverrideAt,
    tierNote: row.tierOverrideNote,
  };
}

/**
 * Sets the account's tier by hand, or with null gives it back to Scout (Decision 4). The manual tier
 * is honoured by every rescore until someone clears it; the priority number stays Scout's. Recorded
 * as a score change by the person with their note, published as `scoring.account.scored` so the
 * queue and summary follow, and audited. A hidden account is a 404; one never scored is a 409.
 */
export async function setTierOverride(ctx: ModuleContext, accountId: string, input: { tier: string | null; note?: string | null }): Promise<TierView> {
  const by = ctx.access?.userId;
  if (!by) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can change the tier.' });
  if (input.tier !== null && !(TIERS as readonly string[]).includes(input.tier)) throw invalid('Pick a tier from the list.', 'tier');
  const note = input.note?.trim() || null;
  if (note && note.length > MAX_NOTE) throw invalid('Keep the note to 4,000 characters.', 'note');
  const id = (await getAccount(ctx, accountId))?.id;
  if (!id) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  // The same lock scoring takes, so a rescore in flight can't write over the change.
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':scoring:' || ${id}))`);
  const where = and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id));
  const [prev] = await ctx.tx.select().from(accountScore).where(where);
  if (!prev) throw new ScoutError({ slug: 'conflict', status: 409, title: "Scout hasn't scored this account yet. Try again in a moment." });
  if (prev.tierOverride === input.tier && (input.tier === null || prev.tierOverrideNote === note)) return view(ctx, prev);

  const tier = (input.tier ?? prev.scoredTier) as Tier;
  const now = new Date();
  const [row] = await ctx.tx
    .update(accountScore)
    .set({
      tier,
      tierOverride: input.tier,
      tierOverrideBy: input.tier ? by : null,
      tierOverrideAt: input.tier ? now : null,
      tierOverrideNote: input.tier ? note : null,
      version: sql`${accountScore.version} + 1`,
    })
    .where(where)
    .returning();
  await ctx.tx.insert(scoreChange).values({
    id: newId('scc'),
    tenantId: ctx.tenantId,
    accountId: id,
    fromPriority: prev.priority,
    toPriority: row!.priority,
    fromTier: prev.tier,
    toTier: tier,
    fromOfferId: prev.bestOfferId,
    toOfferId: row!.bestOfferId,
    cause: 'tier_override',
    by,
    note,
  });
  await publish(
    ctx,
    accountScored,
    {
      accountId: id,
      priority: row!.priority,
      fit: row!.fit,
      intent: row!.intent,
      tier,
      previousTier: prev.tier as Tier,
      bestOfferId: row!.bestOfferId,
      previousBestOfferId: prev.bestOfferId,
      practiceId: row!.practiceId,
      revenueBand: null,
      cause: 'tier_override',
      profileVersion: row!.profileVersion,
      version: row!.version,
    },
    { type: 'account', id },
  );
  await audit(ctx, {
    action: 'scoring.tier.changed',
    subject: { type: 'account', id },
    before: { tier: prev.tier, tierOverride: prev.tierOverride },
    after: { tier, tierOverride: input.tier, note },
  });
  return view(ctx, row!);
}
