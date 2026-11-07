import { and, eq, gte, lte } from 'drizzle-orm';
import type { z } from 'zod';
import { filterVisibleAccountIds } from '@/modules/accounts';
import { listDoneSteps, type outcomeRecorded } from '@/modules/playbooks';
import type { ModuleContext } from '@/platform/context';
import { rollUp, type Counts, type WhatWorked } from '../domain/what-worked';
import { journey, stepCredit } from '../db/schema';

const DAY = 86_400_000;
/** What worked looks at the last 90 days (Ruling 9). */
export const WINDOW_DAYS = 90;

type OutcomeData = z.infer<typeof outcomeRecorded.data>;

/**
 * Writes the credit rows of one outcome: one per credited step, or one row with no step when nothing was recent
 * (Ruling 8). Practice and offer come from the account's journey now. A replay hits the unique index and adds nothing.
 */
export async function recordStepCredit(ctx: ModuleContext, o: Pick<OutcomeData, 'outcomeId' | 'accountId' | 'templateId' | 'kind' | 'occurredAt' | 'creditedSteps'>): Promise<void> {
  const [j] = await ctx.tx
    .select({ practiceId: journey.practiceId, offerId: journey.offerId })
    .from(journey)
    .where(and(eq(journey.tenantId, ctx.tenantId), eq(journey.accountId, o.accountId)));
  const base = {
    tenantId: ctx.tenantId,
    outcomeId: o.outcomeId,
    outcomeKind: o.kind,
    playbookTemplateId: o.templateId,
    practiceId: j?.practiceId ?? null,
    offerId: j?.offerId ?? null,
    accountId: o.accountId,
    occurredAt: new Date(o.occurredAt),
  };
  const steps = o.creditedSteps.length ? o.creditedSteps.map((s) => ({ stepId: s.stepId, stepType: s.channel })) : [{ stepId: null, stepType: null }];
  await ctx.tx
    .insert(stepCredit)
    .values(steps.map((s) => ({ ...base, ...s })))
    .onConflictDoNothing();
}

async function load(ctx: ModuleContext, filter: { templateId?: string }, now: Date) {
  const w = { from: new Date(now.getTime() - WINDOW_DAYS * DAY), to: now };
  const credits = await ctx.tx
    .select()
    .from(stepCredit)
    .where(
      and(
        eq(stepCredit.tenantId, ctx.tenantId),
        gte(stepCredit.occurredAt, w.from),
        lte(stepCredit.occurredAt, w.to),
        filter.templateId ? eq(stepCredit.playbookTemplateId, filter.templateId) : undefined,
      ),
    );
  const steps = (await listDoneSteps(ctx, w)).filter((s) => !filter.templateId || s.templateId === filter.templateId);
  const ok = new Set(await filterVisibleAccountIds(ctx, [...new Set([...credits.map((c) => c.accountId), ...steps.map((s) => s.accountId)])]));
  return { credits: credits.filter((c) => ok.has(c.accountId)), steps: steps.filter((s) => ok.has(s.accountId)) };
}

/** Steps done and the results credited to them in the last 90 days, on the accounts the caller can see (both sides). */
export async function whatWorked(ctx: ModuleContext, filter: { templateId?: string } = {}, opts: { now?: Date } = {}): Promise<WhatWorked> {
  const { credits, steps } = await load(ctx, filter, opts.now ?? new Date());
  return rollUp(credits, steps);
}

const wire = (c: Counts) => ({ reply: c.reply, meeting: c.meeting, opportunity: c.opportunity, won: c.won });

/** The route's response: snake_case, with `updated_at` the latest credit's `occurred_at` (null with none). */
export async function whatWorkedView(ctx: ModuleContext, filter: { templateId?: string } = {}, opts: { now?: Date } = {}) {
  const { credits, steps } = await load(ctx, filter, opts.now ?? new Date());
  const w = rollUp(credits, steps);
  const latest = credits.reduce<Date | null>((m, c) => (!m || c.occurredAt > m ? c.occurredAt : m), null);
  return {
    rows: w.rows.map((r) => ({ step_type: r.stepType, steps_done: r.stepsDone, counts: wire(r.counts), per_10: { ...r.per10 } })),
    no_recent_step: wire(w.noRecentStep),
    min_steps: w.minSteps,
    updated_at: latest ? latest.toISOString() : null,
  };
}

export type WhatWorkedView = Awaited<ReturnType<typeof whatWorkedView>>;
