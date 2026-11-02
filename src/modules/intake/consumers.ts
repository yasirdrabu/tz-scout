import { and, eq, sql } from 'drizzle-orm';
import { getConflict } from '@/modules/accounts';
import { accountMerged, conflictResolved } from '@/modules/accounts/contracts/events';
import { leadQualified } from '@/modules/crm/contracts/events';
import { assignmentDeclined, statusChanged } from '@/modules/routing/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedIntakeDefaults } from './defaults';
import { arrival, sourceFeedback, warmIntro } from './db/schema';
import { recordConflictLost, recordFeedback } from './services/feedback';
import { sourceNames } from './services/sources';
import { takeQualifiedLead } from './services/qualified-leads';

/** Gives a new tenant its vendor sources, relationship defaults and waiting-expiry schedule. */
export const intakeTenantDefaults = defineConsumer({
  name: 'intake.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedIntakeDefaults(ctx),
});

/** After a merge, arrivals, feedback, warm intros and duplicate candidates that named the merged account name the survivor. */
export const intakeAccountMerged = defineConsumer({
  name: 'intake.account_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async ({ data: { survivorId, mergedId } }, ctx) => {
    await ctx.tx.update(arrival).set({ accountId: survivorId }).where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, mergedId)));
    await ctx.tx.update(sourceFeedback).set({ accountId: survivorId }).where(and(eq(sourceFeedback.tenantId, ctx.tenantId), eq(sourceFeedback.accountId, mergedId)));
    await ctx.tx.update(warmIntro).set({ accountId: survivorId }).where(and(eq(warmIntro.tenantId, ctx.tenantId), eq(warmIntro.accountId, mergedId)));
    await ctx.tx.execute(sql`
      update intake.arrival set duplicate_candidates = (
        select jsonb_agg(case when c->>'accountId' = ${mergedId} then jsonb_set(c, '{accountId}', to_jsonb(${survivorId}::text)) else c end)
        from jsonb_array_elements(duplicate_candidates) c)
      where tenant_id = ${ctx.tenantId}
        and duplicate_candidates @> jsonb_build_array(jsonb_build_object('accountId', ${mergedId}::text))
    `);
  },
});

/** A decline at review or a send back becomes feedback for every source that sent the account (SRC-E1-S4-AC1). */
export const intakeStatusFeedback = defineConsumer({
  name: 'intake.status_feedback',
  event: statusChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async ({ id, data }, ctx) => {
    const kind = data.isDeclined ? 'declined_at_review' : data.returnsToSource ? 'sent_back' : null;
    if (kind) await recordFeedback(ctx, { accountId: data.accountId, kind, reasonKey: data.reasonKey, note: data.note, byUserId: data.by, causeEventId: id });
  },
});

/** A seller's decline becomes feedback too, with the reason and note (SRC-E1-S4-AC1). */
export const intakeSellerDeclineFeedback = defineConsumer({
  name: 'intake.seller_decline_feedback',
  event: assignmentDeclined,
  orderedBy: (e) => e.data.accountId,
  handle: async ({ id, data }, ctx) =>
    void (await recordFeedback(ctx, { accountId: data.accountId, kind: 'declined_by_seller', reasonKey: data.reasonKey, note: data.note, byUserId: data.sellerUserId, causeEventId: id })),
});

/** A contact the CRM's webhook says is qualified is read and submitted, the same as the poll does (Ruling 15). */
export const intakeLeadQualified = defineConsumer({
  name: 'intake.lead_qualified',
  event: leadQualified,
  orderedBy: (e) => e.data.contactId,
  handle: async (e, ctx) => takeQualifiedLead(ctx, e.data.connectionId, e.data.contactId),
});

/**
 * A person kept one source's value over others (Ruling 8): each losing source hears about it on the arrival its
 * fact came with, named after the winner (its vendor, else agent, else person). An edit names no loser.
 */
export const intakeConflictFeedback = defineConsumer({
  name: 'intake.conflict_feedback',
  event: conflictResolved,
  orderedBy: (e) => e.data.accountId,
  handle: async ({ id, data }, ctx) => {
    if (data.losingSourceIds.length === 0) return;
    const conflict = await getConflict(ctx, data.conflictId);
    if (!conflict) return;
    const facts = new Map(conflict.facts.map((f) => [f.id, f]));
    const winner = facts.get(data.keptFactId)?.sourceChain ?? {};
    const names = await sourceNames(ctx, [winner.vendorSourceId, winner.agentSourceId, winner.personSourceId].filter((x): x is string => !!x));
    const name = (sourceId?: string) => (sourceId ? names.get(sourceId) : undefined);
    const factArrivalIds = data.archivedFactIds.map((f) => facts.get(f)?.arrivalId).filter((x): x is string => !!x);
    await recordConflictLost(ctx, {
      accountId: conflict.accountId,
      factArrivalIds,
      losingSourceIds: data.losingSourceIds,
      winnerSourceName: name(winner.vendorSourceId) ?? name(winner.agentSourceId) ?? name(winner.personSourceId) ?? null,
      byUserId: data.resolvedBy,
      causeEventId: id,
    });
  },
});
