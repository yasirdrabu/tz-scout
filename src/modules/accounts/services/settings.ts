import { and, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob } from '@/platform/events/outbox';
import { exclusionList, exclusionRule } from '../db/schema';
import { exclusionsRecheckJob } from '../jobs';

export const EXCLUSION_LIST_KINDS = ['vendor_keyword', 'parent_domain', 'parent_name', 'do_not_contact_domain'] as const;

export type ExclusionRuleView = { key: string; label: string; kind: string; enabled: boolean };

/**
 * Settings changes need a person. The route (Task 20) enforces `settings:manage`; permissions are not
 * part of `Access`, so the service only checks that someone signed in is asking.
 */
function requirePerson(ctx: ModuleContext): void {
  if (!ctx.access?.userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can change settings here.' });
}

export async function listExclusionRules(ctx: ModuleContext): Promise<ExclusionRuleView[]> {
  const rows = await ctx.tx.select().from(exclusionRule).where(eq(exclusionRule.tenantId, ctx.tenantId)).orderBy(exclusionRule.key);
  return rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind, enabled: r.enabled }));
}

/** The values on each exclusion list, by kind. */
export async function listExclusionLists(ctx: ModuleContext): Promise<Record<string, string[]>> {
  const rows = await ctx.tx.select().from(exclusionList).where(eq(exclusionList.tenantId, ctx.tenantId)).orderBy(exclusionList.value);
  return Object.fromEntries(EXCLUSION_LIST_KINDS.map((kind) => [kind, rows.filter((r) => r.kind === kind).map((r) => r.value)]));
}

export async function setExclusionRule(ctx: ModuleContext, key: string, enabled: boolean): Promise<void> {
  requirePerson(ctx);
  const [rule] = await ctx.tx
    .update(exclusionRule)
    .set({ enabled })
    .where(and(eq(exclusionRule.tenantId, ctx.tenantId), eq(exclusionRule.key, key)))
    .returning({ key: exclusionRule.key });
  if (!rule) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That exclusion rule was not found.' });
  await audit(ctx, { action: 'accounts.exclusion_rule.set', subject: { type: 'exclusion_rule', id: key }, after: { enabled } });
  await enqueueJob(ctx, exclusionsRecheckJob, {});
}

/** Replaces the whole list of one kind (blank and repeated values are dropped, values are lower-cased). */
export async function setExclusionList(ctx: ModuleContext, kind: string, values: string[]): Promise<void> {
  requirePerson(ctx);
  if (!(EXCLUSION_LIST_KINDS as readonly string[]).includes(kind)) {
    throw new ScoutError({ slug: 'bad-request', status: 400, title: 'That is not an exclusion list.' });
  }
  const clean = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
  await ctx.tx.delete(exclusionList).where(and(eq(exclusionList.tenantId, ctx.tenantId), eq(exclusionList.kind, kind)));
  if (clean.length > 0) await ctx.tx.insert(exclusionList).values(clean.map((value) => ({ tenantId: ctx.tenantId, kind, value })));
  await audit(ctx, { action: 'accounts.exclusion_list.set', subject: { type: 'exclusion_list', id: kind }, after: { count: clean.length } });
  await enqueueJob(ctx, exclusionsRecheckJob, {});
}
