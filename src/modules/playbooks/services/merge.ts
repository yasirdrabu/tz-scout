import { and, asc, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { brief, briefSection, briefSectionHistory } from '../db/schema';
import { briefWhere, readBrief, requestDraft } from './brief';

const ofAccount = <T extends typeof briefSection | typeof briefSectionHistory>(t: T, ctx: ModuleContext, accountId: string) =>
  and(eq(t.tenantId, ctx.tenantId), eq(t.accountId, accountId));

/**
 * `accounts.account.merged`: the survivor keeps its brief, or takes the merged one's. The merged account's sections
 * and history move to the survivor's history (renumbered after the survivor's versions, so nothing is lost), its rows
 * are deleted, and a redraft is requested for the survivor.
 */
export async function briefOnMerge(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  for (const id of [survivorId, mergedId].sort()) await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plb:brief:${ctx.tenantId}:${id}`}))`);
  const merged = await readBrief(ctx, mergedId, { lock: true });
  const survivor = await readBrief(ctx, survivorId, { lock: true });
  if (merged) {
    if (!survivor) {
      await ctx.tx.update(brief).set({ accountId: survivorId }).where(briefWhere(ctx, mergedId));
    }
    const ours = new Map((await ctx.tx.select().from(briefSection).where(ofAccount(briefSection, ctx, survivorId))).map((s) => [s.key, s]));
    const theirs = await ctx.tx.select().from(briefSection).where(ofAccount(briefSection, ctx, mergedId));
    const theirHistory = await ctx.tx
      .select()
      .from(briefSectionHistory)
      .where(ofAccount(briefSectionHistory, ctx, mergedId))
      .orderBy(asc(briefSectionHistory.key), asc(briefSectionHistory.version));
    for (const s of theirs) {
      const own = ours.get(s.key);
      const history = theirHistory.filter((h) => h.key === s.key);
      if (!own) {
        // The survivor never had this section: take it whole.
        await ctx.tx.update(briefSectionHistory).set({ accountId: survivorId }).where(and(ofAccount(briefSectionHistory, ctx, mergedId), eq(briefSectionHistory.key, s.key)));
        await ctx.tx.update(briefSection).set({ accountId: survivorId }).where(and(ofAccount(briefSection, ctx, mergedId), eq(briefSection.key, s.key)));
        continue;
      }
      // Keep ours; their versions follow ours in history, and ours moves past them.
      let v = own.version;
      for (const h of [...history, { ...s, recordedAt: new Date() }]) {
        v++;
        await ctx.tx.insert(briefSectionHistory).values({ ...h, accountId: survivorId, version: v });
      }
      await ctx.tx.update(briefSection).set({ version: v + 1 }).where(and(ofAccount(briefSection, ctx, survivorId), eq(briefSection.key, s.key)));
    }
    await ctx.tx.delete(briefSectionHistory).where(ofAccount(briefSectionHistory, ctx, mergedId));
    await ctx.tx.delete(briefSection).where(ofAccount(briefSection, ctx, mergedId));
    if (survivor) await ctx.tx.delete(brief).where(briefWhere(ctx, mergedId));
  }
  if (merged || survivor) await requestDraft(ctx, survivorId);
}
