import { and, eq, inArray } from 'drizzle-orm';
import { getSummaries, listAccountIds } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { brief } from '../db/schema';
import { requestDraft } from './brief';

const PAGE = 200;

/**
 * Seed backfill: requests a draft for every scored account with no brief, as the first `scoring.account.scored` would
 * have. The draft job uses rules or Claude by tier, as always. Safe to run again. Background context only. Returns how
 * many it requested.
 */
export async function backfillBriefs(ctx: ModuleContext): Promise<number> {
  let requested = 0;
  let afterId: string | undefined;
  do {
    const page = await listAccountIds(ctx, { limit: PAGE, ...(afterId ? { afterId } : {}) });
    const scored = (await getSummaries(ctx, page.ids)).filter((s) => s.tier !== null).map((s) => s.accountId);
    const have = new Set(
      scored.length
        ? (await ctx.tx.select({ id: brief.accountId }).from(brief).where(and(eq(brief.tenantId, ctx.tenantId), inArray(brief.accountId, scored)))).map((r) => r.id)
        : [],
    );
    for (const id of scored) {
      if (have.has(id)) continue;
      await requestDraft(ctx, id);
      requested++;
    }
    afterId = page.nextAfterId ?? undefined;
  } while (afterId);
  return requested;
}
